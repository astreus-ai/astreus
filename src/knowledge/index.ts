import { IAgentModule, IAgent } from '../agent/types';
import { getLLMProvider } from '../llm';
import { OpenAIProvider } from '../llm/providers/openai';
import { GeminiProvider } from '../llm/providers/gemini';
import { OllamaProvider } from '../llm/providers/ollama';
import { KnowledgeDatabase, KnowledgeDatabaseConfig, getKnowledgeDatabase } from './storage';
import { MetadataObject } from '../types';
import { knowledgeTools } from './plugin';
import { ToolDefinition } from '../plugin/types';
import { Logger } from '../logger/types';
import { DEFAULT_KNOWLEDGE_CONFIG } from './defaults';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { getFileSize } from '../database/utils';
import * as fs from 'fs';
import * as path from 'path';

export interface KnowledgeConfig {
  database?: KnowledgeDatabaseConfig;
  embeddingProvider?: 'openai' | 'gemini' | 'ollama';
  embeddingModel?: string;
  embeddingApiKey?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export class Knowledge implements IAgentModule {
  readonly name = 'knowledge';
  private database: KnowledgeDatabase | null = null;
  private embeddingProvider: {
    name: string;
    generateEmbedding?: (text: string, model?: string) => Promise<{ embedding: number[] }>;
  } | null = null;
  private embeddingModel: string;
  private chunkSize: number;
  private chunkOverlap: number;
  private logger: Logger;
  private config: KnowledgeConfig;

  constructor(
    private agent: IAgent,
    config?: KnowledgeConfig
  ) {
    this.config = config || {};
    this.chunkSize = config?.chunkSize || DEFAULT_KNOWLEDGE_CONFIG.chunkSize;
    this.chunkOverlap = config?.chunkOverlap || DEFAULT_KNOWLEDGE_CONFIG.chunkOverlap;
    this.logger = agent.logger;
    // Initialize embedding model from agent config or config parameter
    this.embeddingModel = this.agent.config.embeddingModel || config?.embeddingModel || '';
  }

  async initialize(): Promise<void> {
    // Initialize embedding provider
    await this.initializeEmbeddingProvider();

    // Register knowledge tools if agent has plugin system
    if (this.agent && 'registerPlugin' in this.agent) {
      try {
        const knowledgePlugin = {
          name: 'knowledge-tools',
          version: '1.0.0',
          description: 'Built-in knowledge search tools',
          tools: knowledgeTools,
        };
        await (
          this.agent as IAgent & {
            registerPlugin: (plugin: {
              name: string;
              version: string;
              description?: string;
              tools?: ToolDefinition[];
            }) => Promise<void>;
          }
        ).registerPlugin(knowledgePlugin);
      } catch (error) {
        // Plugin registration failed, but knowledge module can still work
        this.logger.debug('Failed to register knowledge tools', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async initializeEmbeddingProvider(): Promise<void> {
    // Use agent's embeddingModel if specified
    this.logger.debug(
      `Initializing embedding provider. Config model: ${this.agent.config.embeddingModel || 'none'}`
    );

    if (this.agent.config.embeddingModel) {
      this.embeddingModel = this.agent.config.embeddingModel;
      this.logger.info(`Using specified embedding model: ${this.embeddingModel}`);
      // Auto-detect provider based on model
      const providerConfig = this.detectProviderFromModel(this.embeddingModel);

      // Create provider with dedicated embedding configuration - NEVER use main OPENAI_BASE_URL
      const config: { apiKey?: string; baseUrl?: string | null; logger?: Logger } = {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl || null, // Explicitly set to null to prevent fallback to OPENAI_BASE_URL
        logger: this.logger,
      };

      const mainProvider = await getLLMProvider(providerConfig.provider, config);
      this.embeddingProvider = mainProvider.getEmbeddingProvider?.() || mainProvider;
    } else {
      // Auto-detect based on available API keys and config
      this.logger.warn('No embeddingModel specified, using auto-detection');
      const providerConfig = this.autoDetectEmbeddingProvider();

      // Create provider with dedicated embedding configuration - NEVER use main OPENAI_BASE_URL
      const config: { apiKey?: string; baseUrl?: string | null; logger?: Logger } = {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl || null, // Explicitly set to null to prevent fallback to OPENAI_BASE_URL
        logger: this.logger,
      };

      const mainProvider = await getLLMProvider(providerConfig.provider, config);
      this.embeddingProvider = mainProvider.getEmbeddingProvider?.() || mainProvider;
      this.embeddingModel = providerConfig.model;
    }

    this.logger.info(`Knowledge system using ${this.embeddingProvider.name} embeddings`);
    this.logger.debug('Embedding provider initialized', {
      provider: this.embeddingProvider.name,
      model: this.embeddingModel,
      agentId: this.agent.id,
      usingDedicatedProvider: !!this.embeddingProvider.name.includes('-embedding'),
    });
  }

  private detectProviderFromModel(model: string): {
    provider: 'openai' | 'gemini' | 'ollama';
    apiKey?: string;
    baseUrl?: string;
    model: string;
  } {
    try {
      // Check OpenAI provider - prioritize dedicated embedding API key
      if (process.env.OPENAI_EMBEDDING_API_KEY) {
        const apiKey = process.env.OPENAI_EMBEDDING_API_KEY;
        const openaiProvider = new OpenAIProvider({ apiKey });
        if (openaiProvider.getEmbeddingModels().includes(model)) {
          return {
            provider: 'openai',
            apiKey,
            baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model,
          };
        }
      }

      // Only use main OPENAI_API_KEY if it's not an OpenRouter key (which would have a base URL set)
      if (process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
        const apiKey = process.env.OPENAI_API_KEY;
        const openaiProvider = new OpenAIProvider({ apiKey });
        if (openaiProvider.getEmbeddingModels().includes(model)) {
          return {
            provider: 'openai',
            apiKey,
            baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model,
          };
        }
      }
    } catch {
      // OpenAI provider not available, continue to next
    }

    try {
      // Check Gemini provider
      if (process.env.GEMINI_EMBEDDING_API_KEY || process.env.GEMINI_API_KEY) {
        const apiKey = process.env.GEMINI_EMBEDDING_API_KEY || process.env.GEMINI_API_KEY;
        const geminiProvider = new GeminiProvider({ apiKey });
        if (geminiProvider.getEmbeddingModels().includes(model)) {
          return {
            provider: 'gemini',
            apiKey,
            baseUrl: process.env.GEMINI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model,
          };
        }
      }
    } catch {
      // Gemini provider not available, continue to next
    }

    try {
      // Check Ollama provider (always try as fallback)
      const ollamaProvider = new OllamaProvider({
        baseUrl: process.env.OLLAMA_BASE_URL,
      });
      if (ollamaProvider.getEmbeddingModels().includes(model)) {
        return {
          provider: 'ollama',
          baseUrl: process.env.OLLAMA_BASE_URL,
          model,
        };
      }
    } catch {
      // Ollama provider not available
    }

    // If no provider supports this model, throw error
    throw new Error(`No embedding provider found that supports model: ${model}`);
  }

  private autoDetectEmbeddingProvider(): {
    provider: 'openai' | 'gemini' | 'ollama';
    apiKey?: string;
    baseUrl?: string;
    model: string;
  } {
    // Priority: OpenAI -> Gemini -> Ollama
    try {
      // Try OpenAI first - prioritize dedicated embedding API key
      if (process.env.OPENAI_EMBEDDING_API_KEY) {
        const apiKey = process.env.OPENAI_EMBEDDING_API_KEY;
        const openaiProvider = new OpenAIProvider({ apiKey });
        const models = openaiProvider.getEmbeddingModels();
        if (models.length > 0) {
          return {
            provider: 'openai',
            apiKey,
            baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model: models[0], // Use first available model as default
          };
        }
      }

      // Only use main OPENAI_API_KEY if it's not an OpenRouter key (which would have a base URL set)
      if (process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
        const apiKey = process.env.OPENAI_API_KEY;
        const openaiProvider = new OpenAIProvider({ apiKey });
        const models = openaiProvider.getEmbeddingModels();
        if (models.length > 0) {
          return {
            provider: 'openai',
            apiKey,
            baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model: models[0], // Use first available model as default
          };
        }
      }
    } catch {
      // OpenAI provider not available, continue to next
    }

    try {
      // Try Gemini second
      if (process.env.GEMINI_EMBEDDING_API_KEY || process.env.GEMINI_API_KEY) {
        const apiKey = process.env.GEMINI_EMBEDDING_API_KEY || process.env.GEMINI_API_KEY;
        const geminiProvider = new GeminiProvider({ apiKey });
        const models = geminiProvider.getEmbeddingModels();
        if (models.length > 0) {
          return {
            provider: 'gemini',
            apiKey,
            baseUrl: process.env.GEMINI_EMBEDDING_BASE_URL, // Only dedicated URL, no fallback
            model: models[0], // Use first available model as default
          };
        }
      }
    } catch {
      // Gemini provider not available, continue to next
    }

    try {
      // Default to Ollama (local)
      const ollamaProvider = new OllamaProvider({
        baseUrl: process.env.OLLAMA_BASE_URL,
      });
      const models = ollamaProvider.getEmbeddingModels();
      if (models.length > 0) {
        return {
          provider: 'ollama',
          baseUrl: process.env.OLLAMA_BASE_URL,
          model: models[0], // Use first available model as default
        };
      }
    } catch {
      // Ollama provider not available
    }

    // If no provider is available, throw error
    throw new Error(
      'No embedding provider available. Please configure at least one embedding provider.'
    );
  }

  private async getDatabase(): Promise<KnowledgeDatabase> {
    if (!this.database) {
      if (!this.embeddingProvider) {
        throw new Error('Embedding provider not initialized');
      }
      this.database = await getKnowledgeDatabase({
        embeddingProvider: this.embeddingProvider,
      });
    }
    return this.database;
  }

  async addKnowledge(content: string, title?: string, metadata?: MetadataObject): Promise<number> {
    const startTime = Date.now();

    // User-facing info log
    this.logger.info(
      `Creating knowledge document: ${title || DEFAULT_KNOWLEDGE_CONFIG.defaultTitle}`
    );

    // Detailed debug log with all data
    this.logger.debug('Creating knowledge document', {
      title: title || 'none',
      contentLength: content.length,
      agentId: this.agent.id,
      hasMetadata: !!metadata,
    });

    const db = await this.getDatabase();

    // Add document first
    const documentId = await db.addDocument(
      this.agent.id,
      title || 'Untitled Document',
      content,
      typeof metadata?.filePath === 'string' ? metadata.filePath : undefined,
      typeof metadata?.fileType === 'string' ? metadata.fileType : undefined,
      typeof metadata?.fileSize === 'number' ? metadata.fileSize : undefined,
      metadata
    );

    // Create and add chunks
    const chunks = this.chunkText(content);

    // User-facing info about chunk processing
    this.logger.info(`Processing document into ${chunks.length} chunks for indexing`);

    this.logger.debug(`Splitting content into ${chunks.length} chunks`, {
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      totalChunks: chunks.length,
      firstChunkPreview: chunks[0]?.slice(0, 100) + '...',
    });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Show progress for long documents
      if (i % 5 === 0 && chunks.length > 10) {
        this.logger.info(`Processing chunk ${i + 1} of ${chunks.length}`);
      }

      this.logger.debug(`Generating embedding for chunk ${i + 1}/${chunks.length}`, {
        chunkIndex: i,
        chunkLength: chunk.length,
        chunkPreview: chunk.slice(0, 50) + '...',
      });

      if (!this.embeddingProvider?.generateEmbedding) {
        throw new Error('Embedding provider not properly initialized');
      }
      const embeddingResult = await this.embeddingProvider.generateEmbedding(
        chunk,
        this.embeddingModel
      );
      const embedding = embeddingResult.embedding;

      await db.addChunk(documentId, this.agent.id, chunk, embedding, i, {
        totalChunks: chunks.length,
        ...metadata,
      });
    }

    // User-facing success message
    this.logger.info(`Knowledge document created successfully with ID: ${documentId}`);

    this.logger.debug('Knowledge document created successfully', {
      documentId,
      totalChunks: chunks.length,
      ...(title && { title }),
      processingTime: Date.now() - startTime,
    });

    return documentId;
  }

  async searchKnowledge(
    query: string,
    limit: number = 5,
    threshold: number = 0.7
  ): Promise<
    Array<{
      content: string;
      metadata: MetadataObject;
      similarity: number;
    }>
  > {
    const startTime = Date.now();

    // User-facing info log
    this.logger.info(`Searching knowledge base for: "${query}"`);

    this.logger.debug('Searching knowledge base', {
      query,
      limit,
      threshold,
      agentId: this.agent.id,
    });

    const db = await this.getDatabase();

    this.logger.debug('Generating query embedding');
    if (!this.embeddingProvider?.generateEmbedding) {
      throw new Error('Embedding provider not properly initialized');
    }
    const queryEmbeddingResult = await this.embeddingProvider.generateEmbedding(
      query,
      this.embeddingModel
    );
    const queryEmbedding = queryEmbeddingResult.embedding;

    const results = await db.searchKnowledge(this.agent.id, queryEmbedding, limit, threshold);

    // User-facing result summary
    this.logger.info(
      `Found ${results.length} relevant knowledge ${results.length === 1 ? 'result' : 'results'}`
    );

    this.logger.debug(`Found ${results.length} knowledge results`, {
      resultCount: results.length,
      topSimilarity: results[0]?.similarity || 0,
      searchTime: Date.now() - startTime,
      hasResults: results.length > 0,
    });

    // Transform KnowledgeSearchResult to the expected format
    return results.map((result) => ({
      content: result.content,
      metadata: {
        ...result.chunk_metadata,
        documentId: result.document_id,
        documentTitle: result.document_title,
        filePath: result.file_path,
        fileType: result.file_type,
        documentMetadata: result.document_metadata,
      },
      similarity: result.similarity,
    }));
  }

  async getKnowledgeContext(query: string, limit: number = 5): Promise<string> {
    const results = await this.searchKnowledge(query, limit);

    if (results.length === 0) {
      return '';
    }

    return results.map((r) => r.content).join('\n\n---\n\n');
  }

  async getKnowledgeDocuments(): Promise<
    Array<{ id: number; title: string; file_path: string; created_at: string }>
  > {
    const db = await this.getDatabase();
    const documents = await db.getDocuments(this.agent.id);

    // Transform KnowledgeDocument to expected format, handling null titles
    return documents.map((doc) => ({
      id: doc.id,
      title: doc.title || 'Untitled Document',
      file_path: doc.file_path || '',
      created_at: doc.created_at,
    }));
  }

  async deleteKnowledgeDocument(documentId: number): Promise<boolean> {
    this.logger.info(`Deleting knowledge document: ${documentId}`);

    const db = await this.getDatabase();
    const result = await db.deleteDocument(documentId);

    if (result) {
      this.logger.info(`Knowledge document ${documentId} deleted successfully`);
    } else {
      this.logger.warn(`Failed to delete knowledge document ${documentId}`);
    }

    this.logger.debug('Delete knowledge document result', {
      documentId,
      success: result,
      agentId: this.agent.id,
    });

    return result;
  }

  async deleteKnowledgeChunk(chunkId: number): Promise<boolean> {
    const db = await this.getDatabase();
    return db.deleteChunk(chunkId);
  }

  async clearKnowledge(): Promise<void> {
    this.logger.info('Clearing all knowledge documents');

    const db = await this.getDatabase();
    await db.clearAgentKnowledge(this.agent.id);

    this.logger.info('All knowledge documents cleared successfully');

    this.logger.debug('Cleared knowledge for agent', {
      agentId: this.agent.id,
    });
  }

  async addKnowledgeFromFile(filePath: string, metadata?: MetadataObject): Promise<void> {
    const fileName = path.basename(filePath);
    this.logger.info(`Adding knowledge from file: ${fileName}`);

    const fileExtension = path.extname(filePath).toLowerCase();
    let content: string;

    try {
      switch (fileExtension) {
        case '.txt':
        case '.md':
        case '.json':
          content = await this.readTextFile(filePath);
          break;
        case '.pdf':
          content = await this.readPdfFile(filePath);
          break;
        default:
          throw new Error(
            `Unsupported file type: ${fileExtension}. Supported types: .txt, .md, .json, .pdf`
          );
      }

      const fileName = path.basename(filePath);
      const title = typeof metadata?.title === 'string' ? metadata.title : fileName;

      const fileMetadata = {
        ...metadata,
        fileName,
        filePath,
        fileType: fileExtension,
        fileSize: getFileSize(filePath),
        addedAt: new Date().toISOString(),
      };

      await this.addKnowledge(content, title, fileMetadata);
    } catch (error) {
      throw new Error(`Failed to process file ${filePath}: ${error}`);
    }
  }

  async addKnowledgeFromDirectory(dirPath: string, metadata?: MetadataObject): Promise<void> {
    this.logger.info(`Adding knowledge from directory: ${dirPath}`);

    try {
      await fs.promises.access(dirPath);
    } catch {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }

    const files = await fs.promises.readdir(dirPath);
    const supportedExtensions = ['.txt', '.md', '.json', '.pdf'];
    let processedCount = 0;

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = await fs.promises.stat(fullPath);

      if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (supportedExtensions.includes(ext)) {
          try {
            await this.addKnowledgeFromFile(fullPath, metadata);
            processedCount++;
          } catch (error) {
            this.logger.warn(`Failed to process file ${file}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    this.logger.info(`Processed ${processedCount} files from directory`);

    this.logger.debug('Directory processing complete', {
      directory: dirPath,
      totalFiles: files.length,
      processedFiles: processedCount,
      agentId: this.agent.id,
    });
  }

  private async readTextFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  private async readPdfFile(filePath: string): Promise<string> {
    try {
      const pdfBuffer = await fs.promises.readFile(filePath);

      // Dynamic import for ES Module compatibility
      const pdfjs = await import('pdfjs-dist');

      // Convert Buffer to Uint8Array for pdfjs-dist
      const uint8Array = new Uint8Array(pdfBuffer);

      // Load PDF document
      const loadingTask = pdfjs.getDocument({
        data: uint8Array,
        isEvalSupported: false, // Security: disable eval for CVE-2024-4367 mitigation
      });

      const pdf = await loadingTask.promise;
      let fullText = '';

      // Extract text from all pages
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const pageText = textContent.items
          .map((item: TextItem | TextMarkedContent) => ('str' in item ? item.str : ''))
          .join(' ');

        fullText += pageText + '\n';
      }

      return fullText.trim();
    } catch (error) {
      throw new Error(
        `Failed to parse PDF file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    let currentChunk = '';
    let currentLength = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.length;

      if (currentLength + sentenceLength > this.chunkSize && currentChunk) {
        chunks.push(currentChunk.trim());

        // Add overlap
        const words = currentChunk.split(' ');
        const overlapWords = Math.ceil(words.length * (this.chunkOverlap / this.chunkSize));
        currentChunk = words.slice(-overlapWords).join(' ') + ' ';
        currentLength = currentChunk.length;
      }

      currentChunk += sentence;
      currentLength += sentenceLength;
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}

// Legacy exports for backward compatibility
export type EmbeddingConfig = {
  provider?: 'openai' | 'gemini' | 'ollama';
  model?: string;
  apiKey?: string;
};

export class EmbeddingService {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config?: EmbeddingConfig) {
    // Legacy compatibility wrapper - functionality moved to LLM providers
    // Config parameter kept for backward compatibility
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async embedSingle(_text: string): Promise<number[]> {
    // Text parameter kept for backward compatibility
    throw new Error('EmbeddingService is deprecated. Use LLM provider embeddings instead.');
  }
}

export { knowledgeSearchTool, knowledgeTools } from './plugin';
