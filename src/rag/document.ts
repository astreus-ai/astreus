import { v4 as uuidv4 } from "uuid";
import {
  Document,
  RAGResult,
  DocumentRAGConfig,
  DocumentRAGInstance,
  DocumentRAGFactory,
} from "../types";
import { Plugin } from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { 
  DEFAULT_MAX_RESULTS,
  DEFAULT_VECTOR_SIMILARITY_THRESHOLD,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP
} from "./config";
import { DEFAULT_MODEL } from "../agent/config";

/**
 * Document-based RAG implementation
 * Stores and retrieves complete documents with optional embeddings
 */
export class DocumentRAG implements DocumentRAGInstance {
  public config: DocumentRAGConfig;
  private documentsTableName: string;
  private chunksTableName: string;
  private embeddingCache: Map<string, { embedding: number[], timestamp: number }> = new Map();
  private readonly CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache TTL

  constructor(config: DocumentRAGConfig) {
    validateRequiredParam(config, "config", "DocumentRAG constructor");
    validateRequiredParam(config.database, "config.database", "DocumentRAG constructor");
    
    logger.info("System", "DocumentRAG", `Initializing document RAG with collection: ${config.tableName || 'default'}`);
    
    this.config = {
      ...config,
      tableName: config.tableName || "rag",
      maxResults: config.maxResults || DEFAULT_MAX_RESULTS,
      storeEmbeddings: config.storeEmbeddings || false,
      chunkSize: config.chunkSize || DEFAULT_CHUNK_SIZE,
      chunkOverlap: config.chunkOverlap || DEFAULT_CHUNK_OVERLAP,
    };
    
    const baseTableName = this.config.tableName;
    this.documentsTableName = `${baseTableName}_documents`;
    this.chunksTableName = `${baseTableName}_chunks`;
    
    logger.debug("System", "DocumentRAG", `Configuration: storeEmbeddings=${this.config.storeEmbeddings}, threshold=${DEFAULT_VECTOR_SIMILARITY_THRESHOLD}`);
    logger.success("System", "DocumentRAG", "Document RAG initialized successfully");
  }

  /**
   * Create a new document RAG instance with proper configuration
   * @param config Configuration object for document RAG
   * @returns Promise that resolves to the new document RAG instance
   */
  static async create(config: DocumentRAGConfig): Promise<DocumentRAGInstance> {
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
      logger.error("System", "DocumentRAG", `Error creating document RAG instance: ${error}`);
      throw error;
    }
  }

  /**
   * Initialize database tables for document RAG
   */
  private async initializeDatabase(): Promise<void> {
    try {
      const { database, storeEmbeddings } = this.config;
      
      await database.ensureTable(this.documentsTableName, (table) => {
        table.string("id").primary();
        table.json("metadata").notNullable();
        table.timestamp("createdAt").defaultTo(database.knex.fn.now());
      });
      
      await database.ensureTable(this.chunksTableName, (table) => {
        table.string("id").primary();
        table.string("documentId").notNullable().index();
        table.text("content").notNullable();
        table.json("metadata").notNullable();
        if (storeEmbeddings) {
          table.json("embedding");
        }
        table.timestamp("createdAt").defaultTo(database.knex.fn.now());
        
        table.foreign("documentId").references("id").inTable(this.documentsTableName).onDelete("CASCADE");
      });
      
      if (storeEmbeddings) {
        const hasChunksEmbeddingColumn = await database.knex.schema.hasColumn(
          this.chunksTableName,
          "embedding"
        );
        
        if (!hasChunksEmbeddingColumn) {
          await database.knex.schema.table(this.chunksTableName, (table) => {
            table.json("embedding");
          });
          logger.debug("System", "DocumentRAG", `Added embedding column to ${this.chunksTableName} table`);
        }
      }
      
      logger.info("System", "DocumentRAG", `Document RAG initialized with custom table: ${this.documentsTableName}`);
      logger.debug("System", "DocumentRAG", "Document RAG database initialized");
    } catch (error) {
      logger.error("System", "DocumentRAG", `Error initializing document RAG database: ${error}`);
      throw error;
    }
  }

  /**
   * Add a document to the RAG system
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
      const { database, storeEmbeddings } = this.config;
      const documentId = uuidv4();
      
      // Store only the document metadata (content is in chunks)
      const docToInsert: any = {
        id: documentId,
        metadata: JSON.stringify(document.metadata),
        createdAt: new Date(),
      };
      
      await database.knex(this.documentsTableName).insert(docToInsert);
      
      // Create chunks from the document
      const chunks = this.chunkDocument(documentId, document);
      
      // Store chunks with embeddings
      if (storeEmbeddings) {
        // Process chunks in batches for better performance
        const batchSize = 20;
        
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          
          // Generate embeddings in parallel
          const embeddingPromises = batch.map(chunk => 
            this.generateEmbeddingWithCache(chunk.content)
          );
          
          const embeddings = await Promise.all(embeddingPromises);
          
          // Store chunks with embeddings
          const chunkInserts = batch.map((chunk, index) => ({
            id: uuidv4(),
            documentId: chunk.documentId,
            content: chunk.content,
            metadata: JSON.stringify(chunk.metadata),
            embedding: JSON.stringify(embeddings[index]),
            createdAt: new Date(),
          }));
          
          await database.knex(this.chunksTableName).insert(chunkInserts);
          
          logger.debug("System", "DocumentRAG", `Processed batch of ${batch.length} chunks with embeddings`);
        }
        
        logger.debug("System", "DocumentRAG", `Document ${documentId}: Created ${chunks.length} chunks with embeddings`);
      } else {
        // Store chunks without embeddings
        const chunkInserts = chunks.map(chunk => ({
          id: uuidv4(),
          documentId: chunk.documentId,
          content: chunk.content,
          metadata: JSON.stringify(chunk.metadata),
          createdAt: new Date(),
        }));
        
        await database.knex(this.chunksTableName).insert(chunkInserts);
        
        logger.debug("System", "DocumentRAG", `Document ${documentId}: Created ${chunks.length} chunks without embeddings`);
      }
      
      logger.debug("System", "DocumentRAG", `Added document ${documentId} to DocumentRAG system`);
      return documentId;
    } catch (error) {
      logger.error("System", "DocumentRAG", `Error adding document to DocumentRAG system: ${error}`);
      throw error;
    }
  }

  /**
   * Split a document into chunks for DocumentRAG
   * @param documentId The ID of the document
   * @param document The document to chunk
   * @returns Array of chunks
   */
  private chunkDocument(
    documentId: string,
    document: Omit<Document, "id" | "embedding">
  ): { documentId: string, content: string, metadata: Record<string, any> }[] {
    const { chunkSize, chunkOverlap } = this.config;
    const text = document.content;
    const chunks: { documentId: string, content: string, metadata: Record<string, any> }[] = [];
    
    // Extract page info from metadata if available (from PDF parser)
    const numPages = document.metadata?.numPages;
    const includePageNumbers = document.metadata?.includePageNumbers;
    const avgCharsPerPage = numPages ? text.length / numPages : 0;
    
    for (let i = 0; i < text.length; i += (chunkSize! - chunkOverlap!)) {
      if (i >= text.length) break;
      
      const chunkContent = text.substring(i, i + chunkSize!);
      
      if (!chunkContent.trim()) continue;
      
      // Estimate page number if available
      let pageEstimate = undefined;
      if (numPages && includePageNumbers && avgCharsPerPage > 0) {
        pageEstimate = Math.min(
          Math.ceil((i + chunkSize! / 2) / avgCharsPerPage),
          numPages
        );
      }
      
      chunks.push({
        documentId,
        content: chunkContent,
        metadata: {
          ...document.metadata,
          chunk_index: chunks.length,
          start_char: i,
          end_char: Math.min(i + chunkSize!, text.length),
          ...(pageEstimate ? { page: pageEstimate } : {}),
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
      logger.debug("System", "DocumentRAG", "Using cached embedding");
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
        
        logger.debug("System", "DocumentRAG", `Generated and cached embedding (${embedding.length} dimensions)`);
      } catch (error) {
        logger.warn("System", "DocumentRAG", `Failed to generate embedding: ${error}`);
        
        // Try memory fallback if available
        if (this.config.memory && this.config.memory.searchByEmbedding) {
          try {
            const { Embedding } = await import("../provider/adapters");
            embedding = await Embedding.generateEmbedding(text.substring(0, 8000));
            
            // Cache the fallback result too
            this.embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() });
            
            logger.debug("System", "DocumentRAG", `Generated embedding using memory fallback (${embedding.length} dimensions)`);
          } catch (memoryError) {
            logger.warn("System", "DocumentRAG", `Failed to generate embedding using memory fallback: ${memoryError}`);
          }
        }
      }
    } else if (this.config.memory && this.config.memory.searchByEmbedding) {
      try {
        const { Embedding } = await import("../provider/adapters");
        embedding = await Embedding.generateEmbedding(text.substring(0, 8000));
        
        // Cache the result
        this.embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() });
        
        logger.debug("System", "DocumentRAG", `Generated embedding using memory (${embedding.length} dimensions)`);
      } catch (error) {
        logger.warn("System", "DocumentRAG", `Failed to generate embedding using memory: ${error}`);
      }
    }
    
    return embedding;
  }

  /**
   * Get a document by ID
   * @param id The document ID
   * @returns Promise resolving to the document or null if not found
   */
  async getDocumentById(id: string): Promise<Document | null> {
    validateRequiredParam(id, "id", "getDocumentById");
    
    try {
      const { database } = this.config;
      
      const document = await database.knex(this.documentsTableName)
        .where("id", id)
        .first();
      
      if (!document) {
        return null;
      }
      
      // Reconstruct content from chunks
      const chunks = await database.knex(this.chunksTableName)
        .where("documentId", id)
        .orderBy("metadata->>'chunk_index'")
        .select("content");
      
      const reconstructedContent = chunks.map(chunk => chunk.content).join('');
      
      return {
        id: document.id,
        content: reconstructedContent,
        metadata: typeof document.metadata === 'string' ? JSON.parse(document.metadata) : document.metadata,
      };
    } catch (error) {
      logger.error("System", "DocumentRAG", `Error getting document by ID: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a document
   * @param id The document ID
   * @returns Promise resolving when the document is deleted
   */
  async deleteDocument(id: string): Promise<void> {
    validateRequiredParam(id, "id", "deleteDocument");
    
    try {
      const { database } = this.config;
      
      // Delete chunks first (foreign key constraint will handle this automatically with CASCADE)
      const chunkCount = await database.knex(this.chunksTableName)
        .where("documentId", id)
        .count("* as count");
      
      // Delete the document (chunks will be deleted automatically due to CASCADE)
      await database.knex(this.documentsTableName)
        .where("id", id)
        .delete();
      
      logger.debug("System", "DocumentRAG", `Successfully deleted document ${id} and ${chunkCount[0].count} chunks`);
    } catch (error) {
      logger.error("System", "DocumentRAG", `Error deleting document: ${error}`);
      throw error;
    }
  }

  /**
   * Standard search method - wrapper around internal search
   * @param query Search query
   * @param limit Maximum number of results
   * @param userLanguage User's language for translation
   * @returns Search results
   */
  async search(
    query: string, 
    limit?: number, 
    userLanguage?: string
  ): Promise<RAGResult[]> {
    return this.searchInternal(query, limit, userLanguage);
  }

  private async searchInternal(
    query: string, 
    limit?: number, 
    userLanguage?: string
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
        const { storeEmbeddings } = this.config;
        
        if (storeEmbeddings) {
          try {
            const queryEmbedding = await this.generateEmbeddingWithCache(variation);
            
            if (queryEmbedding && queryEmbedding.length > 0) {
              const searchThreshold = 0.5;
              
              const results = await this.searchWithEmbedding(queryEmbedding, resultsPerVariation, searchThreshold);
              
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
          } catch (embeddingError) {
            logger.warn("System", "DocumentRAG", `Error performing embedding search: ${embeddingError}`);
          }
        }
        
        // Fall back to keyword search
        const results = await this.searchByKeyword(variation, resultsPerVariation);
        return results.map(result => ({
          ...result,
          metadata: {
            ...result.metadata,
            queryType: queryType,
            queryVariation: variation,
            originalQuery: query
          }
        }));
      } catch (variationError) {
        logger.debug("System", "DocumentRAG", `Error searching with variation ${queryType}: ${variationError}`);
        return [];
      }
    });
    
    // Wait for all searches to complete and flatten results
    const searchResults = await Promise.all(searchPromises);
    searchResults.forEach(results => allResults.push(...results));

    // Optimized deduplication using content-based key for better accuracy
    const uniqueResults = new Map<string, RAGResult>();
    
    for (const result of allResults) {
      const key = result.sourceId;
      
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

    const finalResults = Array.from(uniqueResults.values())
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, maxResults);

    return finalResults;
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
      
      // Search in chunks instead of full documents
      const chunks = await database.knex(this.chunksTableName)
        .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
        .limit(limit || maxResults!);
      
      // Get document metadata for each chunk
      const documentIds = [...new Set(chunks.map((chunk: any) => chunk.documentId))];
      const documents = await database.knex(this.documentsTableName)
        .whereIn("id", documentIds)
        .select("*");
      
      const documentsMap = documents.reduce((map: any, doc: any) => {
        map[doc.id] = doc;
        return map;
      }, {});
      
      // Process results with enhanced metadata
      return chunks.map((chunk: any) => {
        const chunkMetadata = typeof chunk.metadata === 'string' ? JSON.parse(chunk.metadata) : chunk.metadata;
        const parentDocument = documentsMap[chunk.documentId];
        const documentMetadata = parentDocument 
          ? (typeof parentDocument.metadata === 'string' ? JSON.parse(parentDocument.metadata) : parentDocument.metadata)
          : {};
        
        return {
          content: chunk.content,
          metadata: {
            ...chunkMetadata,
            chunkId: chunk.id,
            documentId: chunk.documentId,
            chunkType: 'text_chunk',
            searchMethod: 'keyword',
            contentLength: chunk.content.length,
            createdAt: chunk.createdAt,
            document: {
              ...documentMetadata,
              documentCreatedAt: parentDocument ? parentDocument.createdAt : null
            }
          },
          sourceId: chunk.id,
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
   * @param threshold Minimum similarity threshold (0-1)
   * @returns Promise resolving to array of search results with similarity scores and full metadata
   */
  private async searchWithEmbedding(
    embedding: number[],
    limit?: number,
    threshold: number = DEFAULT_VECTOR_SIMILARITY_THRESHOLD
  ): Promise<RAGResult[]> {
    try {
      const { database, maxResults } = this.config;
      
      logger.debug("System", "DocumentRAG", `Searching by embedding with ${embedding.length} dimensions, limit: ${limit || maxResults}`);
      
      // Search in chunks instead of full documents
      const chunks = await database.knex(this.chunksTableName)
        .select("*")
        .whereNotNull("embedding");
      
      logger.debug("System", "DocumentRAG", `Found ${chunks.length} chunks with embeddings`);
      
      const results: RAGResult[] = [];
      
      for (const chunk of chunks) {
        try {
          const chunkEmbedding = typeof chunk.embedding === 'string' ? JSON.parse(chunk.embedding) : chunk.embedding;
          
          if (!Array.isArray(chunkEmbedding) || chunkEmbedding.length === 0) {
            continue;
          }
          
          const similarity = this.calculateCosineSimilarity(embedding, chunkEmbedding);
          
          if (similarity >= threshold) {
            const chunkMetadata = typeof chunk.metadata === 'string' ? JSON.parse(chunk.metadata) : chunk.metadata;
            
            results.push({
              content: chunk.content,
              metadata: {
                ...chunkMetadata,
                chunkId: chunk.id,
                documentId: chunk.documentId,
                chunkType: 'text_chunk',
                searchMethod: 'embedding',
                similarity: similarity,
                contentLength: chunk.content.length,
                createdAt: chunk.createdAt,
                embeddingDimensions: chunkEmbedding.length
              },
              similarity,
              sourceId: chunk.id,
            });
          }
        } catch (error) {
          logger.warn("System", "DocumentRAG", `Error processing chunk ${chunk.id}, skipping: ${error}`);
          continue;
        }
      }
      
      // Get document metadata for chunks with high similarity
      if (results.length > 0) {
        const documentIds = [...new Set(results.map(r => r.metadata.documentId))];
        const documents = await database.knex(this.documentsTableName)
          .whereIn("id", documentIds)
          .select("*");
        
        const documentsMap = documents.reduce((map: any, doc: any) => {
          map[doc.id] = doc;
          return map;
        }, {});
        
        // Enhance results with document metadata
        results.forEach(result => {
          const parentDocument = documentsMap[result.metadata.documentId];
          if (parentDocument) {
            const documentMetadata = typeof parentDocument.metadata === 'string' 
              ? JSON.parse(parentDocument.metadata) 
              : parentDocument.metadata;
            
            result.metadata.document = {
              ...documentMetadata,
              documentLength: parentDocument.content.length,
              documentCreatedAt: parentDocument.createdAt
            };
          }
        });
      }
      
      return results
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, limit || maxResults);
    } catch (error) {
      logger.error("System", "DocumentRAG", `Error searching with embedding: ${error}`);
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
  private async detectDocumentLanguage(): Promise<string> {
    try {
      const { database } = this.config;
      
      if (!database) {
        return 'en';
      }
      
      try {
        // Try chunks table first (has more detailed metadata)
        const chunkResult = await database.knex(this.chunksTableName)
          .select('metadata')
          .whereNotNull('metadata')
          .limit(1);
        
        if (chunkResult && chunkResult.length > 0 && chunkResult[0].metadata) {
          try {
            const metadata = typeof chunkResult[0].metadata === 'string' 
              ? JSON.parse(chunkResult[0].metadata) 
              : chunkResult[0].metadata;
            
            if (metadata && metadata.language) {
              const detectedLanguage = await this.detectLanguageWithLLM(metadata.language);
              return detectedLanguage;
            }
          } catch {
          }
        }
        
        // Fallback to documents table
        const docResult = await database.knex(this.documentsTableName)
          .select('metadata')
          .whereNotNull('metadata')
          .limit(1);
        
        if (docResult && docResult.length > 0 && docResult[0].metadata) {
          try {
            const metadata = typeof docResult[0].metadata === 'string' 
              ? JSON.parse(docResult[0].metadata) 
              : docResult[0].metadata;
            
            if (metadata && metadata.language) {
              const detectedLanguage = await this.detectLanguageWithLLM(metadata.language);
              return detectedLanguage;
            }
          } catch {
          }
        }
        
        return 'en';
      } catch {
        return 'en';
      }
    } catch {
      return 'en';
    }
  }

  /**
   * Use LLM to intelligently detect language from any language representation
   * @param languageText Any text that represents a language in any form
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
      
      const defaultModel = this.config.provider.getDefaultModel?.() || DEFAULT_MODEL;
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.1,
        maxTokens: 10
      });
      
      const languageCode = typeof response === 'string' ? 
        response.trim().toLowerCase() : 
        response.content?.trim().toLowerCase() || 'en';
      
      const cleanLanguageCode = languageCode.replace(/[^a-z]/g, '').substring(0, 2);
      const finalLanguageCode = cleanLanguageCode.length === 2 ? cleanLanguageCode : 'en';
      
      return finalLanguageCode;
    } catch {
      return 'en';
    }
  }

  /**
   * Generate multiple query variations using LLM for better search coverage
   * @param query The original query
   * @param language The language of the query
   * @returns Promise resolving to array of query variations [short, medium, long]
   */
  private async generateQueryVariations(query: string, _language: string): Promise<string[]> {
    try {
      if (!this.config.provider) {
        return [query];
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
      
      const defaultModel = this.config.provider.getDefaultModel?.() || DEFAULT_MODEL;
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.3,
        maxTokens: 200
      });

      const responseText = typeof response === 'string' ? 
        response : 
        response.content || '';

      if (!responseText) {
        return [query];
      }

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

      if (variations.length === 0) {
        variations.push(query);
      }

      return variations;

    } catch {
      return [query];
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
    
    if (fromLang.toLowerCase() === toLang.toLowerCase()) {
      return query;
    }
    
    try {
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
      
      const defaultModel = this.config.provider.getDefaultModel?.() || DEFAULT_MODEL;
      const model = this.config.provider.getModel(defaultModel);
      const response = await model.complete(messages, {
        temperature: 0.1,
        maxTokens: 150
      });
      
      const translation = typeof response === 'string' ? 
        response.trim() : 
        response.content?.trim() || query;
      
      const cleanTranslation = translation.replace(/^["']|["']$/g, '').trim();
      
      return cleanTranslation;
    } catch {
      return query;
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