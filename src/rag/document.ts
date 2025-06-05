import { v4 as uuidv4 } from "uuid";
import {
  DocumentRAGConfig,
  DocumentRAGInstance,
  Document,
  RAGResult,
  DocumentRAGFactory,
} from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";

/**
 * Document-based RAG implementation
 * Stores and retrieves complete documents with optional embeddings
 */
export class DocumentRAG implements DocumentRAGInstance {
  public config: DocumentRAGConfig;

  constructor(config: DocumentRAGConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "DocumentRAG constructor");
    validateRequiredParams(
      config,
      ["database"],
      "DocumentRAG constructor"
    );
    
    // Apply defaults for optional config parameters
    this.config = {
      ...config,
      tableName: config.tableName || "rag_documents",
      maxResults: config.maxResults || 10,
      storeEmbeddings: config.storeEmbeddings || false,
    };
    
    logger.debug("Document RAG system initialized");
  }

  /**
   * Create a new document RAG instance with proper configuration
   * @param config Configuration object for document RAG
   * @returns Promise that resolves to the new document RAG instance
   */
  static async create(config: DocumentRAGConfig): Promise<DocumentRAGInstance> {
    // Validate required parameters
    validateRequiredParam(config, "config", "DocumentRAG.create");
    validateRequiredParams(
      config,
      ["database"],
      "DocumentRAG.create"
    );
    
    try {
      const instance = new DocumentRAG(config);
      await instance.initializeDatabase();
      return instance;
    } catch (error) {
      logger.error("Error creating document RAG instance:", error);
      throw error;
    }
  }

  /**
   * Initialize database tables for document RAG
   */
  private async initializeDatabase(): Promise<void> {
    try {
      const { database, tableName, storeEmbeddings } = this.config;
      
      // Check if documents table exists
      const hasTable = await database.knex.schema.hasTable(tableName!);
      
      if (!hasTable) {
        await database.knex.schema.createTable(
          tableName!,
          (table) => {
            table.string("id").primary();
            table.text("content").notNullable();
            table.json("metadata").notNullable();
            // Add embedding column if enabled
            if (storeEmbeddings) {
              table.json("embedding");
            }
            table.timestamp("createdAt").defaultTo(database.knex.fn.now());
          }
        );
        logger.debug(`Created ${tableName} table for document RAG`);
      } else if (storeEmbeddings) {
        // Check if embedding column exists when embeddings are enabled
        const hasEmbeddingColumn = await database.knex.schema.hasColumn(
          tableName!,
          "embedding"
        );
        
        if (!hasEmbeddingColumn) {
          // Add embedding column if it doesn't exist
          await database.knex.schema.table(tableName!, (table) => {
            table.json("embedding");
          });
          logger.debug(`Added embedding column to ${tableName} table`);
        }
      }
      
      logger.debug("Document RAG database initialized");
    } catch (error) {
      logger.error("Error initializing document RAG database:", error);
      throw error;
    }
  }

  /**
   * Add a document to the RAG system
   * @param document The document to add
   * @returns Promise resolving to the document ID
   */
  async addDocument(document: Omit<Document, "id">): Promise<string> {
    // Validate required parameters
    validateRequiredParam(document, "document", "addDocument");
    validateRequiredParams(
      document,
      ["content", "metadata"],
      "addDocument"
    );
    
    try {
      const { database, tableName, storeEmbeddings, memory } = this.config;
      const id = uuidv4();
      
      const docToInsert: any = {
        id,
        content: document.content,
        metadata: JSON.stringify(document.metadata),
        createdAt: new Date(),
      };
      
      // Handle embedding if enabled and provided or can be generated
      if (storeEmbeddings) {
        let embedding = document.embedding;
        
        // Generate embedding if not provided
        if (!embedding) {
          try {
            // Use the Embedding utility directly
            const { Embedding } = await import("../providers");
            embedding = await Embedding.generateEmbedding(document.content.substring(0, 8000));
            
            logger.debug(`Generated embedding for document ${id} (${embedding.length} dimensions)`);
          } catch (embeddingError) {
            logger.warn("Error generating embedding for document:", embeddingError);
          }
        }
        
        // Store embedding if available
        if (embedding) {
          docToInsert.embedding = JSON.stringify(embedding);
        }
      }
      
      // Store document in database
      await database.knex(tableName!).insert(docToInsert);
      
      logger.debug(`Added document ${id} to RAG system`);
      return id;
    } catch (error) {
      logger.error("Error adding document to RAG system:", error);
      throw error;
    }
  }

  /**
   * Get a document by ID
   * @param id The document ID
   * @returns Promise resolving to the document or null if not found
   */
  async getDocumentById(id: string): Promise<Document | null> {
    // Validate required parameters
    validateRequiredParam(id, "id", "getDocumentById");
    
    try {
      const { database, tableName } = this.config;
      
      // Query document
      const document = await database.knex(tableName!)
        .where({ id })
        .first();
      
      if (!document) {
        return null;
      }
      
      // Process document data
      const result: Document = {
        id: document.id,
        content: document.content,
        metadata: JSON.parse(document.metadata),
      };
      
      // Add embedding if available
      if (document.embedding) {
        try {
          result.embedding = JSON.parse(document.embedding);
        } catch (error) {
          logger.warn(`Error parsing embedding for document ${id}:`, error);
        }
      }
      
      return result;
    } catch (error) {
      logger.error(`Error getting document ${id}:`, error);
      throw error;
    }
  }

  /**
   * Delete a document
   * @param id The document ID
   * @returns Promise resolving when the document is deleted
   */
  async deleteDocument(id: string): Promise<void> {
    // Validate required parameters
    validateRequiredParam(id, "id", "deleteDocument");
    
    try {
      const { database, tableName } = this.config;
      
      // Delete document
      await database.knex(tableName!)
        .where({ id })
        .delete();
      
      logger.debug(`Deleted document ${id}`);
    } catch (error) {
      logger.error(`Error deleting document ${id}:`, error);
      throw error;
    }
  }

  /**
   * Search for documents using text query
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results
   */
  async search(query: string, limit?: number): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      const { storeEmbeddings } = this.config;
      
      // Use vector search if embeddings are available
      if (storeEmbeddings) {
        try {
          // Generate embedding for query using Embedding utility directly
          const { Embedding } = await import("../providers");
          const queryEmbedding = await Embedding.generateEmbedding(query);
          
          // Search using the embedding
          return this.searchWithEmbedding(queryEmbedding, limit);
        } catch (embeddingError) {
          logger.warn("Error performing embedding search, falling back to keyword search:", embeddingError);
        }
      }
      
      // Fall back to keyword search
      return this.searchByKeyword(query, limit);
    } catch (error) {
      logger.error(`Error searching with query "${query}":`, error);
      throw error;
    }
  }

  /**
   * Search for documents based on metadata filters
   * @param filter Metadata filter criteria
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results
   */
  async searchByMetadata(
    filter: Record<string, any>,
    limit?: number
  ): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(filter, "filter", "searchByMetadata");
    
    try {
      const { database, tableName, maxResults } = this.config;
      
      // Get all documents
      const documents = await database.knex(tableName!)
        .select("*")
        .limit(limit || maxResults!);
      
      // Filter documents based on metadata criteria
      const results: RAGResult[] = [];
      
      for (const doc of documents) {
        try {
          const metadata = JSON.parse(doc.metadata);
          let matches = true;
          
          // Check if document metadata matches all filter criteria
          for (const [key, value] of Object.entries(filter)) {
            if (metadata[key] !== value) {
              matches = false;
              break;
            }
          }
          
          if (matches) {
            results.push({
              content: doc.content,
              metadata,
              sourceId: doc.id,
            });
          }
        } catch (error) {
          logger.warn(`Error processing document ${doc.id}, skipping:`, error);
          continue;
        }
      }
      
      return results;
    } catch (error) {
      logger.error("Error searching by metadata:", error);
      throw error;
    }
  }

  /**
   * Search for documents using keyword matching
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results
   */
  private async searchByKeyword(
    query: string,
    limit?: number
  ): Promise<RAGResult[]> {
    try {
      const { database, tableName, maxResults } = this.config;
      
      // Simple keyword search using database LIKE queries
      const documents = await database.knex(tableName!)
        .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
        .limit(limit || maxResults!);
      
      // Process results
      return documents.map(doc => ({
        content: doc.content,
        metadata: JSON.parse(doc.metadata),
        sourceId: doc.id,
      }));
    } catch (error) {
      logger.error(`Error searching by keyword "${query}":`, error);
      throw error;
    }
  }

  /**
   * Search for documents using embedding similarity
   * @param embedding The query embedding vector
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results with similarity scores
   */
  private async searchWithEmbedding(
    embedding: number[],
    limit?: number
  ): Promise<RAGResult[]> {
    try {
      const { database, tableName, maxResults } = this.config;
      
      // Get all documents with embeddings
      const documents = await database.knex(tableName!)
        .select("*")
        .whereNotNull("embedding");
      
      // Calculate similarity and filter results
      const results: RAGResult[] = [];
      
      for (const doc of documents) {
        try {
          // Parse embedding from JSON
          const docEmbedding = JSON.parse(doc.embedding);
          
          // Skip documents with invalid embeddings
          if (!Array.isArray(docEmbedding) || docEmbedding.length === 0) {
            continue;
          }
          
          // Calculate cosine similarity
          const similarity = this.calculateCosineSimilarity(embedding, docEmbedding);
          
          // Add to results
          results.push({
            content: doc.content,
            metadata: JSON.parse(doc.metadata),
            similarity,
            sourceId: doc.id,
          });
        } catch (error) {
          logger.warn(`Error processing document ${doc.id}, skipping:`, error);
          continue;
        }
      }
      
      // Sort by similarity (descending) and limit results
      return results
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, limit || maxResults);
    } catch (error) {
      logger.error("Error searching with embedding:", error);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param vecA First vector
   * @param vecB Second vector
   * @returns Similarity score (0-1)
   */
  private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    // Check for valid vectors
    if (!vecA.length || !vecB.length || vecA.length !== vecB.length) {
      return 0;
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    // Calculate dot product and norms
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    // Handle zero vectors
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    // Calculate similarity
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * Factory function to create a document RAG instance
 * @param config Document RAG configuration
 * @returns Promise resolving to a document RAG instance
 */
export const createDocumentRAG: DocumentRAGFactory = async (
  config: DocumentRAGConfig
) => {
  return DocumentRAG.create(config);
}; 