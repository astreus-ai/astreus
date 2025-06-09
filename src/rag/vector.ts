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

/**
 * Vector-based RAG implementation
 * Uses vector embeddings for semantic search and document chunking
 */
export class VectorRAG implements VectorRAGInstance {
  public config: VectorRAGConfig;
  private vectorDatabaseConnector: VectorDatabaseConnector;

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
      tableName: config.tableName || "rag_chunks",
      maxResults: config.maxResults || DEFAULT_MAX_RESULTS,
      chunkSize: config.chunkSize || DEFAULT_CHUNK_SIZE,
      chunkOverlap: config.chunkOverlap || DEFAULT_CHUNK_OVERLAP,
      vectorDatabase: config.vectorDatabase || { type: VectorDatabaseType.SAME_AS_MAIN },
    };
    
    // Ensure vectorDatabase config has the correct tableName
    if (this.config.vectorDatabase && this.config.vectorDatabase.type === VectorDatabaseType.SAME_AS_MAIN) {
      this.config.vectorDatabase.options = {
        ...this.config.vectorDatabase.options,
        tableName: this.config.tableName
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
      
      // If using external vector database, only create minimal tables in main DB
      if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
        // For external vector databases, we only need association tracking
        const associationsTableName = 'rag_chunk_associations';
        
        await database.ensureTable(associationsTableName, (table) => {
          table.string("chunkId").primary();
          table.string("documentId").notNullable().index();
          table.integer("chunkIndex").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
        });
        
        logger.info(`Vector RAG using external vector database - created ${associationsTableName} table`);
      } else {
        // Using same database for vectors - create all necessary tables
        const documentsTableName = 'rag_documents';
        const chunksTableName = this.config.tableName || 'rag_chunks';
        
        // Create documents table
        await database.ensureTable(documentsTableName, (table) => {
          table.string("id").primary();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
        });
        
        // Create chunks table with user's custom name
        await database.ensureTable(chunksTableName, (table) => {
          table.string("id").primary();
          table.string("documentId").notNullable().index();
          table.text("content").notNullable();
          table.json("metadata").notNullable();
          table.json("embedding").notNullable();
          table.timestamp("createdAt").defaultTo(database.knex.fn.now());
          
          // Add foreign key constraint
          table.foreign("documentId").references("id").inTable(documentsTableName).onDelete("CASCADE");
        });
        
        // Update config to use the resolved table name
        this.config.tableName = chunksTableName;
        
        logger.info(`Vector RAG initialized with custom tables: ${documentsTableName} and ${chunksTableName}`);
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
      
      // Only store document in main DB if using same database for vectors
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Store the document in main database
        await database.knex("rag_documents").insert({
          id: documentId,
          content: document.content,
          metadata: JSON.stringify(document.metadata),
          createdAt: new Date(),
        });
        logger.debug(`Stored document ${documentId} in main database`);
      } else {
        // For external vector DB, document metadata is stored with each chunk
        logger.debug(`Using external vector DB - document ${documentId} will be stored with chunks`);
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
            await database.knex(this.config.tableName!).insert({
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
      
      // If using external vector database, keep track of the association
      if (this.config.vectorDatabase?.type !== VectorDatabaseType.SAME_AS_MAIN) {
        // Store association between document and chunk
        await database.knex("rag_chunk_associations").insert({
          chunkId,
          documentId: chunk.documentId,
          chunkIndex,
          createdAt: new Date()
        });
        
        logger.debug(`Added chunk association for chunk ${chunkId} to document ${chunk.documentId}`);
      }
      
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
      
      // If using same database, get document from rag_documents table
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Get document from database
        const document = await database.knex("rag_documents")
          .where("id", id)
          .first();
        
        if (!document) {
          return null;
        }
        
        return {
          id: document.id,
          content: document.content,
          metadata: JSON.parse(document.metadata),
        };
      } else {
        // For external vector DB, reconstruct document from chunks
        const chunkAssociations = await database.knex("rag_chunk_associations")
          .where("documentId", id)
          .orderBy("chunkIndex", "asc")
          .select("chunkId");
        
        if (!chunkAssociations || chunkAssociations.length === 0) {
          return null;
        }
        
        // Get chunk data from vector database
        let content = "";
        let metadata = {};
        
        for (const association of chunkAssociations) {
          try {
            const chunkMetadata = await this.vectorDatabaseConnector.getVectorMetadata(association.chunkId);
            if (chunkMetadata && chunkMetadata.content) {
              content += chunkMetadata.content;
              // Use metadata from first chunk as document metadata
              if (Object.keys(metadata).length === 0 && chunkMetadata.metadata) {
                metadata = chunkMetadata.metadata;
              }
            }
          } catch (error) {
            logger.warn(`Error getting chunk ${association.chunkId} for document ${id}:`, error);
          }
        }
        
        if (!content) {
          return null;
        }
        
        return {
          id,
          content,
          metadata,
        };
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
        const chunks = await database.knex(tableName!)
          .where("documentId", id)
          .select("id");
        
        // Delete chunks
        if (chunks.length > 0) {
          const chunkIds = chunks.map((c: any) => c.id);
          await database.knex(tableName!)
            .whereIn("id", chunkIds)
            .delete();
          
          logger.debug(`Deleted ${chunkIds.length} chunks for document ${id}`);
        }
        
        // Delete document (foreign key constraint will handle cascade)
        await database.knex("rag_documents")
          .where("id", id)
          .delete();
        
        logger.debug(`Deleted document ${id} from main database`);
      } else {
        // Using external vector database
        const chunkAssociations = await database.knex("rag_chunk_associations")
          .where("documentId", id)
          .select("chunkId");
        
        if (chunkAssociations && chunkAssociations.length > 0) {
          const chunkIds = chunkAssociations.map((c: any) => c.chunkId);
          
          // Delete vectors from the vector database
          await this.vectorDatabaseConnector.deleteVectors(chunkIds);
          
          // Delete associations from the main database
          await database.knex("rag_chunk_associations")
            .where("documentId", id)
            .delete();
          
          logger.debug(`Deleted ${chunkIds.length} vectors from external vector database for document ${id}`);
        } else {
          logger.warn(`No chunks found for document ${id} in external vector database`);
        }
      }
      
      logger.debug(`Successfully deleted document ${id}`);
    } catch (error) {
      logger.error("Error deleting document:", error);
      throw error;
    }
  }

  /**
   * Search for similar documents using text query
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results
   */
  async search(query: string, limit?: number): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      const maxResults = limit || this.config.maxResults || 10;
      
      // Use semantic search if provider or memory with embedding support is available
      if (this.config.provider && this.config.provider.generateEmbedding) {
        try {
          logger.debug(`Generating embedding for search query using provider: "${query}"`);
          // Generate embedding for query using provider directly
          const queryEmbedding = await this.config.provider.generateEmbedding(query);
          
          if (queryEmbedding && queryEmbedding.length > 0) {
            logger.debug(`Generated embedding with ${queryEmbedding.length} dimensions`);
            // Use embedding for semantic search
            return this.searchByVector(queryEmbedding, maxResults);
          } else {
            logger.warn("Provider returned empty embedding, falling back to keyword search");
            return this.searchByKeyword(query, maxResults);
          }
        } catch (embeddingError) {
          logger.warn("Failed to generate embedding using provider, trying memory fallback:", embeddingError);
          
          // Fallback to memory if provider fails
          if (this.config.memory && this.config.memory.searchByEmbedding) {
            try {
              logger.debug(`Generating embedding for search query using memory fallback: "${query}"`);
              const { Embedding } = await import("../providers");
              const queryEmbedding = await Embedding.generateEmbedding(query);
              
              logger.debug(`Generated embedding with ${queryEmbedding.length} dimensions`);
              return this.searchByVector(queryEmbedding, maxResults);
            } catch (memoryError) {
              logger.warn("Failed to generate embedding using memory fallback, using keyword search:", memoryError);
              return this.searchByKeyword(query, maxResults);
            }
          } else {
            // Fall back to keyword search
            logger.debug("No memory fallback available, using keyword search");
            return this.searchByKeyword(query, maxResults);
          }
        }
      } else if (this.config.memory && this.config.memory.searchByEmbedding) {
        try {
          logger.debug(`Generating embedding for search query using memory: "${query}"`);
          // Generate embedding for query using Embedding utility directly
          const { Embedding } = await import("../providers");
          const queryEmbedding = await Embedding.generateEmbedding(query);
          
          logger.debug(`Generated embedding with ${queryEmbedding.length} dimensions`);
          
          // Use embedding for semantic search
          return this.searchByVector(queryEmbedding, maxResults);
        } catch (embeddingError) {
          logger.warn("Failed to generate embedding using memory, falling back to keyword search:", embeddingError);
          // Fall back to keyword search
          return this.searchByKeyword(query, maxResults);
        }
      } else {
        // Fall back to keyword search
        logger.debug("No provider or memory with embedding support, using keyword search");
        return this.searchByKeyword(query, maxResults);
      }
    } catch (error) {
      logger.error("Error searching in vector RAG:", error);
      throw error;
    }
  }

  /**
   * Search for documents using vector similarity
   * @param embedding The query embedding vector
   * @param limit Maximum number of results to return
   * @param threshold Minimum similarity threshold (0-1)
   * @returns Promise resolving to an array of search results
   */
  async searchByVector(
    embedding: number[],
    limit?: number,
    threshold: number = DEFAULT_VECTOR_SIMILARITY_THRESHOLD
  ): Promise<RAGResult[]> {
    try {
      const maxResults = limit || this.config.maxResults || 10;
      
      logger.debug(`Searching by vector with ${embedding.length} dimensions, limit: ${maxResults}`);
      
      // Use the vector database connector to search for similar vectors
      const similarVectors = await this.vectorDatabaseConnector.searchVectors(
        embedding, 
        maxResults, 
        threshold
      );
      
      logger.debug(`Found ${similarVectors.length} similar vectors`);
      
      // If using the same database, we need to fetch the detailed data
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const { database, tableName } = this.config;
        
        logger.debug(`Fetching chunk details from table: ${tableName}`);
        
        // Get detailed information for each chunk
        const chunkDetails = await database.knex(tableName!)
          .whereIn(
            "id",
            similarVectors.map((result) => result.id)
          )
          .select("*");
        
        logger.debug(`Retrieved ${chunkDetails.length} chunk details`);
        
        // Map to the expected result format
        return chunkDetails.map((chunk: any) => {
          const similarityResult = similarVectors.find((v) => v.id === chunk.id);
          try {
            const metadata = typeof chunk.metadata === 'string' ? JSON.parse(chunk.metadata) : chunk.metadata;
            return {
              content: chunk.content,
              metadata: metadata,
              similarity: similarityResult?.similarity || 0,
              sourceId: chunk.id,
            };
          } catch (parseError) {
            logger.warn(`Error parsing metadata for chunk ${chunk.id}, using empty object:`, parseError);
            return {
              content: chunk.content,
              metadata: {},
              similarity: similarityResult?.similarity || 0,
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
        // This assumes we've stored the content and metadata in the vector database
        const results: RAGResult[] = [];
        
        for (const vector of similarVectors) {
          try {
            // For external vector DB, content and metadata are stored in the vector's metadata
            // This is handled through the vector database connector
            const vectorMetadata = await this.vectorDatabaseConnector.getVectorMetadata(vector.id);
            
            if (!vectorMetadata) {
              logger.warn(`Metadata for vector ${vector.id} not found, skipping result`);
              continue;
            }
            
            // The metadata from the vector database should include:
            // - content: The text content of the chunk
            // - metadata: The original metadata object of the chunk
            // - documentId: The ID of the parent document
            results.push({
              content: vectorMetadata.content,
              metadata: vectorMetadata.metadata,
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
   * @returns Promise resolving to an array of search results
   */
  private async searchByKeyword(
    query: string,
    limit?: number
  ): Promise<RAGResult[]> {
    const { database, tableName } = this.config;
    const maxResults = limit || this.config.maxResults || 10;
    
    // Simple LIKE query for keyword search
    const results = await database.knex(tableName!)
      .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
      .limit(maxResults)
      .select("*");
    
    return results.map((result: any) => {
      try {
        const metadata = typeof result.metadata === 'string' ? JSON.parse(result.metadata) : result.metadata;
        return {
          content: result.content,
          metadata: metadata,
          sourceId: result.id,
        };
      } catch (parseError) {
        logger.warn(`Error parsing metadata for chunk ${result.id}, using empty object:`, parseError);
        return {
          content: result.content,
          metadata: {},
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