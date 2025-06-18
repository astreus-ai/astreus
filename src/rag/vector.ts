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
  private associationsTableName: string;

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
    this.associationsTableName = `${baseTableName}_chunk_associations`;
    
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
      
      // Only store associations if using same database for vectors
      // External vector DB already has all data in metadata, no need for separate associations
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Store association between document and chunk
        await database.knex(this.associationsTableName).insert({
          chunkId,
          documentId: chunk.documentId,
          chunkIndex,
          createdAt: new Date()
        });
        
        logger.debug(`Added chunk association for chunk ${chunkId} to document ${chunk.documentId}`);
      } else {
        logger.debug(`External vector DB - chunk ${chunkId} stored with all data in vector metadata`);
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
        // For external vector DB, reconstruct document from chunks
        const chunkAssociations = await database.knex(this.associationsTableName)
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
        // Using external vector database
        const chunkAssociations = await database.knex(this.associationsTableName)
          .where("documentId", id)
          .select("chunkId");
        
        if (chunkAssociations && chunkAssociations.length > 0) {
          const chunkIds = chunkAssociations.map((c: any) => c.chunkId);
          
          // Delete vectors from the vector database
          await this.vectorDatabaseConnector.deleteVectors(chunkIds);
          
          // Delete associations from the main database
          await database.knex(this.associationsTableName)
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
   * @returns Promise resolving to array of search results with chunk and document metadata
   */
  async search(query: string, limit?: number): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      const maxResults = limit || this.config.maxResults || 10;
      
      console.log(`🔧 DEBUG RAG: Starting search for query: "${query}" with limit: ${maxResults}`);
      console.log(`🔧 DEBUG RAG: Config provider exists:`, !!this.config.provider);
      console.log(`🔧 DEBUG RAG: Provider generateEmbedding exists:`, !!(this.config.provider && this.config.provider.generateEmbedding));
      
      // Use semantic search if provider or memory with embedding support is available
      if (this.config.provider && this.config.provider.generateEmbedding) {
        try {
          console.log(`🔧 DEBUG RAG: Generating embedding for search query using provider: "${query}"`);
          logger.debug(`Generating embedding for search query using provider: "${query}"`);
          // Generate embedding for query using provider directly
          const queryEmbedding = await this.config.provider.generateEmbedding(query);
          
          console.log(`🔧 DEBUG RAG: Generated embedding result:`, queryEmbedding ? `${queryEmbedding.length} dimensions` : 'null/empty');
          
          if (queryEmbedding && queryEmbedding.length > 0) {
            console.log(`🔧 DEBUG RAG: Using semantic search with ${queryEmbedding.length} dimensions`);
            logger.debug(`Generated embedding with ${queryEmbedding.length} dimensions`);
            // Use embedding for semantic search
            return this.searchByVector(queryEmbedding, maxResults);
          } else {
            console.log(`🔧 DEBUG RAG: Provider returned empty embedding, falling back to keyword search`);
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
   * @returns Promise resolving to an array of search results with enhanced metadata
   */
  async searchByVector(
    embedding: number[],
    limit?: number,
    threshold: number = DEFAULT_VECTOR_SIMILARITY_THRESHOLD
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
        const chunkDetails = await database.knex(this.chunksTableName)
          .whereIn(
            "id",
            similarVectors.map((result) => result.id)
          )
          .select("*");
        
        logger.debug(`Retrieved ${chunkDetails.length} chunk details`);
        
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
          const similarityResult = similarVectors.find((v) => v.id === chunk.id);
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
                similarity: similarityResult?.similarity || 0,
                chunkLength: chunk.content.length,
                chunkCreatedAt: chunk.createdAt,
                // Include parent document metadata for context
                document: {
                  ...documentMetadata,
                  documentLength: parentDocument ? parentDocument.content.length : null,
                  documentCreatedAt: parentDocument ? parentDocument.createdAt : null
                }
              },
              similarity: similarityResult?.similarity || 0,
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
                similarity: similarityResult?.similarity || 0,
                error: 'metadata_parse_error'
              },
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
              try {
                const associations = await database.knex(this.associationsTableName)
                  .where("chunkId", vector.id)
                  .first();
                
                if (associations) {
                  // In external vector DB setup, we would need to fetch document metadata
                  // from the original source or store it with each chunk
                  parentDocumentMetadata = {
                    documentId: vectorMetadata.documentId,
                    note: 'Parent document metadata not fully available in external vector DB setup'
                  };
                }
              } catch (docError) {
                logger.warn(`Error fetching parent document metadata for chunk ${vector.id}:`, docError);
              }
            }
            
            // The metadata from the vector database should include:
            // - content: The text content of the chunk
            // - metadata: The original metadata object of the chunk
            // - documentId: The ID of the parent document
            results.push({
              content: vectorMetadata.content,
              metadata: {
                // Include original chunk metadata
                ...vectorMetadata.metadata,
                // Add chunk-specific information
                chunkId: vector.id,
                documentId: vectorMetadata.documentId,
                chunkType: 'text_chunk',
                searchMethod: 'vector_external',
                similarity: vector.similarity,
                chunkLength: vectorMetadata.content.length,
                // Include available parent document metadata
                document: parentDocumentMetadata
              },
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
      description: "Search through documents using vector similarity to find relevant information",
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
          description: "Maximum number of results to return (default: 5)",
          required: false,
          default: 5
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const query = params.query as string;
          const limit = params.limit as number || 5;
          
          if (!query) {
            throw new Error("Query parameter is required");
          }
          
          // Use vector-based search
          const results = await this.search(query, limit);
          
          return {
            success: true,
            results: results,
            query: query,
            resultCount: results.length,
            searchType: "vector"
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