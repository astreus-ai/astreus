import { EmbeddingService, EmbeddingConfig } from '../database/embedding';
import { KnowledgeDatabase, KnowledgeDatabaseConfig, getKnowledgeDatabase } from '../database/knowledge';
import * as fs from 'fs';
import * as path from 'path';

export interface KnowledgeConfig {
  database?: KnowledgeDatabaseConfig;
  embedding?: EmbeddingConfig;
  chunkSize?: number;
  chunkOverlap?: number;
}

export class Knowledge {
  private database: KnowledgeDatabase | null = null;
  private embedder: EmbeddingService;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(config?: KnowledgeConfig) {
    this.embedder = new EmbeddingService(config?.embedding);
    this.chunkSize = config?.chunkSize || 1000;
    this.chunkOverlap = config?.chunkOverlap || 200;
  }

  private async getDatabase(): Promise<KnowledgeDatabase> {
    if (!this.database) {
      this.database = await getKnowledgeDatabase();
    }
    return this.database;
  }

  async addDocument(agentId: number, content: string, title?: string, metadata?: any): Promise<number> {
    const db = await this.getDatabase();
    
    // Add document first
    const documentId = await db.addDocument(
      agentId,
      title || 'Untitled Document',
      content,
      metadata?.filePath,
      metadata?.fileType,
      metadata?.fileSize,
      metadata
    );

    // Create and add chunks
    const chunks = this.chunkText(content);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await this.embedder.embedSingle(chunk);
      
      await db.addChunk(
        documentId,
        agentId,
        chunk,
        embedding,
        i,
        {
          totalChunks: chunks.length,
          ...metadata
        }
      );
    }

    return documentId;
  }

  async search(agentId: number, query: string, limit: number = 5, threshold: number = 0.7): Promise<Array<{
    content: string;
    metadata: any;
    similarity: number;
  }>> {
    const db = await this.getDatabase();
    const queryEmbedding = await this.embedder.embedSingle(query);
    return db.searchKnowledge(agentId, queryEmbedding, limit, threshold);
  }

  async getContext(agentId: number, query: string, limit: number = 5): Promise<string> {
    const results = await this.search(agentId, query, limit);
    
    if (results.length === 0) {
      return '';
    }
    
    return results
      .map(r => r.content)
      .join('\n\n---\n\n');
  }

  async getDocuments(agentId: number): Promise<any[]> {
    const db = await this.getDatabase();
    return db.getDocuments(agentId);
  }

  async deleteDocument(documentId: number): Promise<boolean> {
    const db = await this.getDatabase();
    return db.deleteDocument(documentId);
  }

  async deleteChunk(chunkId: number): Promise<boolean> {
    const db = await this.getDatabase();
    return db.deleteChunk(chunkId);
  }

  async clearAgentKnowledge(agentId: number): Promise<void> {
    const db = await this.getDatabase();
    return db.clearAgentKnowledge(agentId);
  }

  async addDocumentFromFile(agentId: number, filePath: string, metadata?: any): Promise<void> {
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
          throw new Error(`Unsupported file type: ${fileExtension}`);
      }

      const fileName = path.basename(filePath);
      const title = metadata?.title || fileName;
      const { getFileSize } = await import('../database/utils');
      
      const fileMetadata = {
        ...metadata,
        fileName,
        filePath,
        fileType: fileExtension,
        fileSize: getFileSize(filePath),
        addedAt: new Date().toISOString()
      };

      await this.addDocument(agentId, content, title, fileMetadata);
    } catch (error) {
      throw new Error(`Failed to process file ${filePath}: ${error}`);
    }
  }

  async addDocumentsFromDirectory(agentId: number, dirPath: string, metadata?: any): Promise<void> {
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
            await this.addDocumentFromFile(agentId, fullPath, metadata);
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
    const pdfParse = await import('pdf-text-extract') as any;
    
    return new Promise((resolve, reject) => {
      pdfParse.default(filePath, (err: any, pages: string[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(pages.join('\n'));
        }
      });
    });
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

export { EmbeddingService } from '../database/embedding';
export type { EmbeddingConfig } from '../database/embedding';

export { knowledgeSearchTool, knowledgeTools } from './plugin';