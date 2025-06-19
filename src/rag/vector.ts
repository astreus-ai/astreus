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

  constructor(config: VectorRAGConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "VectorRAG constructor");
    validateRequiredParams(
      config,
      ["database"],
      "VectorRAG constructor"
    );
    
    // Apply defaults for optional config parameters
    this.config = {
      ...config,
      tableName: config.tableName || "rag",
      maxResults: config.maxResults || DEFAULT_MAX_RESULTS,
      chunkSize: config.chunkSize || DEFAULT_CHUNK_SIZE,
      chunkOverlap: config.chunkOverlap || DEFAULT_CHUNK_OVERLAP,
      vectorDatabase: config.vectorDatabase || { type: VectorDatabaseType.SAME_AS_MAIN },
    };
    
    // Set up table names based on the config tableName
    const baseTableName = this.config.tableName;
    this.documentsTableName = `${baseTableName}_documents`;
    this.chunksTableName = `${baseTableName}_chunks`;
    
    // Ensure vectorDatabase config has the correct tableName for all database types
    if (this.config.vectorDatabase) {
      this.config.vectorDatabase.options = {
        ...this.config.vectorDatabase.options,
        tableName: this.chunksTableName
      };
    }
    
    // Initialize vector database connector
    this.vectorDatabaseConnector = createVectorDatabaseConnector(
      this.config.vectorDatabase,
      this.config.database
    );
    
    logger.debug("Vector RAG system initialized");
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
      logger.error("Error creating vector RAG instance:", error);
      throw error;
    }
  }

  /**
   * Initialize database tables for vector RAG
   */
  private async initializeDatabase(): Promise<void> {
    try {
      const { database } = this.config;
      
      // If using external vector database, do NOT create any tables in main DB
      if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
        // External vector database handles everything - no main DB tables needed
        logger.info(`Vector RAG using external vector database - no main DB tables created`);
      } else {
        // Using same database for vectors - create all necessary tables
        
        // Create documents table
        await database.ensureTable(this.documentsTableName, (table) => {
          table.string("id").primary();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
        });
        
        // Create chunks table with user's custom name
        await database.ensureTable(this.chunksTableName, (table) => {
          table.string("id").primary();
          table.string("documentId").notNullable().index();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.json("embedding").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
          
          // Add foreign key constraint
          table.foreign("documentId").references("id").inTable(this.documentsTableName).onDelete("CASCADE");
        });
        
        logger.info(`Vector RAG initialized with custom tables: ${this.documentsTableName} and ${this.chunksTableName}`);
      }
      
      logger.debug("Vector RAG database initialized");
    } catch (error) {
      logger.error("Error initializing vector RAG database:", error);
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
    // Validate required parameters
    validateRequiredParam(document, "document", "addDocument");
    validateRequiredParams(
      document,
      ["content", "metadata"],
      "addDocument"
    );
    
    try {
      const { database } = this.config;
      const documentId = uuidv4();
      
      // Only store document metadata in main DB if using same database for vectors
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        await database.knex(this.documentsTableName).insert({
          id: documentId,
          name: document.metadata?.name || document.metadata?.documentId || `Document ${documentId}`,
          content: document.content,
          metadata: JSON.stringify(document.metadata),
          createdAt: new Date(),
        });
        logger.debug(`Stored document ${documentId} metadata in main database`);
      } else {
        // External vector database - store document metadata in vector database
        const documentName = document.metadata?.name || document.metadata?.documentId || `Document ${documentId}`;
        
        // Check if vector database connector has addDocument method
        if (this.vectorDatabaseConnector && 'addDocument' in this.vectorDatabaseConnector) {
          await (this.vectorDatabaseConnector as any).addDocument({
            id: documentId,
            name: documentName,
            content: document.content,
            metadata: document.metadata
          });
          logger.debug(`Stored document ${documentId} metadata in external vector database`);
        } else {
          logger.warn(`Vector database connector does not support document storage - document ${documentId} metadata will only be stored with chunks`);
        }
      }
      
      // Create chunks from document content
      const chunks = this.chunkDocument(documentId, document);
      
      // Generate embeddings for chunks and store them
      // Prefer provider over memory for embedding generation
      if (this.config.provider && this.config.provider.generateEmbedding) {
        // Process chunks in batches to avoid overloading
        const batchSize = 10;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (chunk) => {
              await this.storeChunkWithEmbedding(chunk);
            })
          );
        }
        logger.debug(`Added ${chunks.length} chunks with provider-based embeddings for document ${documentId}`);
      } else if (this.config.memory && this.config.memory.searchByEmbedding) {
        // Fallback to memory if provider is not available
        const batchSize = 10;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (chunk) => {
              await this.storeChunkWithEmbedding(chunk);
            })
          );
        }
        logger.debug(`Added ${chunks.length} chunks with memory-based embeddings for document ${documentId}`);
      } else {
        logger.warn("No provider or memory with embedding support provided, chunks stored without embeddings");
        // Store chunks without embeddings only if using same database
        if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
          for (const chunk of chunks) {
            const chunkId = uuidv4();
            await database.knex(this.chunksTableName).insert({
              id: chunkId,
              documentId: chunk.documentId,
              content: chunk.content,
              metadata: JSON.stringify(chunk.metadata),
              embedding: JSON.stringify([]), // Empty embedding
              createdAt: new Date(),
            });
          }
        } else {
          logger.warn("Cannot store chunks without embeddings in external vector database");
        }
      }
      
      return documentId;
    } catch (error) {
      logger.error("Error adding document to vector RAG:", error);
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
    
    // Simple chunking by characters with overlap
    for (let i = 0; i < text.length; i += (chunkSize! - chunkOverlap!)) {
      // Stop if we've reached the end of the text
      if (i >= text.length) break;
      
      // Extract chunk content with overlap
      const chunkContent = text.substring(i, i + chunkSize!);
      
      // Skip empty chunks
      if (!chunkContent.trim()) continue;
      
      // Create chunk with metadata
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
   * Store a chunk with its embedding
   * @param chunk The chunk to store
   * @returns Promise resolving to the chunk ID
   */
  private async storeChunkWithEmbedding(
    chunk: Omit<Chunk, "id" | "embedding">
  ): Promise<string> {
    const { database, tableName, provider, memory } = this.config;
    
    try {
      // Get embedding using provider or memory
      let embedding: number[] = [];
      
      // Prefer provider over memory for embedding generation
      if (provider && provider.generateEmbedding) {
        try {
          // Use the first part of the chunk to generate embedding
          // Limit to 8000 characters to avoid token limits
          const textForEmbedding = chunk.content.substring(0, 8000);
          
          // Use provider directly for embedding generation
          const embeddingResult = await provider.generateEmbedding(textForEmbedding);
          embedding = embeddingResult || [];
          
          logger.debug(`Generated embedding using provider (${embedding.length} dimensions)`);
        } catch (embeddingError) {
          logger.warn("Failed to generate embedding using provider, trying memory fallback:", embeddingError);
          
          // Fallback to memory if provider fails
          if (memory && memory.searchByEmbedding) {
            try {
              const textForEmbedding = chunk.content.substring(0, 8000);
              const { Embedding } = await import("../providers");
              embedding = await Embedding.generateEmbedding(textForEmbedding);
              logger.debug(`Generated embedding using memory fallback (${embedding.length} dimensions)`);
            } catch (memoryError) {
              logger.warn("Failed to generate embedding using memory fallback:", memoryError);
              embedding = [];
            }
          } else {
            embedding = [];
          }
        }
      } else if (memory && memory.searchByEmbedding) {
        try {
          // Use the first part of the chunk to generate embedding
          // Limit to 8000 characters to avoid token limits
          const textForEmbedding = chunk.content.substring(0, 8000);
          
          // Use the Embedding utility directly instead of memory to avoid complexity
          const { Embedding } = await import("../providers");
          embedding = await Embedding.generateEmbedding(textForEmbedding);
          
          logger.debug(`Generated embedding using memory (${embedding.length} dimensions)`);
        } catch (embeddingError) {
          logger.warn("Failed to generate embedding using memory:", embeddingError);
          embedding = [];
        }
      } else {
        logger.warn("No provider or memory with embedding support provided for chunk storage");
      }
      
      // Generate a unique ID for the chunk
      const chunkId = uuidv4();
      
      // Get chunk index from metadata
      const chunkIndex = chunk.metadata.chunk_index || 0;
      
      // Store chunk with embedding in the vector database
      await this.vectorDatabaseConnector.addVectors([
        {
          id: chunkId,
          vector: embedding,
          metadata: {
            ...chunk.metadata,
            documentId: chunk.documentId,
            content: chunk.content
          }
        }
      ]);
      
      // External vector DB already has all data in metadata, no need for separate associations
      logger.debug(`Chunk ${chunkId} stored with all data in vector metadata`);
      
      return chunkId;
    } catch (error) {
      logger.error("Error storing chunk with embedding:", error);
      throw error;
    }
  }

  /**
   * Get a document by its ID
   * @param id The document ID to retrieve
   * @returns Promise resolving to the document or null if not found
   */
  async getDocumentById(id: string): Promise<Document | null> {
    // Validate required parameters
    validateRequiredParam(id, "id", "getDocumentById");
    
    try {
      const { database } = this.config;
      
      // If using same database, get document from documents table
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Get document from database
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
        // For external vector DB, documents are stored in the vector database
        // We can't reconstruct full documents from chunks without associations table
        // This feature is not supported with external vector database
        logger.warn(`getDocumentById not supported with external vector database - document ${id}`);
        return null;
      }
    } catch (error) {
      logger.error("Error getting document by ID:", error);
      throw error;
    }
  }

  /**
   * Delete a document and its chunks
   * @param id The document ID to delete
   */
  async deleteDocument(id: string): Promise<void> {
    // Validate required parameters
    validateRequiredParam(id, "id", "deleteDocument");
    
    try {
      const { database, tableName } = this.config;
      
      // Handle deletion based on vector database type
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Using same database - delete chunks and document
        const chunks = await database.knex(this.chunksTableName)
          .where("documentId", id)
          .select("id");
        
        // Delete chunks
        if (chunks.length > 0) {
          const chunkIds = chunks.map((c: any) => c.id);
          await database.knex(this.chunksTableName)
            .whereIn("id", chunkIds)
            .delete();
          
          logger.debug(`Deleted ${chunkIds.length} chunks for document ${id}`);
        }
        
        // Delete document (foreign key constraint will handle cascade)
        await database.knex(this.documentsTableName)
          .where("id", id)
          .delete();
        
        logger.debug(`Deleted document ${id} from main database`);
      } else {
        // Using external vector database - deletion not supported without associations table
        logger.warn(`deleteDocument not fully supported with external vector database - document ${id}`);
        // We can't easily find all chunks for a document without associations table
        // This would require searching through all vectors to find ones with matching documentId
      }
      
      logger.debug(`Successfully deleted document ${id}`);
    } catch (error) {
      logger.error("Error deleting document:", error);
      throw error;
    }
  }

  /**
   * Search for documents using the query
   * @param query The search query
   * @param limit Maximum number of results to return
   * @param userLanguage Optional user language for translation
   * @returns Promise resolving to an array of search results
   */
  async search(
    query: string, 
    limit?: number, 
    userLanguage?: string,
    expandContext: boolean = true,
    expansionRange: number = 1
  ): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      const maxResults = limit || this.config.maxResults || 10;
      console.log(`🔧 DEBUG RAG: Search query: "${query}", limit: ${maxResults}, userLanguage: ${userLanguage || 'not specified'}, expandContext: ${expandContext}, expansionRange: ${expansionRange}`);
      
      // Detect document language and translate query if needed
      let searchQuery = query;
      if (userLanguage) {
        try {
          const documentLanguage = await this.detectDocumentLanguage();
          console.log(`🔧 DEBUG RAG: Document language: ${documentLanguage}, User language: ${userLanguage}`);
          
          // If user language is different from document language, translate the query
          if (documentLanguage && userLanguage.toLowerCase() !== documentLanguage.toLowerCase()) {
            console.log(`🔧 DEBUG RAG: Translating from ${userLanguage} to ${documentLanguage}...`);
            
            try {
              searchQuery = await this.translateQuery(query, userLanguage, documentLanguage);
              console.log(`🔧 DEBUG RAG: Translated query: "${query}" -> "${searchQuery}"`);
            } catch (translationError) {
              console.log(`🔧 DEBUG RAG: Translation failed, using original query`);
              searchQuery = query;
            }
          } else {
            console.log(`🔧 DEBUG RAG: No translation needed, languages match`);
          }
        } catch (detectionError) {
          console.log(`🔧 DEBUG RAG: Language detection failed, using original query`);
          searchQuery = query;
        }
      }
      
      // Use semantic search if provider with embedding support is available
      if (this.config.provider && this.config.provider.generateEmbedding) {
        try {
          console.log(`🔧 DEBUG RAG: Generating embedding for: "${searchQuery}"`);
          const queryEmbedding = await this.config.provider.generateEmbedding(searchQuery);
          
          if (queryEmbedding && queryEmbedding.length > 0) {
            console.log(`🔧 DEBUG RAG: Using vector search with ${queryEmbedding.length} dimensions`);
            
            // Use default similarity threshold for quality results
            const searchThreshold = DEFAULT_VECTOR_SIMILARITY_THRESHOLD;
            const results = await this.searchByVector(queryEmbedding, maxResults, searchThreshold, expandContext, expansionRange);
            console.log(`🔧 DEBUG RAG: Vector search returned ${results.length} results`);
            
            return results;
          } else {
            console.log(`🔧 DEBUG RAG: Empty embedding, falling back to keyword search`);
            return this.searchByKeyword(searchQuery, maxResults);
          }
        } catch (embeddingError) {
          console.log(`🔧 DEBUG RAG: Embedding generation failed, trying fallback`);
          
          // Try memory fallback if available
          if (this.config.memory && this.config.memory.searchByEmbedding) {
            try {
              const { Embedding } = await import("../providers");
              const queryEmbedding = await Embedding.generateEmbedding(searchQuery);
              
              const searchThreshold = DEFAULT_VECTOR_SIMILARITY_THRESHOLD;
              return this.searchByVector(queryEmbedding, maxResults, searchThreshold, expandContext, expansionRange);
            } catch (memoryError) {
              console.log(`🔧 DEBUG RAG: Memory fallback failed, using keyword search`);
              return this.searchByKeyword(searchQuery, maxResults);
            }
          } else {
            console.log(`🔧 DEBUG RAG: No fallback available, using keyword search`);
            return this.searchByKeyword(searchQuery, maxResults);
          }
        }
      } else if (this.config.memory && this.config.memory.searchByEmbedding) {
        try {
          console.log(`🔧 DEBUG RAG: Using memory for embedding generation`);
          const { Embedding } = await import("../providers");
          const queryEmbedding = await Embedding.generateEmbedding(searchQuery);
          
          const searchThreshold = DEFAULT_VECTOR_SIMILARITY_THRESHOLD;
          return this.searchByVector(queryEmbedding, maxResults, searchThreshold, expandContext, expansionRange);
        } catch (embeddingError) {
          console.log(`🔧 DEBUG RAG: Memory embedding failed, using keyword search`);
          return this.searchByKeyword(searchQuery, maxResults);
        }
      } else {
        console.log(`🔧 DEBUG RAG: No embedding support, using keyword search`);
        return this.searchByKeyword(searchQuery, maxResults);
      }
    } catch (error) {
      console.log(`🔧 DEBUG RAG: Search error:`, error);
      throw error;
    }
  }

  /**
   * Expand chunks by retrieving adjacent chunks (before and after) for better context
   * This is especially useful for regulation documents where context matters
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

    console.log(`🔧 DEBUG RAG: Expanding ${chunks.length} chunks with ${expansionRange} adjacent chunks each direction`);

    // For external vector database
    if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
      // For external vector DB, we would need additional metadata to find adjacent chunks
      // For now, return original chunks as external DBs might not have chunk ordering
      console.log(`🔧 DEBUG RAG: External vector DB - chunk expansion not implemented`);
      return chunks;
    }

    const { database } = this.config;
    const expandedChunks = new Map();
    
    // First, add all original chunks
    chunks.forEach(chunk => {
      expandedChunks.set(chunk.id, { ...chunk, isOriginal: true });
    });

    // For each original chunk, find adjacent chunks
    for (const chunk of chunks) {
      try {
        // Get adjacent chunks based on chunk_index within the same document
        const adjacentChunks = await database.knex(this.chunksTableName)
          .where('documentId', chunk.documentId)
          .where('metadata->chunk_index', '>=', (chunk.metadata?.chunk_index || 0) - expansionRange)
          .where('metadata->chunk_index', '<=', (chunk.metadata?.chunk_index || 0) + expansionRange)
          .whereNot('id', chunk.id) // Exclude the original chunk
          .select('*');

        console.log(`🔧 DEBUG RAG: Found ${adjacentChunks.length} adjacent chunks for chunk ${chunk.id} (index: ${chunk.metadata?.chunk_index})`);

        // Add adjacent chunks to the map
        for (const adjChunk of adjacentChunks) {
          if (!expandedChunks.has(adjChunk.id)) {
            expandedChunks.set(adjChunk.id, {
              ...adjChunk,
              isOriginal: false,
              isAdjacent: true,
              parentOriginalChunk: chunk.id,
              // Lower similarity for adjacent chunks
              similarity: (chunk.similarity || 0) * 0.7
            });
          }
        }
      } catch (error) {
        console.log(`🔧 DEBUG RAG: Error finding adjacent chunks for ${chunk.id}:`, error);
      }
    }

    const result = Array.from(expandedChunks.values());
    console.log(`🔧 DEBUG RAG: Expansion result: ${chunks.length} original -> ${result.length} total chunks`);
    
    return result;
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
      
      console.log(`🔧 DEBUG RAG: Searching by vector with ${embedding.length} dimensions, limit: ${maxResults}, threshold: ${threshold}`);
      logger.debug(`Searching by vector with ${embedding.length} dimensions, limit: ${maxResults}`);
      
      // Use the vector database connector to search for similar vectors
      console.log(`🔧 DEBUG RAG: About to call vectorDatabaseConnector.searchVectors...`);
      const similarVectors = await this.vectorDatabaseConnector.searchVectors(
        embedding, 
        maxResults, 
        threshold
      );
      
      console.log(`🔧 DEBUG RAG: Vector search returned ${similarVectors.length} similar vectors`);
      logger.debug(`Found ${similarVectors.length} similar vectors`);
      
      // If using the same database, we need to fetch the detailed data
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const { database } = this.config;
        
        logger.debug(`Fetching chunk details from table: ${this.chunksTableName}`);
        
        // Get detailed information for each chunk
        let chunkDetails = await database.knex(this.chunksTableName)
          .whereIn(
            "id",
            similarVectors.map((result) => result.id)
          )
          .select("*");
        
        logger.debug(`Retrieved ${chunkDetails.length} chunk details`);

        // Add similarity scores to chunk details
        chunkDetails = chunkDetails.map((chunk: any) => {
          const similarityResult = similarVectors.find((v) => v.id === chunk.id);
          return {
            ...chunk,
            similarity: similarityResult?.similarity || 0
          };
        });

        // Expand chunks with adjacent context if enabled
        if (expandContext && expansionRange > 0) {
          console.log(`🔧 DEBUG RAG: Expanding chunks with context (range: ${expansionRange})`);
          chunkDetails = await this.expandChunksWithContext(chunkDetails, expansionRange);
        }
        
        // Get parent document information for each chunk
        const documentIds = [...new Set(chunkDetails.map((chunk: any) => chunk.documentId))];
        const documents = await database.knex(this.documentsTableName)
          .whereIn("id", documentIds)
          .select("*");
        
        const documentsMap = documents.reduce((map: any, doc: any) => {
          map[doc.id] = doc;
          return map;
        }, {});
        
        // Map to the expected result format with enhanced metadata
        return chunkDetails.map((chunk: any) => {
          const parentDocument = documentsMap[chunk.documentId];
          
          try {
            const chunkMetadata = chunk.metadata;
            const documentMetadata = parentDocument 
              ? (typeof parentDocument.metadata === 'string' ? JSON.parse(parentDocument.metadata) : parentDocument.metadata)
              : {};
            
            return {
              content: chunk.content,
              metadata: {
                // Include original chunk metadata
                ...chunkMetadata,
                // Add chunk-specific information
                chunkId: chunk.id,
                documentId: chunk.documentId,
                chunkType: 'text_chunk',
                searchMethod: 'vector',
                similarity: chunk.similarity || 0,
                chunkLength: chunk.content.length,
                chunkCreatedAt: chunk.createdAt,
                // Context expansion metadata
                isOriginal: chunk.isOriginal !== false, // Default to true for backward compatibility
                isAdjacent: chunk.isAdjacent || false,
                parentOriginalChunk: chunk.parentOriginalChunk || null,
                // Include parent document metadata for context
                document: {
                  ...documentMetadata,
                  documentLength: parentDocument ? parentDocument.content.length : null,
                  documentCreatedAt: parentDocument ? parentDocument.createdAt : null
                }
              },
              similarity: chunk.similarity || 0,
              sourceId: chunk.id,
            };
          } catch (parseError) {
            logger.warn(`Error parsing metadata for chunk ${chunk.id}, using empty object:`, parseError);
            return {
              content: chunk.content,
              metadata: {
                chunkId: chunk.id,
                documentId: chunk.documentId,
                chunkType: 'text_chunk',
                searchMethod: 'vector',
                similarity: chunk.similarity || 0,
                error: 'metadata_parse_error',
                isOriginal: chunk.isOriginal !== false,
                isAdjacent: chunk.isAdjacent || false
              },
              similarity: chunk.similarity || 0,
              sourceId: chunk.id,
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
            const vectorMetadata = await this.vectorDatabaseConnector.getVectorMetadata(vector.id);
            
            if (!vectorMetadata) {
              logger.warn(`Metadata for vector ${vector.id} not found, skipping result`);
              continue;
            }
            
            // Get parent document metadata if available
            let parentDocumentMetadata = {};
            if (vectorMetadata.documentId) {
              // For external vector DB, we don't use associations table
              // Instead, use the metadata stored with the chunk
              parentDocumentMetadata = {
                documentId: vectorMetadata.documentId,
                source: 'external_vector_db',
                // Include any document metadata that was stored with the chunk
                ...(vectorMetadata.document || {})
              };
            }
            
            // The metadata from the vector database should include:
            // - content: The text content of the chunk
            // - metadata: The original metadata object of the chunk (already parsed)
            // - documentId: The ID of the parent document
            
            // Extract the parsed metadata (excluding content and documentId which are separate fields)
            const { content, documentId, metadata: originalMetadata, ...extraFields } = vectorMetadata;
            
            console.log(`🔧 DEBUG RAG: Vector ${vector.id} metadata breakdown:`);
            console.log(`🔧 DEBUG RAG: - originalMetadata:`, JSON.stringify(originalMetadata, null, 2));
            // console.log(`🔧 DEBUG RAG: - extraFields:`, JSON.stringify(extraFields, null, 2));
            
            const finalMetadata = {
              // Include original chunk metadata (already parsed by PostgreSQL connector)
              ...(originalMetadata || {}),
              // Include any extra fields from vector database
              ...extraFields,
              // Add chunk-specific information
              chunkId: vector.id,
              documentId: vectorMetadata.documentId,
              chunkType: 'text_chunk',
              searchMethod: 'vector_external',
              similarity: vector.similarity,
              chunkLength: vectorMetadata.content.length,
              // Context expansion metadata (for external DB, we mark as original since no expansion)
              isOriginal: true,
              isAdjacent: false,
              // Include available parent document metadata
              document: parentDocumentMetadata
            };
            
            results.push({
              content: vectorMetadata.content,
              metadata: finalMetadata,
              similarity: vector.similarity,
              sourceId: vector.id,
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
   * Search for documents using keyword matching
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to an array of search results with enhanced metadata
   */
  private async searchByKeyword(
    query: string,
    limit?: number
  ): Promise<RAGResult[]> {
    const { database } = this.config;
    const maxResults = limit || this.config.maxResults || 10;
    
    // Simple LIKE query for keyword search
    const chunkResults = await database.knex(this.chunksTableName)
      .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
      .limit(maxResults)
      .select("*");
    
    // Get parent document information for context
    const documentIds = [...new Set(chunkResults.map((chunk: any) => chunk.documentId))];
    const documents = await database.knex(this.documentsTableName)
      .whereIn("id", documentIds)
      .select("*");
    
    const documentsMap = documents.reduce((map: any, doc: any) => {
      map[doc.id] = doc;
      return map;
    }, {});
    
    return chunkResults.map((result: any) => {
      const parentDocument = documentsMap[result.documentId];
      
      try {
        const chunkMetadata = result.metadata;
        const documentMetadata = parentDocument 
          ? (typeof parentDocument.metadata === 'string' ? JSON.parse(parentDocument.metadata) : parentDocument.metadata)
          : {};
        
        return {
          content: result.content,
          metadata: {
            // Include original chunk metadata
            ...chunkMetadata,
            // Add chunk-specific information
            chunkId: result.id,
            documentId: result.documentId,
            chunkType: 'text_chunk',
            searchMethod: 'keyword',
            chunkLength: result.content.length,
            chunkCreatedAt: result.createdAt,
            // Include parent document metadata for context
            document: {
              ...documentMetadata,
              documentLength: parentDocument ? parentDocument.content.length : null,
              documentCreatedAt: parentDocument ? parentDocument.createdAt : null
            }
          },
          sourceId: result.id,
        };
      } catch (parseError) {
        logger.warn(`Error parsing metadata for chunk ${result.id}, using empty object:`, parseError);
        return {
          content: result.content,
          metadata: {
            chunkId: result.id,
            documentId: result.documentId,
            chunkType: 'text_chunk',
            searchMethod: 'keyword',
            error: 'metadata_parse_error'
          },
          sourceId: result.id,
        };
      }
    });
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param vecA First vector
   * @param vecB Second vector
   * @returns Similarity score between 0 and 1
   */
  private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error("Vector dimensions do not match");
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    return dotProduct / (normA * normB);
  }

  /**
   * Create RAG search tool for vector-based search
   * @returns Array with vector search tool
   */
  createRAGTools(): Plugin[] {
    return [{
      name: "rag_search",
      description: "Search through documents using vector similarity to find relevant information. For regulation documents, automatically includes adjacent chunks for better context.",
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
          description: "Whether to include adjacent chunks for better context (default: true, recommended for regulation documents)",
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
          
          console.log(`🔧 DEBUG RAG: Tool execution started with parameters:`, {
            query: query,
            limit: limit,
            userLanguage: userLanguage,
            expandContext: expandContext,
            expansionRange: expansionRange,
            hasUserLanguage: !!userLanguage,
            allParams: Object.keys(params)
          });
          
          if (!query) {
            throw new Error("Query parameter is required");
          }
          
          // Use vector-based search with language-aware search and context expansion
          console.log(`🔧 DEBUG RAG: Calling this.search with userLanguage: ${userLanguage}...`);
          const results = await this.search(query, limit, userLanguage, expandContext, expansionRange);
          
          console.log(`🔧 DEBUG RAG: Search completed with ${results.length} results`);
          
          // Filter results by minimum similarity threshold (0.7) to ensure quality
          const highQualityResults = results.filter(r => {
            const similarity = r.similarity || r.metadata?.similarity || 0;
            return similarity >= 0.7;
          });
          
          console.log(`🔧 DEBUG RAG: Filtered to ${highQualityResults.length} high-quality results (similarity >= 0.7)`);
          
          // If no high-quality results found, return "no results found" response
          if (highQualityResults.length === 0) {
            console.log(`🔧 DEBUG RAG: No results meet minimum similarity threshold (0.7), returning no results`);
            return {
              success: true,
              results: [],
              query: query,
              resultCount: 0,
              originalResultCount: 0,
              adjacentChunkCount: 0,
              contextExpanded: false,
              searchType: "vector_with_context",
              message: "No relevant documents found with sufficient similarity. The query may be too specific or the information may not be available in the knowledge base."
            };
          }
          
          // Separate original and adjacent chunks for better reporting
          const originalChunks = highQualityResults.filter(r => r.metadata?.isOriginal !== false);
          const adjacentChunks = highQualityResults.filter(r => r.metadata?.isAdjacent === true);
          
          return {
            success: true,
            results: highQualityResults,
            query: query,
            resultCount: highQualityResults.length,
            originalResultCount: originalChunks.length,
            adjacentChunkCount: adjacentChunks.length,
            contextExpanded: expandContext && expansionRange > 0,
            searchType: "vector_with_context"
          };
        } catch (error) {
          console.log(`🔧 DEBUG RAG: Tool execution error:`, error);
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
   * Detect the primary language of documents using metadata
   * @returns Promise resolving to the detected language code
   */
  private async detectDocumentLanguage(): Promise<string> {
    try {
      // Use the direct table name from config for external vector database
      const chunksTableName = this.config.vectorDatabase?.options?.tableName || this.chunksTableName;
      console.log(`🔧 DEBUG RAG: Using chunks table: ${chunksTableName} for language detection`);
      
      // Get the appropriate database instance
      let database: any;
      if (this.config.vectorDatabase?.type === VectorDatabaseType.POSTGRES && this.vectorDatabaseConnector.getDatabase) {
        // For external PostgreSQL vector database, use the vector database connection
        database = this.vectorDatabaseConnector.getDatabase();
        console.log(`🔧 DEBUG RAG: Using external vector database connection`);
      } else {
        // For same database or fallback, use main database
        database = this.config.database;
        console.log(`🔧 DEBUG RAG: Using main database connection`);
      }
      
      if (!database) {
        console.log(`🔧 DEBUG RAG: No database connection available, defaulting to English`);
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
              const detectedLanguage = metadata.language.toLowerCase();
              console.log(`🔧 DEBUG RAG: Found language in chunk metadata: ${detectedLanguage}`);
              return detectedLanguage;
            }
          } catch (parseError) {
            console.log(`🔧 DEBUG RAG: Error parsing metadata:`, parseError);
          }
        }
        
        // If no language found in metadata, default to English
        console.log(`🔧 DEBUG RAG: No language found in metadata, using default: en`);
        return 'en';
      } catch (error) {
        console.log(`🔧 DEBUG RAG: Error querying chunks table (${chunksTableName}):`, error);
        
        // Default to English if any error occurs
        return 'en';
      }
    } catch (error) {
      console.log(`🔧 DEBUG RAG: Error detecting document language:`, error);
      return 'en';
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
      console.log(`🔧 DEBUG RAG: No translation needed - source and target languages are the same: ${fromLang}`);
      return query;
    }
    
    // Normalize language codes
    const normalizeLanguageCode = (code: string): string => {
      code = code.toLowerCase().trim();
      
      // Map of common language names to ISO codes
      const languageMap: Record<string, string> = {
        'turkish': 'tr', 'türkçe': 'tr', 'türkce': 'tr', 'tr': 'tr',
        'english': 'en', 'en': 'en', 'eng': 'en',
        'german': 'de', 'deutsch': 'de', 'de': 'de',
        'french': 'fr', 'français': 'fr', 'francais': 'fr', 'fr': 'fr',
        'spanish': 'es', 'español': 'es', 'espanol': 'es', 'es': 'es'
      };
      
      return languageMap[code] || code;
    };
    
    const normalizedFromLang = normalizeLanguageCode(fromLang);
    const normalizedToLang = normalizeLanguageCode(toLang);
    
    console.log(`🔧 DEBUG RAG: Translating from ${normalizedFromLang} to ${normalizedToLang}: "${query}"`);
    
    try {
      // Simple prompt for direct translation
      const messages = [
        {
          role: "system" as const,
          content: `You are a professional translator. Translate the search query from ${normalizedFromLang} to ${normalizedToLang}. Return ONLY the translated text without any additional explanation, formatting, or quotes.`
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
      
      console.log(`🔧 DEBUG RAG: Translation result: "${cleanTranslation}"`);
      return cleanTranslation;
    } catch (error) {
      console.log(`🔧 DEBUG RAG: Translation failed, using original query:`, error);
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