import { IAgentModule, IAgent } from '../agent/types';
import { EmbeddingService, EmbeddingConfig } from '../llm/embeddings';
import { KnowledgeDatabase, KnowledgeDatabaseConfig, getKnowledgeDatabase } from './storage';
import { MetadataObject } from '../types';
import { knowledgeTools } from './plugin';
import { ToolDefinition } from '../plugin/types';
import { Logger } from '../logger/types';
import * as fs from 'fs';
import * as path from 'path';

export interface KnowledgeConfig {
  database?: KnowledgeDatabaseConfig;
  embedding?: EmbeddingConfig;
  chunkSize?: number;
  chunkOverlap?: number;
}

export class Knowledge implements IAgentModule {
  readonly name = 'knowledge';
  private database: KnowledgeDatabase | null = null;
  private embedder: EmbeddingService;
  private chunkSize: number;
  private chunkOverlap: number;
  private logger: Logger;

  constructor(private agent: IAgent, config?: KnowledgeConfig) {
    this.embedder = new EmbeddingService(config?.embedding);
    this.chunkSize = config?.chunkSize || 1000;
    this.chunkOverlap = config?.chunkOverlap || 200;
    this.logger = agent.logger;
  }

  async initialize(): Promise<void> {
    // Register knowledge tools if agent has plugin system
    if (this.agent && 'registerPlugin' in this.agent) {
      try {
        const knowledgePlugin = {
          name: 'knowledge-tools',
          version: '1.0.0',
          description: 'Built-in knowledge search tools',
          tools: knowledgeTools
        };
        await (this.agent as IAgent & { registerPlugin: (plugin: { name: string; version: string; description?: string; tools?: ToolDefinition[] }) => Promise<void> }).registerPlugin(knowledgePlugin);
      } catch (error) {
        // Plugin registration failed, but knowledge module can still work
        console.warn('Failed to register knowledge tools:', error);
      }
    }
  }

  private async getDatabase(): Promise<KnowledgeDatabase> {
    if (!this.database) {
      this.database = await getKnowledgeDatabase({
        embeddingService: this.embedder
      });
    }
    return this.database;
  }

  async createKnowledge(content: string, title?: string, metadata?: MetadataObject): Promise<number> {
    this.logger.debug('Creating knowledge document', { 
      ...(title && { title }), 
      contentLength: content.length,
      agentId: this.agent.id 
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
    
    this.logger.debug(`Splitting content into ${chunks.length} chunks`, {
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      totalChunks: chunks.length
    });
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      this.logger.debug(`Generating embedding for chunk ${i + 1}/${chunks.length}`, {
        chunkIndex: i,
        chunkLength: chunk.length
      });
      
      const embedding = await this.embedder.embedSingle(chunk);
      
      await db.addChunk(
        documentId,
        this.agent.id,
        chunk,
        embedding,
        i,
        {
          totalChunks: chunks.length,
          ...metadata
        }
      );
    }

    this.logger.debug('Knowledge document created successfully', {
      documentId,
      totalChunks: chunks.length,
      ...(title && { title })
    });
    
    return documentId;
  }

  async searchKnowledge(query: string, limit: number = 5, threshold: number = 0.7): Promise<Array<{
    content: string;
    metadata: MetadataObject;
    similarity: number;
  }>> {
    this.logger.debug('Searching knowledge base', {
      query,
      limit,
      threshold,
      agentId: this.agent.id
    });
    
    const db = await this.getDatabase();
    
    this.logger.debug('Generating query embedding');
    const queryEmbedding = await this.embedder.embedSingle(query);
    
    const results = await db.searchKnowledge(this.agent.id, queryEmbedding, limit, threshold);
    
    this.logger.debug(`Found ${results.length} knowledge results`, {
      resultCount: results.length,
      topSimilarity: results[0]?.similarity
    });
    
    // Transform KnowledgeSearchResult to the expected format
    return results.map(result => ({
      content: result.content,
      metadata: {
        ...result.chunk_metadata,
        documentId: result.document_id,
        documentTitle: result.document_title,
        filePath: result.file_path,
        fileType: result.file_type,
        documentMetadata: result.document_metadata
      },
      similarity: result.similarity
    }));
  }

  async getKnowledgeContext(query: string, limit: number = 5): Promise<string> {
    const results = await this.searchKnowledge(query, limit);
    
    if (results.length === 0) {
      return '';
    }
    
    return results
      .map(r => r.content)
      .join('\n\n---\n\n');
  }

  async getKnowledgeDocuments(): Promise<Array<{ id: number; title: string; file_path: string; created_at: string }>> {
    const db = await this.getDatabase();
    const documents = await db.getDocuments(this.agent.id);
    
    // Transform KnowledgeDocument to expected format, handling null titles
    return documents.map(doc => ({
      id: doc.id,
      title: doc.title || 'Untitled Document',
      file_path: doc.file_path || '',
      created_at: doc.created_at
    }));
  }

  async deleteKnowledgeDocument(documentId: number): Promise<boolean> {
    const db = await this.getDatabase();
    return db.deleteDocument(documentId);
  }

  async deleteKnowledgeChunk(chunkId: number): Promise<boolean> {
    const db = await this.getDatabase();
    return db.deleteChunk(chunkId);
  }

  async clearKnowledge(): Promise<void> {
    const db = await this.getDatabase();
    return db.clearAgentKnowledge(this.agent.id);
  }

  async addKnowledgeFromFile(filePath: string, metadata?: MetadataObject): Promise<void> {
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
          throw new Error(`Unsupported file type: ${fileExtension}. Supported types: .txt, .md, .json, .pdf`);
      }

      const fileName = path.basename(filePath);
      const title = typeof metadata?.title === 'string' ? metadata.title : fileName;
      const { getFileSize } = await import('../database/utils');
      
      const fileMetadata = {
        ...metadata,
        fileName,
        filePath,
        fileType: fileExtension,
        fileSize: getFileSize(filePath),
        addedAt: new Date().toISOString()
      };

      await this.createKnowledge(content, title, fileMetadata);
    } catch (error) {
      throw new Error(`Failed to process file ${filePath}: ${error}`);
    }
  }

  async addKnowledgeFromDirectory(dirPath: string, metadata?: MetadataObject): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }

    const files = fs.readdirSync(dirPath);
    const supportedExtensions = ['.txt', '.md', '.json', '.pdf'];

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (supportedExtensions.includes(ext)) {
          try {
            await this.addKnowledgeFromFile(fullPath, metadata);
          } catch {
            // Skip unsupported files silently
          }
        }
      }
    }
  }

  private async readTextFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  private async readPdfFile(filePath: string): Promise<string> {
    try {
      const pdfParse = await import('pdf-parse');
      const pdfBuffer = await fs.promises.readFile(filePath);
      // Handle different import formats (CommonJS vs ES modules)
      // pdf-parse can be imported as default export or direct function
      type PdfParseFunction = (buffer: Buffer) => Promise<{ text: string }>;
      type PdfParseModule = { default: PdfParseFunction } | PdfParseFunction;
      
      const parsePdfModule = pdfParse as PdfParseModule;
      const parseFunction: PdfParseFunction = ('default' in parsePdfModule) ? parsePdfModule.default : parsePdfModule;
      const data = await parseFunction(pdfBuffer);
      return data.text;
    } catch (error) {
      throw new Error(`Failed to parse PDF file: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

export { EmbeddingService } from '../llm/embeddings';
export type { EmbeddingConfig } from '../llm/embeddings';

export { knowledgeSearchTool, knowledgeTools } from './plugin';