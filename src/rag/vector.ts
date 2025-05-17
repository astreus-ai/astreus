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
      const { database, tableName } = this.config;
      
      // Check if documents table exists
      const hasDocumentsTable = await database.knex.schema.hasTable("rag_documents");
      
      if (!hasDocumentsTable) {
        await database.knex.schema.createTable(
          "rag_documents",
          (table) => {
            table.string("id").primary();
            table.text("content").notNullable();
            table.json("metadata").notNullable();
            table.timestamp("createdAt").defaultTo(database.knex.fn.now());
          }
        );
        logger.debug("Created rag_documents table for vector RAG");
      }
      
      // Check if chunk associations table exists (for external vector databases)
      const hasChunkAssociationsTable = await database.knex.schema.hasTable("rag_chunk_associations");
      
      if (!hasChunkAssociationsTable) {
        await database.knex.schema.createTable(
          "rag_chunk_associations",
          (table) => {
            table.string("chunkId").primary();
            table.string("documentId").notNullable().index();
            table.integer("chunkIndex").notNullable();
            table.timestamp("createdAt").defaultTo(database.knex.fn.now());
            
            // Add foreign key constraint
            table.foreign("documentId").references("id").inTable("rag_documents").onDelete("CASCADE");
          }
        );
        logger.debug("Created rag_chunk_associations table for external vector databases");
      }
      
      // Only create chunks table if using same database for vectors
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        // Check if chunks table exists
        const hasChunksTable = await database.knex.schema.hasTable(tableName!);
        
        if (!hasChunksTable) {
          await database.knex.schema.createTable(
            tableName!,
            (table) => {
              table.string("id").primary();
              table.string("documentId").notNullable().index();
              table.text("content").notNullable();
              table.json("metadata").notNullable();
              table.json("embedding").notNullable();
              table.timestamp("createdAt").defaultTo(database.knex.fn.now());
            }
          );
          logger.debug(`Created ${tableName} table for vector RAG`);
        }
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
      
      // Store the document
      await database.knex("rag_documents").insert({
        id: documentId,
        content: document.content,
        metadata: JSON.stringify(document.metadata),
        createdAt: new Date(),
      });
      
      // Create chunks from document content
      const chunks = this.chunkDocument(documentId, document);
      
      // Generate embeddings for chunks and store them
      if (this.config.memory && this.config.memory.searchByEmbedding) {
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
        logger.debug(`Added ${chunks.length} chunks with embeddings for document ${documentId}`);
      } else {
        logger.warn("No memory with embedding support provided, chunks stored without embeddings");
        // Store chunks without embeddings
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
    const { database, tableName, memory } = this.config;
    
    try {
      // Get embedding using memory provider
      let embedding: number[] = [];
      
      if (memory && memory.searchByEmbedding) {
        // Use the first part of the chunk to generate embedding
        // Limit to 8000 characters to avoid token limits
        const textForEmbedding = chunk.content.substring(0, 8000);
        
        // Add temporary entry to memory to get embedding
        const tempEntry = {
          agentId: "rag_system",
          sessionId: "embedding_generation",
          role: "user" as const,
          content: textForEmbedding,
          metadata: { source: "rag_chunk" },
        };
        
        // Use memory's implementation to get embedding
        const tempId = await memory.add(tempEntry);
        const tempMemory = await memory.getById(tempId);
        
        if (tempMemory && tempMemory.embedding) {
          embedding = tempMemory.embedding;
        } else {
          logger.warn("Failed to generate embedding for chunk");
        }
        
        // Clean up temporary memory entry
        await memory.delete(tempId);
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
      
      // Get all chunk IDs for this document
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
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
      } else {
        // For external vector databases, we need to query the main database 
        // to get chunk IDs associated with this document
        const documentsTable = await database.knex("rag_documents")
          .where("id", id)
          .first();
        
        if (documentsTable) {
          // Get chunks from the main database where we store the associations
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
            
            logger.debug(`Deleted ${chunkIds.length} vectors from vector database for document ${id}`);
          }
        }
      }
      
      // Delete document
      await database.knex("rag_documents")
        .where("id", id)
        .delete();
      
      logger.debug(`Deleted document ${id}`);
    } catch (error) {
      logger.error("Error deleting document:", error);
      throw error;
    }
  }

  /**
   * Search for relevant documents based on a query
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to an array of search results
   */
  async search(query: string, limit?: number): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      const maxResults = limit || this.config.maxResults || 10;
      
      // Use semantic search if memory with embedding support is available
      if (this.config.memory && this.config.memory.searchByEmbedding) {
        // Generate embedding for query
        const queryTempEntry = {
          agentId: "rag_system",
          sessionId: "query_embedding",
          role: "user" as const,
          content: query,
          metadata: { source: "query" },
        };
        
        // Get query embedding
        const queryTempId = await this.config.memory.add(queryTempEntry);
        const queryMemory = await this.config.memory.getById(queryTempId);
        
        // Clean up temporary entry
        await this.config.memory.delete(queryTempId);
        
        if (queryMemory && queryMemory.embedding) {
          // Use embedding for semantic search
          return this.searchByVector(queryMemory.embedding, maxResults);
        }
      }
      
      // Fall back to keyword search
      return this.searchByKeyword(query, maxResults);
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
      
      // Use the vector database connector to search for similar vectors
      const similarVectors = await this.vectorDatabaseConnector.searchVectors(
        embedding, 
        maxResults, 
        threshold
      );
      
      // If using the same database, we need to fetch the detailed data
      if (this.config.vectorDatabase?.type === VectorDatabaseType.SAME_AS_MAIN) {
        const { database, tableName } = this.config;
        
        // Get detailed information for each chunk
        const chunkDetails = await database.knex(tableName!)
          .whereIn(
            "id",
            similarVectors.map((result) => result.id)
          )
          .select("*");
        
        // Map to the expected result format
        return chunkDetails.map((chunk: any) => {
          const similarityResult = similarVectors.find((v) => v.id === chunk.id);
          return {
            content: chunk.content,
            metadata: JSON.parse(chunk.metadata),
            similarity: similarityResult?.similarity || 0,
            sourceId: chunk.id,
          };
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
    
    return results.map((result: any) => ({
      content: result.content,
      metadata: JSON.parse(result.metadata),
      sourceId: result.id,
    }));
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