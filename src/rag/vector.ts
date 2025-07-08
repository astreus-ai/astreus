import { v4 as uuidv4 } from "uuid";
import {
  VectorRAGConfig,
  VectorRAGInstance,
  Document,
  Chunk,
  RAGResult,
  VectorRAGFactory,
  VectorDatabaseType,
  VectorDatabaseConfig,
} from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { createVectorDatabaseConnector, VectorDatabaseConnector } from "./vector-db";
import { 
  DEFAULT_CHUNK_SIZE, 
  DEFAULT_CHUNK_OVERLAP, 
  DEFAULT_VECTOR_SIMILARITY_THRESHOLD,
  DEFAULT_MAX_RESULTS
} from "../constants";
import { Plugin } from "../types";

/**
 * Vector-based RAG implementation
 * Uses vector embeddings for semantic search and document chunking
 */
export class VectorRAG implements VectorRAGInstance {
  public config: VectorRAGConfig;
  private vectorDatabaseConnector: VectorDatabaseConnector;
  private documentsTableName: string;
  private chunksTableName: string;
  private embeddingCache: Map<string, { embedding: number[], timestamp: number }> = new Map();
  private readonly CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache TTL

  constructor(config: VectorRAGConfig) {
    validateRequiredParam(config, "config", "VectorRAG constructor");
    validateRequiredParam(config.vectorDatabase, "config.vectorDatabase", "VectorRAG constructor");
    
    logger.info("System", "VectorRAG", `Initializing vector RAG with collection: ${config.tableName || 'default'}`);
    
    this.config = {
      ...config,
      tableName: config.tableName || "rag",
      maxResults: config.maxResults || DEFAULT_MAX_RESULTS,
      chunkSize: config.chunkSize || DEFAULT_CHUNK_SIZE,
      chunkOverlap: config.chunkOverlap || DEFAULT_CHUNK_OVERLAP,
      vectorDatabase: config.vectorDatabase || { type: VectorDatabaseType.SAME_AS_MAIN },
    };
    
    const baseTableName = this.config.tableName;
    this.documentsTableName = `${baseTableName}_documents`;
    this.chunksTableName = `${baseTableName}_chunks`;
    
    // Ensure vectorDatabase config has the correct options
    if (this.config.vectorDatabase) {
      this.config.vectorDatabase.options = {
        ...this.config.vectorDatabase.options,
      };
    }
    
    // Initialize vector database connector
    this.vectorDatabaseConnector = createVectorDatabaseConnector(
      this.config.vectorDatabase,
      this.config.database
    );
    
    logger.debug("System", "VectorRAG", `Configuration: chunks=${this.config.chunkSize}, overlap=${this.config.chunkOverlap}, threshold=${DEFAULT_VECTOR_SIMILARITY_THRESHOLD}`);
    logger.success("System", "VectorRAG", "Vector RAG initialized successfully");
  }

  /**
   * Create a new vector RAG instance with proper configuration
   * @param config Configuration object for vector RAG
   * @returns Promise that resolves to the new vector RAG instance
   */
  static async create(config: VectorRAGConfig): Promise<VectorRAGInstance> {
    // Validate required parameters
    validateRequiredParam(config, "config", "VectorRAG.create");
    validateRequiredParams(
      config,
      ["database"],
      "VectorRAG.create"
    );
    
    try {
      const instance = new VectorRAG(config);
      await instance.initializeDatabase();
      return instance;
    } catch (error) {
      logger.error("System", "VectorRAG", `Error creating vector RAG instance: ${error}`);
      throw error;
    }
  }

  /**
   * Initialize database tables for vector RAG
   */
  private async initializeDatabase(): Promise<void> {
    try {
      const { database } = this.config;
      
      if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
        logger.info("System", "VectorRAG", "Vector RAG using external vector database - no main DB tables created");
      } else {
        await database.ensureTable(this.documentsTableName, (table) => {
          table.string("id").primary();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
        });
        
        await database.ensureTable(this.chunksTableName, (table) => {
          table.string("id").primary();
          table.string("documentId").notNullable().index();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.json("embedding").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
          
          table.foreign("documentId").references("id").inTable(this.documentsTableName).onDelete("CASCADE");
        });
        
        logger.info("System", "VectorRAG", `Vector RAG initialized with custom tables: ${this.documentsTableName} and ${this.chunksTableName}`);
      }
      
      logger.debug("Vector RAG database initialized");
    } catch (error) {
      logger.error("System", "VectorRAG", `Error initializing vector RAG database: ${error}`);
      throw error;
    }
  }

  /**
   * Add a document to the vector RAG system
   * The document will be chunked and each chunk will be stored with its embedding
   * @param document The document to add
   * @returns Promise resolving to the document ID
   */
  async addDocument(document: Omit<Document, "id" | "embedding">): Promise<string> {
    validateRequiredParam(document, "document", "addDocument");
    validateRequiredParams(
      document,
      ["content", "metadata"],
      "addDocument"
    );
    
    try {
      const { database } = this.config;
      const documentId = uuidv4();
      
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        await database.knex(this.documentsTableName).insert({
          id: documentId,
          name: document.metadata?.name || document.metadata?.documentId || `Document ${documentId}`,
          content: document.content,
          metadata: JSON.stringify(document.metadata),
          createdAt: new Date(),
        });
        logger.debug("System", "VectorRAG", `Stored document ${documentId} metadata in main database`);
      } else {
        const documentName = document.metadata?.name || document.metadata?.documentId || `Document ${documentId}`;
        
        if (this.vectorDatabaseConnector && 'addDocument' in this.vectorDatabaseConnector) {
          await (this.vectorDatabaseConnector as any).addDocument({
            id: documentId,
            name: documentName,
            content: document.content,
            metadata: document.metadata
          });
          logger.debug("System", "VectorRAG", `Stored document ${documentId} metadata in external vector database`);
        } else {
          logger.warn("System", "VectorRAG", `Vector database connector does not support document storage - document ${documentId} metadata will only be stored with chunks`);
        }
      }
      
      const chunks = this.chunkDocument(documentId, document);
      
      if (this.config.provider && this.config.provider.generateEmbedding || 
          this.config.memory && this.config.memory.searchByEmbedding) {
        // Process chunks in larger batches for better performance
        const batchSize = 20; // Increased batch size
        
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          
          // Generate embeddings in parallel first
          const embeddingPromises = batch.map(chunk => 
            this.generateEmbeddingWithCache(chunk.content)
          );
          
          const embeddings = await Promise.all(embeddingPromises);
          
          // Then store all chunks with their embeddings
          const storePromises = batch.map(async (chunk, index) => {
            const chunkId = uuidv4();
            const embedding = embeddings[index];
            
            await this.vectorDatabaseConnector.addVectors([{
              id: chunkId,
              vector: embedding,
              metadata: {
                ...chunk.metadata,
                documentId: chunk.documentId,
                content: chunk.content
              }
            }]);
            
            return chunkId;
          });
          
          await Promise.all(storePromises);
          
          logger.debug("System", "VectorRAG", `Processed batch of ${batch.length} chunks`);
        }
        
        logger.debug("System", "VectorRAG", `Added ${chunks.length} chunks with embeddings for document ${documentId}`);
      } else {
        logger.warn("System", "VectorRAG", "No provider or memory with embedding support provided, chunks stored without embeddings");
        if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
          for (const chunk of chunks) {
            const chunkId = uuidv4();
            await database.knex(this.chunksTableName).insert({
              id: chunkId,
              documentId: chunk.documentId,
              content: chunk.content,
              metadata: JSON.stringify(chunk.metadata),
              embedding: JSON.stringify([]),
              createdAt: new Date(),
            });
          }
        } else {
          logger.warn("System", "VectorRAG", "Cannot store chunks without embeddings in external vector database");
        }
      }
      
      return documentId;
    } catch (error) {
      logger.error("System", "VectorRAG", `Error adding document to vector RAG: ${error}`);
      throw error;
    }
  }

  /**
   * Split a document into chunks
   * @param documentId The ID of the document
   * @param document The document to chunk
   * @returns Array of chunks
   */
  private chunkDocument(
    documentId: string,
    document: Omit<Document, "id" | "embedding">
  ): Omit<Chunk, "id" | "embedding">[] {
    const { chunkSize, chunkOverlap } = this.config;
    const text = document.content;
    const chunks: Omit<Chunk, "id" | "embedding">[] = [];
    
    for (let i = 0; i < text.length; i += (chunkSize! - chunkOverlap!)) {
      if (i >= text.length) break;
      
      const chunkContent = text.substring(i, i + chunkSize!);
      
      if (!chunkContent.trim()) continue;
      
      chunks.push({
        documentId,
        content: chunkContent,
        metadata: {
          ...document.metadata,
          chunk_index: chunks.length,
          start_char: i,
          end_char: Math.min(i + chunkSize!, text.length),
        },
      });
    }
    
    return chunks;
  }

  /**
   * Generate embedding with caching support
   * @param text The text to generate embedding for
   * @returns Promise resolving to the embedding vector
   */
  private async generateEmbeddingWithCache(text: string): Promise<number[]> {
    // Check cache first
    const cacheKey = text.substring(0, 100); // Use first 100 chars as key to avoid memory issues
    const cached = this.embeddingCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      logger.debug("System", "VectorRAG", "Using cached embedding");
      return cached.embedding;
    }
    
    // Clean expired cache entries periodically
    if (this.embeddingCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of this.embeddingCache.entries()) {
        if (now - value.timestamp > this.CACHE_TTL) {
          this.embeddingCache.delete(key);
        }
      }
    }
    
    let embedding: number[] = [];
    
    if (this.config.provider && this.config.provider.generateEmbedding) {
      try {
        const textForEmbedding = text.substring(0, 8000);
        embedding = await this.config.provider.generateEmbedding(textForEmbedding) || [];
        
        // Cache the result
        this.embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() });
        
        logger.debug("System", "VectorRAG", `Generated and cached embedding (${embedding.length} dimensions)`);
      } catch (error) {
        logger.warn("System", "VectorRAG", `Failed to generate embedding: ${error}`);
        
        // Try memory fallback if available
        if (this.config.memory && this.config.memory.searchByEmbedding) {
          try {
            const { Embedding } = await import("../providers");
            embedding = await Embedding.generateEmbedding(text.substring(0, 8000));
            
            // Cache the fallback result too
            this.embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() });
            
            logger.debug("System", "VectorRAG", `Generated embedding using memory fallback (${embedding.length} dimensions)`);
          } catch (memoryError) {
            logger.warn("System", "VectorRAG", `Failed to generate embedding using memory fallback: ${memoryError}`);
          }
        }
      }
    } else if (this.config.memory && this.config.memory.searchByEmbedding) {
      try {
        const { Embedding } = await import("../providers");
        embedding = await Embedding.generateEmbedding(text.substring(0, 8000));
        
        // Cache the result
        this.embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() });
        
        logger.debug("System", "VectorRAG", `Generated embedding using memory (${embedding.length} dimensions)`);
      } catch (error) {
        logger.warn("System", "VectorRAG", `Failed to generate embedding using memory: ${error}`);
      }
    }
    
    return embedding;
  }

  /**
   * Get a document by its ID
   * @param id The document ID to retrieve
   * @returns Promise resolving to the document or null if not found
   */
  async getDocumentById(id: string): Promise<Document | null> {
    validateRequiredParam(id, "id", "getDocumentById");
    
    try {
      const { database } = this.config;
      
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const document = await database.knex(this.documentsTableName)
          .where("id", id)
          .first();
        
        if (!document) {
          return null;
        }
        
        return {
          id: document.id,
          content: document.content,
          metadata: typeof document.metadata === 'string' ? JSON.parse(document.metadata) : document.metadata,
        };
      } else {
        logger.warn("System", "VectorRAG", `getDocumentById not supported with external vector database - document ${id}`);
        return null;
      }
    } catch (error) {
      logger.error("System", "VectorRAG", `Error getting document by ID: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a document and its chunks
   * @param id The document ID to delete
   */
  async deleteDocument(id: string): Promise<void> {
    validateRequiredParam(id, "id", "deleteDocument");
    
    try {
      const { database, tableName } = this.config;
      
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const chunks = await database.knex(this.chunksTableName)
          .where("documentId", id)
          .select("id");
        
        if (chunks.length > 0) {
          const chunkIds = chunks.map((c: any) => c.id);
          await this.vectorDatabaseConnector.deleteVectors(chunkIds);
          logger.debug("System", "VectorRAG", `Deleted ${chunkIds.length} chunks for document ${id}`);
        }
        
        await database.knex(this.documentsTableName)
          .where("id", id)
          .delete();
        
        logger.debug("System", "VectorRAG", `Deleted document ${id} from main database`);
      } else {
        logger.warn("System", "VectorRAG", `deleteDocument not fully supported with external vector database - document ${id}`);
      }
      
      logger.debug("System", "VectorRAG", `Successfully deleted document ${id}`);
    } catch (error) {
      logger.error("Error deleting document:", error);
      throw error;
    }
  }

  /**
   * Standard search method - wrapper around internal search
   * @param query Search query
   * @param limit Maximum number of results
   * @param userLanguage User's language for translation
   * @param expandContext Whether to include adjacent chunks
   * @param expansionRange Number of chunks to include before/after each result
   * @returns Search results
   */
  async search(
    query: string, 
    limit?: number, 
    userLanguage?: string,
    expandContext: boolean = true,
    expansionRange: number = 1
  ): Promise<RAGResult[]> {
    return this.searchInternal(query, limit, userLanguage, expandContext, expansionRange);
  }

  private async searchInternal(
    query: string, 
    limit?: number, 
    userLanguage?: string,
    expandContext: boolean = true,
    expansionRange: number = 1
  ): Promise<RAGResult[]> {
    validateRequiredParam(query, "query", "search");
    
    const maxResults = limit || this.config.maxResults || 10;
    
    let searchQuery = query;
    if (userLanguage) {
      const documentLanguage = await this.detectDocumentLanguage();
      
      if (documentLanguage && userLanguage.toLowerCase() !== documentLanguage.toLowerCase()) {
        searchQuery = await this.translateQuery(query, userLanguage, documentLanguage);
      }
    }

    const queryVariations = await this.generateQueryVariations(searchQuery, userLanguage || 'en');

    const allResults: RAGResult[] = [];
    const resultsPerVariation = Math.ceil(maxResults / queryVariations.length);
      
      // Process all query variations in parallel for better performance
      const searchPromises = queryVariations.map(async (variation, i) => {
        const queryType = i === 0 ? 'SHORT' : i === 1 ? 'MEDIUM' : 'LONG';
        
        try {
          const queryEmbedding = await this.generateEmbeddingWithCache(variation);
          
          if (queryEmbedding && queryEmbedding.length > 0) {
            const searchThreshold = 0.5;
            
            const results = await this.searchByVector(queryEmbedding, resultsPerVariation, searchThreshold, expandContext, expansionRange);
            
            return results.map(result => ({
              ...result,
              metadata: {
                ...result.metadata,
                queryType: queryType,
                queryVariation: variation,
                originalQuery: query
              }
            }));
          }
          return [];
        } catch (variationError) {
          logger.debug("System", "VectorRAG", `Error searching with variation ${queryType}: ${variationError}`);
          return [];
        }
      });
      
      // Wait for all searches to complete and flatten results
      const searchResults = await Promise.all(searchPromises);
      searchResults.forEach(results => allResults.push(...results));

      // Optimized deduplication using content-based key for better accuracy
      const uniqueResults = new Map<string, RAGResult>();
      
      for (const result of allResults) {
        // Create a composite key using documentId and chunk index for better deduplication
        const documentId = result.metadata?.documentId || result.sourceId;
        const chunkIndex = result.metadata?.chunk_index;
        const key = chunkIndex !== undefined ? `${documentId}_${chunkIndex}` : result.sourceId;
        
        // Use content hash for duplicate detection if chunk indices are not available
        if (!uniqueResults.has(key)) {
          uniqueResults.set(key, result);
        } else {
          // Keep the result with higher similarity
          const existing = uniqueResults.get(key)!;
          if ((result.similarity || 0) > (existing.similarity || 0)) {
            uniqueResults.set(key, result);
          }
        }
      }

      let finalResults = Array.from(uniqueResults.values())
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, maxResults);

      
      if (expandContext && expansionRange > 0 && finalResults.length > 0) {
        
        try {
          const expandedResults = await this.expandChunksWithContext(finalResults, expansionRange);
          
          const maxContextResults = Math.min(maxResults * 3, 15);
          finalResults = expandedResults
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .slice(0, maxContextResults);
            
        } catch (expansionError) {
        }
      }

      
      return finalResults;
  }

  /**
   * Expand chunks by retrieving adjacent chunks (before and after) for better context
   * This provides additional context around the found chunks for better understanding
   * @param chunks The original chunks found by search
   * @param expansionRange Number of chunks to include before and after each result (default: 1)
   * @returns Promise resolving to expanded chunks with adjacent context
   */
  private async expandChunksWithContext(
    chunks: any[],
    expansionRange: number = 1
  ): Promise<any[]> {
    if (chunks.length === 0 || expansionRange === 0) {
      return chunks;
    }


    if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
      return await this.expandExternalChunksWithContext(chunks, expansionRange);
    }

    const { database } = this.config;
    const expandedChunks = new Map();
    
    chunks.forEach(chunk => {
      expandedChunks.set(chunk.id, { ...chunk, isOriginal: true });
    });

    for (const chunk of chunks) {
      try {
        const adjacentChunks = await database.knex(this.chunksTableName)
          .where('documentId', chunk.documentId)
          .where('metadata->chunk_index', '>=', (chunk.metadata?.chunk_index || 0) - expansionRange)
          .where('metadata->chunk_index', '<=', (chunk.metadata?.chunk_index || 0) + expansionRange)
          .whereNot('id', chunk.id)
          .select('*');


        for (const adjChunk of adjacentChunks) {
          if (!expandedChunks.has(adjChunk.id)) {
            expandedChunks.set(adjChunk.id, {
              ...adjChunk,
              isOriginal: false,
              isAdjacent: true,
              parentOriginalChunk: chunk.id,
              similarity: (chunk.similarity || 0) * 0.7
            });
          }
        }
      } catch (error) {
      }
    }

    const result = Array.from(expandedChunks.values());
    
    return result;
  }

  /**
   * Expand chunks with context for external vector database
   * Uses metadata to find adjacent chunks by chunk_index and documentId
   */
  private async expandExternalChunksWithContext(
    chunks: any[],
    expansionRange: number = 1
  ): Promise<any[]> {
    if (chunks.length === 0 || expansionRange === 0) {
      return chunks;
    }


    const expandedChunks = new Map();
    
    chunks.forEach(chunk => {
      expandedChunks.set(chunk.id, { ...chunk, isOriginal: true });
    });

    for (const chunk of chunks) {
      try {
        const chunkIndex = chunk.metadata?.chunk_index;
        const documentId = chunk.metadata?.documentId || chunk.documentId;
        
        if (chunkIndex === undefined || !documentId) {
          continue;
        }


        const minIndex = Math.max(0, chunkIndex - expansionRange);
        const maxIndex = chunkIndex + expansionRange;

        const adjacentChunks = await this.findAdjacentChunksInVectorDB(
          documentId, 
          minIndex, 
          maxIndex, 
          chunk.id
        );


        for (const adjChunk of adjacentChunks) {
          if (!expandedChunks.has(adjChunk.id)) {
            expandedChunks.set(adjChunk.id, {
              ...adjChunk,
              isOriginal: false,
              isAdjacent: true,
              parentOriginalChunk: chunk.id,
              similarity: (chunk.similarity || 0) * 0.7
            });
          }
        }
      } catch (error) {
      }
    }

    const result = Array.from(expandedChunks.values());
    
    return result;
  }

  /**
   * Find adjacent chunks in external vector database by searching for chunks
   * with the same documentId and chunk_index within the specified range
   */
  private async findAdjacentChunksInVectorDB(
    documentId: string,
    minIndex: number,
    maxIndex: number,
    excludeChunkId: string
  ): Promise<any[]> {
    try {
      // If the connector supports metadata-based search, use that instead
      if ('searchByMetadata' in this.vectorDatabaseConnector) {
        const metadataFilter = {
          documentId: documentId,
          chunk_index: { $gte: minIndex, $lte: maxIndex }
        };
        
        const adjacentChunks = await (this.vectorDatabaseConnector as any).searchByMetadata(
          metadataFilter,
          maxIndex - minIndex + 1
        );
        
        return adjacentChunks
          .filter((chunk: any) => chunk.id !== excludeChunkId)
          .map((chunk: any) => ({
            ...chunk,
            metadata: chunk.metadata,
            content: chunk.metadata.content
          }));
      }
      
      // Fallback: Create a more targeted embedding search
      // Use the document's average embedding if available, or a specific pattern
      const searchLimit = Math.min(100, (maxIndex - minIndex + 1) * 5); // Limit based on expected chunks
      
      // Get metadata for all chunks in batch if possible
      if ('getVectorMetadataBatch' in this.vectorDatabaseConnector) {
        const dummyEmbedding = new Array(1536).fill(0);
        const candidates = await this.vectorDatabaseConnector.searchVectors(
          dummyEmbedding,
          searchLimit,
          0.0
        );
        
        const chunkIds = candidates.map(c => c.id);
        const metadataMap = await (this.vectorDatabaseConnector as any).getVectorMetadataBatch(chunkIds);
        
        const adjacentChunks = [];
        for (const chunk of candidates) {
          const metadata = metadataMap[chunk.id];
          if (!metadata) continue;
          
          const chunkDocumentId = metadata.documentId;
          const chunkIndex = metadata.chunk_index;
          
          if (
            chunk.id !== excludeChunkId &&
            chunkDocumentId === documentId &&
            chunkIndex !== undefined &&
            chunkIndex >= minIndex &&
            chunkIndex <= maxIndex
          ) {
            adjacentChunks.push({
              ...chunk,
              metadata,
              content: metadata.content
            });
          }
        }
        
        return adjacentChunks;
      }
      
      // Original fallback for basic connectors
      const dummyEmbedding = new Array(1536).fill(0);
      const allChunks = await this.vectorDatabaseConnector.searchVectors(
        dummyEmbedding,
        searchLimit,
        0.0
      );

      const adjacentChunks = [];
      for (const chunk of allChunks) {
        try {
          const metadata = await this.vectorDatabaseConnector.getVectorMetadata(chunk.id);
          if (!metadata) continue;
          
          const chunkDocumentId = metadata.documentId;
          const chunkIndex = metadata.chunk_index;
          
          if (
            chunk.id !== excludeChunkId &&
            chunkDocumentId === documentId &&
            chunkIndex !== undefined &&
            chunkIndex >= minIndex &&
            chunkIndex <= maxIndex
          ) {
            adjacentChunks.push({
              ...chunk,
              metadata,
              content: metadata.content
            });
          }
        } catch (error) {
          logger.debug("System", "VectorRAG", `Error getting metadata for chunk ${chunk.id}: ${error}`);
        }
      }

      return adjacentChunks;
    } catch (error) {
      logger.warn("System", "VectorRAG", `Error finding adjacent chunks: ${error}`);
      return [];
    }
  }

  /**
   * Search for documents using vector similarity
   * @param embedding The query embedding vector
   * @param limit Maximum number of results to return
   * @param threshold Minimum similarity threshold (0-1)
   * @param expandContext Whether to include adjacent chunks for better context (default: true)
   * @param expansionRange Number of chunks to include before and after each result (default: 1)
   * @returns Promise resolving to an array of search results with enhanced metadata
   */
  async searchByVector(
    embedding: number[],
    limit?: number,
    threshold: number = DEFAULT_VECTOR_SIMILARITY_THRESHOLD,
    expandContext: boolean = true,
    expansionRange: number = 1
  ): Promise<RAGResult[]> {
    try {
      const maxResults = limit || this.config.maxResults || 10;
      
      logger.debug("System", "VectorRAG", `Searching by vector with ${embedding.length} dimensions, limit: ${maxResults}`);
      
      const similarVectors = await this.vectorDatabaseConnector.searchVectors(
        embedding, 
        maxResults, 
        threshold
      );
      
      logger.debug("System", "VectorRAG", `Found ${similarVectors.length} similar vectors`);
      
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const { database } = this.config;
        
        logger.debug("System", "VectorRAG", `Fetching chunk details from table: ${this.chunksTableName}`);
        
        let chunkDetails = await database.knex(this.chunksTableName)
          .whereIn(
            "id",
            similarVectors.map((v) => v.id)
          )
          .select("*");
        
        logger.debug("System", "VectorRAG", `Retrieved ${chunkDetails.length} chunk details`);

        chunkDetails = chunkDetails.map((chunk: any) => {
          const similarityResult = similarVectors.find((v) => v.id === chunk.id);
          return {
            ...chunk,
            similarity: similarityResult?.similarity || 0
          };
        });

        if (expandContext && expansionRange > 0) {
          chunkDetails = await this.expandChunksWithContext(chunkDetails, expansionRange);
        }
        
        const documentIds = [...new Set(chunkDetails.map((chunk: any) => chunk.documentId))];
        const documents = await database.knex(this.documentsTableName)
          .whereIn("id", documentIds)
          .select("*");
        
        const documentsMap = documents.reduce((map: any, doc: any) => {
          map[doc.id] = doc;
          return map;
        }, {});
        
        return chunkDetails.map((chunk: any) => {
          const parentDocument = documentsMap[chunk.documentId];
          
          try {
            const chunkMetadata = typeof chunk.metadata === 'string' ? JSON.parse(chunk.metadata) : chunk.metadata;
            const documentMetadata = parentDocument 
              ? (typeof parentDocument.metadata === 'string' ? JSON.parse(parentDocument.metadata) : parentDocument.metadata)
              : {};
            
            return {
              content: chunk.content,
              metadata: {
                ...chunkMetadata,
                chunkId: chunk.id,
                documentId: chunk.documentId,
                similarity: chunk.similarity || 0,
                isOriginal: chunk.isOriginal !== false,
                isAdjacent: chunk.isAdjacent || false,
                parentOriginalChunk: chunk.parentOriginalChunk || null,
                document: {
                  ...documentMetadata,
                  documentLength: parentDocument ? parentDocument.content.length : null,
                  documentCreatedAt: parentDocument ? parentDocument.createdAt : null
                }
              },
              similarity: chunk.similarity || 0,
              sourceId: chunk.id
            };
          } catch (parseError) {
            logger.warn(`Error parsing metadata for chunk ${chunk.id}, using empty object:`, parseError);
            return {
              content: chunk.content,
              metadata: {
                chunkId: chunk.id,
                documentId: chunk.documentId,
                similarity: chunk.similarity || 0,
                error: 'metadata_parse_error',
                isOriginal: chunk.isOriginal !== false,
                isAdjacent: chunk.isAdjacent || false,
                parentOriginalChunk: chunk.parentOriginalChunk || null,
                document: {}
              },
              similarity: chunk.similarity || 0,
              sourceId: chunk.id
            };
          }
        });
      } else {
        // For external vector databases, we need to map the results 
        // from the vector IDs to the actual content
        const { database } = this.config;
        
        // If we have no results, return empty array
        if (similarVectors.length === 0) {
          return [];
        }
        
        // Get document IDs and content from chunk associations table
        const results: RAGResult[] = [];
        
        for (const vector of similarVectors) {
          try {
            // For external vector DB, content and metadata are stored in the vector's metadata
            const metadata = await this.vectorDatabaseConnector.getVectorMetadata(vector.id);
            
            if (!metadata) {
              logger.warn("System", "VectorRAG", `Metadata for vector ${vector.id} not found, skipping result`);
              continue;
            }
            
            // Get parent document metadata if available
            let parentDocumentMetadata = {};
            if (metadata.documentId) {
              // For external vector DB, we don't use associations table
              // Instead, use the metadata stored with the chunk
              parentDocumentMetadata = {
                documentId: metadata.documentId,
                source: 'external_vector_db',
                // Include any document metadata that was stored with the chunk
                ...(metadata.document || {})
              };
            }
            
            // The metadata from the vector database should include:
            // - content: The text content of the chunk
            // - metadata: The original metadata object of the chunk (already parsed)
            // - documentId: The ID of the parent document
            
            // Extract the parsed metadata (excluding content and documentId which are separate fields)
            const { content, documentId, metadata: originalMetadata, ...extraFields } = metadata;
            
            results.push({
              content: metadata.content || '',
              metadata: {
                ...originalMetadata,
                chunkId: vector.id,
                documentId: metadata.documentId,
                chunkType: 'text_chunk',
                searchMethod: 'vector_external',
                similarity: vector.similarity || 0,
                chunkLength: metadata.content ? metadata.content.length : 0,
                isOriginal: true,
                isAdjacent: false,
                parentOriginalChunk: null,
                document: parentDocumentMetadata,
                ...extraFields
              },
              similarity: vector.similarity || 0,
              sourceId: metadata.documentId || vector.id
            });
            
          } catch (error) {
            logger.warn(`Error processing vector result ${vector.id}, skipping:`, error);
            continue;
          }
        }
        
        return results;
      }
    } catch (error) {
      logger.error("Error searching by vector:", error);
      throw error;
    }
  }

  /**
   * Format metadata for LLM consumption using AI-powered organization
   * Uses LLM to intelligently organize and present metadata in a structured way
   */
  private async formatMetadataForLLM(metadata: any): Promise<string> {
    try {
      // Skip formatting if no provider available or metadata is empty
      if (!this.config.provider || !metadata || Object.keys(metadata).length === 0) {
        return '';
      }

      // Filter out technical/internal fields that aren't useful for LLM
      const filteredMetadata = { ...metadata };
      const excludeFields = ['embedding', 'vector', 'chunkId', 'documentId', 'searchMethod', 'isOriginal', 'isAdjacent', 'parentOriginalChunk'];
      excludeFields.forEach(field => delete filteredMetadata[field]);

      // If no meaningful metadata left, return empty
      if (Object.keys(filteredMetadata).length === 0) {
        return '';
      }

      const prompt = `You are a metadata organizer. Given the following document metadata, create a concise, well-structured summary that will help an AI assistant understand the document context.

Metadata:
${JSON.stringify(filteredMetadata, null, 2)}

Instructions:
1. Organize the metadata into logical groups (e.g., Document Info, Dates, References, etc.)
2. Use clear, human-readable labels
3. Include only the most important and relevant information
4. Format as a clean, readable summary (not JSON)
5. Use bullet points or short lines
6. If similarity/relevance score exists, include it as a percentage
7. Keep it concise but informative

Return only the formatted metadata summary, nothing else.`;

      // Get the default model from provider and use its complete method
      const defaultModelName = this.config.provider.getDefaultModel?.() || this.config.provider.listModels()[0];
      if (!defaultModelName) {
        throw new Error('No models available in provider');
      }
      
      const model = this.config.provider.getModel(defaultModelName);
      const response = await model.complete([{ role: 'user', content: prompt }], {
        temperature: 0.1, // Low temperature for consistent formatting
        maxTokens: 300 // Keep it concise
      });

      // Handle both string and structured response
      const formattedMetadata = typeof response === 'string' ? response.trim() : '';
      
      // Validate that we got a reasonable response
      if (formattedMetadata.length < 10 || formattedMetadata.toLowerCase().includes('i cannot') || formattedMetadata.toLowerCase().includes('i apologize')) {
        return this.formatMetadataSimple(filteredMetadata);
      }

      return formattedMetadata;
    } catch (error) {
      // Fallback to simple formatting
      return this.formatMetadataSimple(metadata);
    }
  }

  /**
   * Simple fallback metadata formatting when LLM formatting fails
   */
  private formatMetadataSimple(metadata: any): string {
    const sections: string[] = [];
    
    Object.entries(metadata).forEach(([key, value]) => {
      if (value && typeof value !== 'object') {
        // Convert camelCase to readable format
        const readableKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
        sections.push(`${readableKey}: ${value}`);
      }
    });
    
    return sections.length > 0 ? sections.join('\n') : '';
  }

  /**
   * Enhance results with grouped metadata to avoid duplication
   * Groups chunks by document/source and adds metadata only to the first chunk of each group
   */
  private async enhanceResultsWithGroupedMetadata(results: RAGResult[]): Promise<RAGResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Group results by document identifier (documentId, sourceId, or name)
    const documentGroups = new Map<string, RAGResult[]>();
    
    results.forEach(result => {
      // Create a unique document identifier
      const documentId = result.metadata?.documentId || 
                        result.metadata?.name || 
                        result.sourceId || 
                        'unknown';
      
      if (!documentGroups.has(documentId)) {
        documentGroups.set(documentId, []);
      }
      documentGroups.get(documentId)!.push(result);
    });


    // Process each document group
    const enhancedResults: RAGResult[] = [];
    
    for (const [documentId, groupResults] of documentGroups) {
      
      // Sort group results to ensure original chunks come first, then adjacent chunks
      const sortedGroupResults = groupResults.sort((a, b) => {
        // Original chunks first
        if (a.metadata?.isOriginal && !b.metadata?.isOriginal) return -1;
        if (!a.metadata?.isOriginal && b.metadata?.isOriginal) return 1;
        
        // Then by similarity (highest first)
        return (b.similarity || 0) - (a.similarity || 0);
      });

      // Generate metadata summary only once for the first chunk of each document group
      const firstChunk = sortedGroupResults[0];
      const metadataSummary = await this.formatMetadataForLLM(firstChunk.metadata);
      
      // Process all chunks in this document group
      for (let i = 0; i < sortedGroupResults.length; i++) {
        const result = sortedGroupResults[i];
        let enhancedContent = result.content;
        
        if (i === 0 && metadataSummary) {
          // Add metadata summary only to the first chunk of each document group
          enhancedContent = `${metadataSummary}\n\n---\n\n${result.content}`;
        } else if (i > 0) {
          // For subsequent chunks, add a context indicator
          const contextType = result.metadata?.isAdjacent ? 'Adjacent Context' : 'Additional Content';
          enhancedContent = `[${contextType} - Same Document]\n\n${result.content}`;
        }
        
        enhancedResults.push({
          ...result,
          content: enhancedContent
        });
      }
    }

    return enhancedResults;
  }

  /**
   * Create RAG search tool for vector-based search
   * @returns Array with vector search tool
   */
  createRAGTools(): Plugin[] {
    return [{
      name: "rag_search",
      description: "Enhanced search through documents using multiple query variations (short, medium, long) with vector similarity to find relevant information. Automatically includes adjacent chunks for better context and uses intelligent query expansion for comprehensive results.",
      parameters: [
        {
          name: "query",
          type: "string",
          description: "The search query to find relevant documents or content",
          required: true
        },
        {
          name: "limit",
          type: "number", 
          description: "Maximum number of initial results to return (default: 5). Final result count may be higher due to context expansion.",
          required: false,
          default: 5
        },
        {
          name: "userLanguage",
          type: "string",
          description: "The language of the user's query (e.g., 'tr', 'en', 'de')",
          required: false
        },
        {
          name: "expandContext",
          type: "boolean",
          description: "Whether to include adjacent chunks for better context (default: true, recommended for documents requiring context)",
          required: false,
          default: true
        },
        {
          name: "expansionRange",
          type: "number",
          description: "Number of chunks to include before and after each result (default: 1, range: 0-3)",
          required: false,
          default: 1
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const query = params.query as string;
          const limit = params.limit as number || 5;
          const userLanguage = params.userLanguage as string;
          const expandContext = params.expandContext !== undefined ? params.expandContext as boolean : true;
          const expansionRange = Math.min(Math.max(params.expansionRange as number || 1, 0), 3); // Clamp between 0-3
          
          if (!query) {
            throw new Error("Query parameter is required");
          }
          
          // Use vector-based search with language-aware search and context expansion
          const results = await this.search(query, limit, userLanguage, expandContext, expansionRange);
          
          
          // Use lower similarity threshold for enhanced search with query variations
          const minSimilarityThreshold = 0.5;
          
          // Filter results by minimum similarity threshold to ensure quality
          const highQualityResults = results.filter((r: RAGResult) => {
            const similarity = r.similarity || r.metadata?.similarity || 0;
            return similarity >= minSimilarityThreshold;
          });
          
          
          // If no high-quality results found, return "no results found" response
          if (highQualityResults.length === 0) {
            return {
              success: true,
              results: [],
              query: query,
              resultCount: 0,
              originalResultCount: 0,
              adjacentChunkCount: 0,
              contextExpanded: false,
              searchType: "vector_with_context",
              message: `No relevant documents found with sufficient similarity (threshold: ${minSimilarityThreshold}). The query may be too specific or the information may not be available in the knowledge base.`
            };
          }
          
          // Separate original and adjacent chunks for better reporting
          const originalChunks = highQualityResults.filter((r: RAGResult) => r.metadata?.isOriginal !== false);
          const adjacentChunks = highQualityResults.filter((r: RAGResult) => r.metadata?.isAdjacent === true);
          
          // Group results by document/source and enhance with metadata intelligently
          const enhancedResults = await this.enhanceResultsWithGroupedMetadata(highQualityResults);
          
          return {
            success: true,
            results: enhancedResults,
            query: query,
            resultCount: enhancedResults.length,
            originalResultCount: originalChunks.length,
            adjacentChunkCount: adjacentChunks.length,
            contextExpanded: expandContext && expansionRange > 0,
            searchType: "vector_with_context"
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred during vector search",
            query: params.query
          };
        }
      }
    }];
  }

  /**
   * Detect the primary language of documents using LLM-based intelligent detection
   * @returns Promise resolving to the detected language code
   */
  private async detectDocumentLanguage(): Promise<string> {
    try {
      // Use the direct table name from config for external vector database
      const chunksTableName = this.config.vectorDatabase?.options?.tableName || this.chunksTableName;
      
      // Get the appropriate database instance
      let database: any;
      if (this.config.vectorDatabase?.type === VectorDatabaseType.POSTGRES && this.vectorDatabaseConnector.getDatabase) {
        // For external PostgreSQL vector database, use the vector database connection
        database = this.vectorDatabaseConnector.getDatabase();
      } else {
        // For same database or fallback, use main database
        database = this.config.database;
      }
      
      if (!database) {
        return 'en';
      }
      
      try {
        // Try to query the chunks table directly with the correct name
        // Handle both Knex instance and DatabaseInstance
        const knexInstance = database.knex || database;
        const result = await knexInstance(chunksTableName)
          .select('metadata')
          .whereNotNull('metadata')
          .limit(1);
        
        if (result && result.length > 0 && result[0].metadata) {
          try {
            const metadata = typeof result[0].metadata === 'string' 
              ? JSON.parse(result[0].metadata) 
              : result[0].metadata;
            
            if (metadata && metadata.language) {
              // Use LLM to intelligently detect the document language from metadata
              const detectedLanguage = await this.detectLanguageWithLLM(metadata.language);
              return detectedLanguage;
            }
          } catch (parseError) {
          }
        }
        
        // If no language found in metadata, default to English
        return 'en';
      } catch (error) {
        
        // Default to English if any error occurs
        return 'en';
      }
    } catch (error) {
      return 'en';
    }
  }

  /**
   * Use LLM to intelligently detect language from any language representation
   * @param languageText Any text that represents a language in any form (EN, en, English, Ingilizce, etc.)
   * @returns Promise resolving to a standardized language code
   */
  private async detectLanguageWithLLM(languageText: string): Promise<string> {
    if (!this.config.provider) {
      return 'en';
    }
    
    try {
      
      const messages = [
        {
          role: "system" as const,
          content: `You are a language detection expert. You will receive any text that represents a language in any form or format. This could be:
- Language codes: "EN", "en", "TR", "tr", "DE", "de"
- Language names in English: "English", "Turkish", "German", "French"
- Language names in their own language: "English", "Turkish", "Deutsch", "Français"
- Any other way someone might write a language

Your job is to understand what language is being referred to and return ONLY the standard 2-letter ISO language code in lowercase.

Examples:
- "EN" → "en"
- "English" → "en" 
- "English" → "en"
- "TR" → "tr"
- "Turkish" → "tr"
- "Turkish" → "tr"
- "DE" → "de"
- "German" → "de"
- "Deutsch" → "de"
- "FR" → "fr"
- "French" → "fr"
- "Français" → "fr"

Return ONLY the 2-letter code, nothing else.`
        },
        {
          role: "user" as const,
          content: languageText
        }
      ];
      
      const defaultModel = this.config.provider.getDefaultModel?.() || 'gpt-4o-mini';
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.1,
        maxTokens: 10
      });
      
      // Extract the language code from the response
      const languageCode = typeof response === 'string' ? 
        response.trim().toLowerCase() : 
        response.content?.trim().toLowerCase() || 'en';
      
      // Validate that we got a reasonable 2-letter code
      const cleanLanguageCode = languageCode.replace(/[^a-z]/g, '').substring(0, 2);
      const finalLanguageCode = cleanLanguageCode.length === 2 ? cleanLanguageCode : 'en';
      
      return finalLanguageCode;
    } catch (error) {
      return 'en'; // Fall back to English if LLM detection fails
    }
  }


  /**
   * Generate multiple query variations using LLM for better search coverage
   * @param query The original query
   * @param language The language of the query
   * @returns Promise resolving to array of query variations [short, medium, long]
   */
  private async generateQueryVariations(query: string, language: string): Promise<string[]> {
    try {
      if (!this.config.provider) {
        return [query]; // Return original query if no LLM
      }

      const prompt = `Given this search query: "${query}"

Generate 3 different variations of this query to improve search results in a document database:

1. SHORT: A concise version using key terms only (2-4 words)
2. MEDIUM: A balanced version with important context (5-8 words)  
3. LONG: A detailed version with synonyms and related terms (10-15 words)

Focus on relevant terminology and concepts. Include relevant synonyms and related terms.

Response format (one per line):
SHORT: [short version]
MEDIUM: [medium version]
LONG: [long version]`;

      
      const messages = [
        {
          role: "user" as const,
          content: prompt
        }
      ];
      
      const defaultModel = this.config.provider.getDefaultModel?.() || 'gpt-4o-mini';
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.3, // Low temperature for consistent results
        maxTokens: 200
      });

      const responseText = typeof response === 'string' ? 
        response : 
        response.content || '';

      if (!responseText) {
        return [query];
      }

      // Parse the response
      const lines = responseText.split('\n').filter(line => line.trim());
      const variations: string[] = [];
      
      for (const line of lines) {
        if (line.includes('SHORT:')) {
          variations.push(line.replace('SHORT:', '').trim());
        } else if (line.includes('MEDIUM:')) {
          variations.push(line.replace('MEDIUM:', '').trim());
        } else if (line.includes('LONG:')) {
          variations.push(line.replace('LONG:', '').trim());
        }
      }

      // Ensure we have at least the original query
      if (variations.length === 0) {
        variations.push(query);
      }

      return variations;

    } catch (error) {
      return [query]; // Fallback to original query
    }
  }

  /**
   * Translate query from source language to target language using the AI provider
   * @param query Original query text
   * @param fromLang Source language code
   * @param toLang Target language code
   * @returns Promise resolving to translated query
   */
  private async translateQuery(query: string, fromLang: string, toLang: string): Promise<string> {
    if (!this.config.provider) {
      throw new Error('No provider available for translation');
    }
    
    // If languages are the same, no need to translate
    if (fromLang.toLowerCase() === toLang.toLowerCase()) {
      return query;
    }
    
    
    try {
      // Simple prompt for direct translation
      const messages = [
        {
          role: "system" as const,
          content: `You are a professional translator. Translate the search query from ${fromLang} to ${toLang}. Return ONLY the translated text without any additional explanation, formatting, or quotes.`
        },
        {
          role: "user" as const,
          content: query
        }
      ];
      
      const defaultModel = this.config.provider.getDefaultModel?.() || 'gpt-4o-mini';
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.1,
        maxTokens: 150
      });
      
      // Extract the translation from the response
      const translation = typeof response === 'string' ? 
        response.trim() : 
        response.content?.trim() || query;
      
      // Remove any quotes or extra formatting that might have been added
      const cleanTranslation = translation.replace(/^["']|["']$/g, '').trim();
      
      return cleanTranslation;
    } catch (error) {
      return query; // Fall back to original query rather than throwing
    }
  }
}

/**
 * Factory function to create a VectorRAG instance
 * @param config Configuration for the vector RAG
 * @returns Promise resolving to a configured VectorRAG instance
 */
export const createVectorRAG: VectorRAGFactory = async (
  config: VectorRAGConfig
) => {
  return VectorRAG.create(config);
}; 