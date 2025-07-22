import { Pool } from 'pg';

export interface KnowledgeDatabaseConfig {
  url?: string;
}

export class KnowledgeDatabase {
  private pool: Pool;
  private tableName: string = 'knowledge_vectors';

  constructor(config?: KnowledgeDatabaseConfig) {
    const connectionString = config?.url || process.env.KNOWLEDGE_DB_URL;
    
    if (!connectionString) {
      throw new Error('KNOWLEDGE_DB_URL environment variable is required for knowledge features');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
  }

  async initialize(): Promise<void> {
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

      // Create chunks table
      await client.query(`
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id SERIAL PRIMARY KEY,
          document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          agent_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          token_count INTEGER,
          chunk_index INTEGER,
          embedding vector(1536),
          metadata JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

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
    metadata?: any
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      const { countTokens } = await import('./utils');
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
    metadata?: any
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      const { countTokens } = await import('./utils');
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

  async searchKnowledge(agentId: number, embedding: number[], limit: number = 10, threshold: number = 0.7): Promise<any[]> {
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

  async getDocuments(agentId: number): Promise<any[]> {
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

  async getDocumentChunks(documentId: number): Promise<any[]> {
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