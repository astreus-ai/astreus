import { Pool } from 'pg';
import { MetadataObject } from '../types';
import { EmbeddingService } from '../llm/embeddings';

interface KnowledgeSearchResult {
  id: number;
  content: string;
  token_count: number;
  chunk_index: number;
  chunk_metadata: MetadataObject;
  document_id: number;
  document_title: string;
  file_path: string | null;
  file_type: string | null;
  document_metadata: MetadataObject;
  similarity: number;
}

interface KnowledgeDocument {
  id: number;
  agent_id: number;
  title: string | null;
  content: string;
  file_path: string | null;
  file_type: string | null;
  file_size: number | null;
  metadata: MetadataObject;
  token_count: number;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

interface KnowledgeChunk {
  id: number;
  document_id: number;
  agent_id: number;
  content: string;
  token_count: number;
  chunk_index: number;
  embedding: number[];
  metadata: MetadataObject;
  created_at: string;
}

export interface KnowledgeDatabaseConfig {
  url?: string;
  embeddingService?: EmbeddingService;
}

export class KnowledgeDatabase {
  private pool: Pool;
  private tableName: string = 'knowledge_vectors';
  private embeddingService: EmbeddingService;
  private embeddingDimensions: number | null = null;
  private tableDimensions: number | null = null;

  constructor(config?: KnowledgeDatabaseConfig) {
    const connectionString = config?.url || process.env.KNOWLEDGE_DB_URL;
    
    if (!connectionString) {
      throw new Error('KNOWLEDGE_DB_URL environment variable is required for knowledge features');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    
    this.embeddingService = config?.embeddingService || new EmbeddingService();
  }

  async initialize(): Promise<void> {
    // Get embedding dimensions first
    if (!this.embeddingDimensions) {
      this.embeddingDimensions = await this.embeddingService.getDimensions();
    }
    
    const client = await this.pool.connect();
    try {
      // Enable vector extension
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      
      // Create documents table
      await client.query(`
        CREATE TABLE IF NOT EXISTS knowledge_documents (
          id SERIAL PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          title VARCHAR(255),
          content TEXT NOT NULL,
          file_path VARCHAR(500),
          file_type VARCHAR(20),
          file_size INTEGER,
          metadata JSONB,
          token_count INTEGER,
          chunk_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Handle chunks table with dynamic dimensions
      const chunksTableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'knowledge_chunks'
        )
      `);
      
      if (chunksTableExists.rows[0].exists) {
        // Check if existing table has correct dimensions
        const columnInfo = await client.query(`
          SELECT atttypmod 
          FROM pg_attribute 
          WHERE attrelid = 'knowledge_chunks'::regclass 
          AND attname = 'embedding'
        `);
        
        const existingDimensions = columnInfo.rows[0]?.atttypmod;
        this.tableDimensions = existingDimensions;
        
        if (existingDimensions && existingDimensions !== this.embeddingDimensions) {
          console.log(`WARNING: knowledge_chunks table has ${existingDimensions} dimensions but embedding provider uses ${this.embeddingDimensions} dimensions`);
          console.log('This will cause embedding insertion errors. Consider:');
          console.log('1. Switch to an embedding provider with matching dimensions');
          console.log('2. Or backup data and recreate table with new dimensions');
          console.log('3. Or regenerate embeddings with new provider');
          
          // Check if table has any data
          const dataCount = await client.query('SELECT COUNT(*) FROM knowledge_chunks');
          const hasData = parseInt(dataCount.rows[0].count) > 0;
          
          if (hasData) {
            console.log(`Table contains ${dataCount.rows[0].count} records. Data will be preserved.`);
            console.log('To force recreation with data loss, you can manually drop the table.');
            // Don't auto-drop if there's data - let user decide
            return;
          } else {
            console.log('Table is empty, safely recreating with new dimensions...');
            await client.query('DROP TABLE knowledge_chunks CASCADE');
            await client.query(`
              CREATE TABLE knowledge_chunks (
                id SERIAL PRIMARY KEY,
                document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
                agent_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                token_count INTEGER,
                chunk_index INTEGER,
                embedding vector(${this.embeddingDimensions}),
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
              )
            `);
            this.tableDimensions = this.embeddingDimensions;
          }
        } else {
          this.tableDimensions = this.embeddingDimensions;
        }
      } else {
        // Create new table with correct dimensions
        await client.query(`
          CREATE TABLE knowledge_chunks (
            id SERIAL PRIMARY KEY,
            document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            agent_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            token_count INTEGER,
            chunk_index INTEGER,
            embedding vector(${this.embeddingDimensions}),
            metadata JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
      }

      // Create indexes for documents
      await client.query(`
        CREATE INDEX IF NOT EXISTS knowledge_documents_agent_id_idx 
        ON knowledge_documents (agent_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS knowledge_documents_file_type_idx 
        ON knowledge_documents (file_type)
      `);

      // Create indexes for chunks
      await client.query(`
        CREATE INDEX IF NOT EXISTS knowledge_chunks_agent_id_idx 
        ON knowledge_chunks (agent_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS knowledge_chunks_document_id_idx 
        ON knowledge_chunks (document_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx 
        ON knowledge_chunks 
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      // Knowledge database initialized successfully
    } catch (error) {
      // Failed to initialize knowledge database
      throw new Error(`Knowledge database initialization failed: ${error}`);
    } finally {
      client.release();
    }
  }

  async addDocument(
    agentId: number, 
    title: string,
    content: string, 
    filePath?: string,
    fileType?: string,
    fileSize?: number,
    metadata?: MetadataObject
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      const { countTokens } = await import('../database/utils');
      const tokenCount = countTokens(content);
      
      const result = await client.query(
        `INSERT INTO knowledge_documents (agent_id, title, content, file_path, file_type, file_size, metadata, token_count) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id`,
        [agentId, title, content, filePath, fileType, fileSize, metadata || {}, tokenCount]
      );
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async addChunk(
    documentId: number,
    agentId: number,
    content: string,
    embedding: number[],
    chunkIndex: number,
    metadata?: MetadataObject
  ): Promise<number> {
    // Check dimension compatibility
    if (this.tableDimensions && embedding.length !== this.tableDimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length} dimensions but table expects ${this.tableDimensions}. ` +
        `Current embedding provider: ${this.embeddingService.getProvider().name} (${this.embeddingDimensions} dimensions). ` +
        `Please ensure embedding provider matches table schema or recreate table.`
      );
    }
    
    const client = await this.pool.connect();
    try {
      const { countTokens } = await import('../database/utils');
      const tokenCount = countTokens(content);

      const result = await client.query(
        `INSERT INTO knowledge_chunks (document_id, agent_id, content, token_count, chunk_index, embedding, metadata) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id`,
        [documentId, agentId, content, tokenCount, chunkIndex, `[${embedding.join(',')}]`, metadata || {}]
      );
      
      // Update document chunk count
      await client.query(
        `UPDATE knowledge_documents 
         SET chunk_count = (SELECT COUNT(*) FROM knowledge_chunks WHERE document_id = $1),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [documentId]
      );

      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async searchKnowledge(agentId: number, embedding: number[], limit: number = 10, threshold: number = 0.7): Promise<KnowledgeSearchResult[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT 
           c.id,
           c.content,
           c.token_count,
           c.chunk_index,
           c.metadata as chunk_metadata,
           d.id as document_id,
           d.title as document_title,
           d.file_path,
           d.file_type,
           d.metadata as document_metadata,
           1 - (c.embedding <=> $1::vector) as similarity
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON c.document_id = d.id
         WHERE c.agent_id = $2
         AND 1 - (c.embedding <=> $1::vector) > $3
         ORDER BY c.embedding <=> $1::vector
         LIMIT $4`,
        [`[${embedding.join(',')}]`, agentId, threshold, limit]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getDocuments(agentId: number): Promise<KnowledgeDocument[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM knowledge_documents 
         WHERE agent_id = $1 
         ORDER BY created_at DESC`,
        [agentId]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getDocumentChunks(documentId: number): Promise<KnowledgeChunk[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM knowledge_chunks 
         WHERE document_id = $1 
         ORDER BY chunk_index`,
        [documentId]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async deleteDocument(documentId: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM knowledge_documents WHERE id = $1`,
        [documentId]
      );
      return (result.rowCount || 0) > 0;
    } finally {
      client.release();
    }
  }

  async deleteChunk(chunkId: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM knowledge_chunks WHERE id = $1`,
        [chunkId]
      );
      return (result.rowCount || 0) > 0;
    } finally {
      client.release();
    }
  }

  async clearAgentKnowledge(agentId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `DELETE FROM knowledge_documents WHERE agent_id = $1`,
        [agentId]
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Singleton instance
let knowledgeDb: KnowledgeDatabase | null = null;

export async function getKnowledgeDatabase(config?: KnowledgeDatabaseConfig): Promise<KnowledgeDatabase> {
  if (!knowledgeDb) {
    knowledgeDb = new KnowledgeDatabase(config);
    await knowledgeDb.initialize();
  }
  return knowledgeDb;
}