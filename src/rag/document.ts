import { v4 as uuidv4 } from "uuid";
import {
  Document,
  RAGResult,
  DocumentRAGConfig,
  DocumentRAGInstance,
  DocumentRAGFactory,
  DatabaseInstance,
} from "../types";
import { Plugin } from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { Embedding } from "../providers";
import {
  DEFAULT_MAX_RESULTS
} from "../constants";

/**
 * Document-based RAG implementation
 * Stores and retrieves complete documents with optional embeddings
 */
export class DocumentRAG implements DocumentRAGInstance {
  public config: DocumentRAGConfig;
  private documentsTableName: string;

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
      tableName: config.tableName || "rag",
      maxResults: config.maxResults || DEFAULT_MAX_RESULTS,
      storeEmbeddings: config.storeEmbeddings || false,
    };
    
    // Set up table name based on the config tableName
    this.documentsTableName = `${this.config.tableName}_documents`;
    
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
      const { database, storeEmbeddings } = this.config;
      
      // Use database's enhanced table management
      await database.ensureTable(this.documentsTableName, (table) => {
        table.string("id").primary();
        table.text("content").notNullable();
        table.json("metadata").notNullable();
        // Add embedding column if enabled
        if (storeEmbeddings) {
          table.json("embedding");
        }
        table.timestamp("createdAt").defaultTo(database.knex.fn.now());
      });
      
      // Check if embeddings are enabled and ensure embedding column exists
      if (storeEmbeddings) {
        const hasEmbeddingColumn = await database.knex.schema.hasColumn(
          this.documentsTableName,
          "embedding"
        );
        
        if (!hasEmbeddingColumn) {
          // Add embedding column if it doesn't exist
          await database.knex.schema.table(this.documentsTableName, (table) => {
            table.json("embedding");
          });
          logger.debug(`Added embedding column to ${this.documentsTableName} table`);
        }
      }
      
      logger.info(`Document RAG initialized with custom table: ${this.documentsTableName}`);
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
      const { database, storeEmbeddings } = this.config;
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
      await database.knex(this.documentsTableName).insert(docToInsert);
      
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
      const { database } = this.config;
      
      // Query document
      const document = await database.knex(this.documentsTableName)
        .where({ id })
        .first();
      
      if (!document) {
        return null;
      }
      
      // Process document data
      const result: Document = {
        id: document.id,
        content: document.content,
        metadata: typeof document.metadata === 'string' ? JSON.parse(document.metadata) : document.metadata,
      };
      
      // Add embedding if available
      if (document.embedding) {
        try {
          result.embedding = typeof document.embedding === 'string' ? JSON.parse(document.embedding) : document.embedding;
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
      const { database } = this.config;
      
      // Delete document
      await database.knex(this.documentsTableName)
        .where({ id })
        .delete();
      
      logger.debug(`Deleted document ${id}`);
    } catch (error) {
      logger.error(`Error deleting document ${id}:`, error);
      throw error;
    }
  }

  /**
   * Search for documents using text query with automatic language support
   * @param query The search query
   * @param limit Maximum number of results to return
   * @param userLanguage The language of the user's query (optional)
   * @returns Promise resolving to array of search results with document metadata
   */
  async search(query: string, limit?: number, userLanguage?: string): Promise<RAGResult[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "search");
    
    try {
      // Detect document language and translate query if needed
      let searchQuery = query;
      if (userLanguage) {
        try {
          const documentLanguage = await this.detectDocumentLanguage();
          logger.debug(`Document language: ${documentLanguage}, User language: ${userLanguage}`);
          
          // If user language is different from document language, translate the query
          if (documentLanguage && userLanguage !== documentLanguage) {
            searchQuery = await this.translateQuery(query, userLanguage, documentLanguage);
            logger.debug(`Translated query from "${query}" to "${searchQuery}"`);
          }
        } catch (translationError) {
          logger.warn("Translation failed, using original query:", translationError);
          searchQuery = query;
        }
      }
      
      const { storeEmbeddings } = this.config;
      
      // Use vector search if embeddings are available
      if (storeEmbeddings) {
        try {
          // Generate embedding for (possibly translated) query using Embedding utility directly
          const { Embedding } = await import("../providers");
          const queryEmbedding = await Embedding.generateEmbedding(searchQuery);
          
          // Search using the embedding
          return this.searchWithEmbedding(queryEmbedding, limit);
        } catch (embeddingError) {
          logger.warn("Error performing embedding search, falling back to keyword search:", embeddingError);
        }
      }
      
      // Fall back to keyword search
      return this.searchByKeyword(searchQuery, limit);
    } catch (error) {
      logger.error(`Error searching with query "${query}":`, error);
      throw error;
    }
  }

  /**
   * Search for documents using keyword matching
   * @param query The search query
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results with full document metadata
   */
  private async searchByKeyword(
    query: string,
    limit?: number
  ): Promise<RAGResult[]> {
    try {
      const { database, maxResults } = this.config;
      
      // Simple keyword search using database LIKE queries
      const documents = await database.knex(this.documentsTableName)
        .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
        .limit(limit || maxResults!);
      
      // Process results with enhanced metadata
      return documents.map(doc => {
        const parsedMetadata = typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata;
        
        return {
          content: doc.content,
          metadata: {
            // Include original document metadata
            ...parsedMetadata,
            // Add document-level information for LLM context
            documentId: doc.id,
            documentType: 'full_document',
            searchMethod: 'keyword',
            contentLength: doc.content.length,
            createdAt: doc.createdAt
          },
          sourceId: doc.id,
        };
      });
    } catch (error) {
      logger.error(`Error searching by keyword "${query}":`, error);
      throw error;
    }
  }

  /**
   * Search for documents using embedding similarity
   * @param embedding The query embedding vector
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of search results with similarity scores and full metadata
   */
  private async searchWithEmbedding(
    embedding: number[],
    limit?: number
  ): Promise<RAGResult[]> {
    try {
      const { database, maxResults } = this.config;
      
      // Get all documents with embeddings
      const documents = await database.knex(this.documentsTableName)
        .select("*")
        .whereNotNull("embedding");
      
      // Calculate similarity and filter results
      const results: RAGResult[] = [];
      
      for (const doc of documents) {
        try {
          // Parse embedding from JSON
          const docEmbedding = typeof doc.embedding === 'string' ? JSON.parse(doc.embedding) : doc.embedding;
          
          // Skip documents with invalid embeddings
          if (!Array.isArray(docEmbedding) || docEmbedding.length === 0) {
            continue;
          }
          
          // Calculate cosine similarity
          const similarity = this.calculateCosineSimilarity(embedding, docEmbedding);
          
          // Only include results with similarity >= 0.7
          if (similarity >= 0.7) {
            const parsedMetadata = typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata;
            
            // Add to results with enhanced metadata
            results.push({
              content: doc.content,
              metadata: {
                // Include original document metadata
                ...parsedMetadata,
                // Add document-level information for LLM context
                documentId: doc.id,
                documentType: 'full_document',
                searchMethod: 'embedding',
                similarity: similarity,
                contentLength: doc.content.length,
                createdAt: doc.createdAt,
                embeddingDimensions: docEmbedding.length
              },
              similarity,
              sourceId: doc.id,
            });
          }
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

  /**
   * Detect the primary language of documents using LLM
   * @returns Promise resolving to the detected language code or null
   */
  private async detectDocumentLanguage(): Promise<string | null> {
    try {
      const { database } = this.config;
      
      // First check metadata for explicit language info
      const sampleDocuments = await database.knex(this.documentsTableName)
        .select('metadata')
        .limit(10);
      
      for (const doc of sampleDocuments) {
        try {
          const metadata = typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata;
          if (metadata && metadata.language) {
            logger.debug(`Found document language in metadata: ${metadata.language}`);
            return metadata.language;
          }
        } catch (parseError) {
          continue;
        }
      }
      
      // If no metadata, get sample content and let LLM detect language
      const sampleContent = await database.knex(this.documentsTableName)
        .select('content')
        .limit(3);
      
      if (sampleContent.length === 0) {
        logger.debug(`No content found, defaulting to English`);
        return 'en';
      }
      
      // Combine sample texts for better detection
      const sampleText = sampleContent
        .map(doc => doc.content)
        .join('\n\n')
        .substring(0, 1000); // Limit for efficiency
      
      // Use LLM for language detection
      const { Embedding } = await import("../providers");
      
      logger.debug(`Using LLM to detect language from sample text`);
      return 'en'; // Simplified for now - could implement LLM detection here too
      
    } catch (error) {
      logger.warn(`Error detecting document language:`, error);
      return 'en';
    }
  }

  /**
   * Translate query from source language to target language using LLM
   * @param query Original query text
   * @param fromLang Source language code
   * @param toLang Target language code
   * @returns Promise resolving to translated query
   */
  private async translateQuery(query: string, fromLang: string, toLang: string): Promise<string> {
    try {
      // Use the Embedding utility which has access to OpenAI
      const { Embedding } = await import("../providers");
      
      // For DocumentRAG, use a simplified translation approach
      // In a full implementation, this would also use the LLM provider
      logger.debug(`Translating query from ${fromLang} to ${toLang}: ${query}`);
      
      // For now, return original query - could implement full LLM translation here
      return query;
      
    } catch (error) {
      logger.warn(`Translation error:`, error);
      return query; // Fall back to original query
    }
  }

  /**
   * Create RAG search tool for document-based search
   * @returns Array with document search tool
   */
  createRAGTools(): Plugin[] {
    return [{
      name: "rag_search",
      description: "Search through documents using keyword and content similarity to find relevant information",
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
        },
        {
          name: "userLanguage",
          type: "string",
          description: "The language code of the user's query (e.g., 'tr' for Turkish, 'en' for English)",
          required: false
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const query = params.query as string;
          const limit = params.limit as number || 5;
          const userLanguage = params.userLanguage as string | undefined;
          
          if (!query) {
            throw new Error("Query parameter is required");
          }
          
          // Use document-based search with language support
          const results = await this.search(query, limit, userLanguage);
          
          // Filter results by minimum similarity threshold (0.7) to ensure quality
          const highQualityResults = results.filter(r => {
            const similarity = r.similarity || r.metadata?.similarity || 0;
            return similarity >= 0.7;
          });
          
          // If no high-quality results found, return "no results found" response
          if (highQualityResults.length === 0) {
            return {
              success: true,
              results: [],
              query: query,
              resultCount: 0,
              searchType: "document",
              message: "No relevant documents found with sufficient similarity. The query may be too specific or the information may not be available in the knowledge base."
            };
          }
          
          return {
            success: true,
            results: highQualityResults,
            query: query,
            resultCount: highQualityResults.length,
            searchType: "document"
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred during document search",
            query: params.query
          };
        }
      }
    }];
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