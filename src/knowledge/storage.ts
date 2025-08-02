import { Pool } from 'pg';
import { MetadataObject } from '../types';
import { getLogger } from '../logger';
import { getEncryptionService } from '../database/encryption';
import { getSensitiveFields } from '../database/sensitive-fields';

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
  embeddingProvider?: { name: string; generateEmbedding?: (text: string, model?: string) => Promise<{ embedding: number[] }> };
}

export class KnowledgeDatabase {
  private pool: Pool;
  private tableName: string = 'knowledge_vectors';
  private embeddingProvider: { name: string; generateEmbedding?: (text: string, model?: string) => Promise<{ embedding: number[] }> } | null = null;
  private embeddingDimensions: number | null = null;
  private tableDimensions: number | null = null;
  private logger = getLogger();
  private encryption = getEncryptionService();

  constructor(config?: KnowledgeDatabaseConfig) {
    const connectionString = config?.url || process.env.KNOWLEDGE_DB_URL;
    
    if (!connectionString) {
      throw new Error('KNOWLEDGE_DB_URL environment variable is required for knowledge features');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    
    this.embeddingProvider = config?.embeddingProvider || null;
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider is required for knowledge database');
    }
  }

  /**
   * Encrypt sensitive knowledge fields before storing
   */
  private async encryptKnowledgeData(data: Record<string, unknown>, tableName: string): Promise<Record<string, unknown>> {
    if (!this.encryption.isEnabled()) {
      return data;
    }

    const encrypted = { ...data };
    
    // Get sensitive fields from centralized configuration
    const fieldsToEncrypt = getSensitiveFields(tableName);
    
    for (const field of fieldsToEncrypt) {
      if (encrypted[field] !== undefined && encrypted[field] !== null) {
        if (field === 'metadata' && typeof encrypted[field] === 'object') {
          // Handle JSON metadata fields
          encrypted[field] = await this.encryption.encryptJSON(encrypted[field], `${tableName}.${field}`);
        } else {
          // Handle string fields
          encrypted[field] = await this.encryption.encrypt(String(encrypted[field]), `${tableName}.${field}`);
        }
      }
    }

    return encrypted;
  }

  /**
   * Decrypt sensitive knowledge fields after retrieving
   */
  private async decryptKnowledgeData(data: Record<string, unknown>, tableName: string): Promise<Record<string, unknown>> {
    if (!this.encryption.isEnabled() || !data) {
      return data;
    }

    const decrypted = { ...data };
    
    // Get sensitive fields from centralized configuration
    const fieldsToDecrypt = getSensitiveFields(tableName);
    
    for (const field of fieldsToDecrypt) {
      if (decrypted[field] !== undefined && decrypted[field] !== null) {
        if (field === 'metadata') {
          // Handle JSON metadata fields
          decrypted[field] = await this.encryption.decryptJSON(String(decrypted[field]), `${tableName}.${field}`);
        } else {
          // Handle string fields
          decrypted[field] = await this.encryption.decrypt(String(decrypted[field]), `${tableName}.${field}`);
        }
      }
    }

    return decrypted;
  }

  async initialize(): Promise<void> {
    // Get embedding dimensions from a test embedding
    if (!this.embeddingDimensions) {
      // Generate a test embedding to determine dimensions
      if (!this.embeddingProvider?.generateEmbedding) {
        throw new Error('Embedding provider not properly initialized');
      }
      const testResult = await this.embeddingProvider.generateEmbedding('test');
      this.embeddingDimensions = testResult.embedding.length;
      this.logger.debug('Detected embedding dimensions', { dimensions: this.embeddingDimensions });
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
          this.logger.warn(`Dimension mismatch: knowledge_chunks table has ${existingDimensions} dimensions but embedding provider uses ${this.embeddingDimensions} dimensions`);
          this.logger.warn('This will cause embedding insertion errors. Consider:');
          this.logger.warn('1. Switch to an embedding provider with matching dimensions');
          this.logger.warn('2. Or backup data and recreate table with new dimensions');
          this.logger.warn('3. Or regenerate embeddings with new provider');
          
          // Check if table has any data
          const dataCount = await client.query('SELECT COUNT(*) FROM knowledge_chunks');
          const hasData = parseInt(dataCount.rows[0].count) > 0;
          
          if (hasData) {
            this.logger.info(`Table contains ${dataCount.rows[0].count} records. Data will be preserved.`);
            this.logger.info('To force recreation with data loss, you can manually drop the table.');
            // Don't auto-drop if there's data - let user decide
            return;
          } else {
            this.logger.info('Table is empty, safely recreating with new dimensions...');
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
      
      // Prepare data for encryption
      const documentData = {
        agent_id: agentId,
        title,
        content,
        file_path: filePath,
        file_type: fileType,
        file_size: fileSize,
        metadata: metadata || {},
        token_count: tokenCount
      };

      // Encrypt sensitive fields
      const encryptedData = await this.encryptKnowledgeData(documentData, 'knowledge_documents');
      
      const result = await client.query(
        `INSERT INTO knowledge_documents (agent_id, title, content, file_path, file_type, file_size, metadata, token_count) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id`,
        [
          encryptedData.agent_id,
          encryptedData.title,
          encryptedData.content,
          encryptedData.file_path,
          encryptedData.file_type,
          encryptedData.file_size,
          encryptedData.metadata,
          encryptedData.token_count
        ]
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
        `Current embedding provider: ${this.embeddingProvider?.name || 'unknown'} (${this.embeddingDimensions} dimensions). ` +
        `Please ensure embedding provider matches table schema or recreate table.`
      );
    }
    
    const client = await this.pool.connect();
    try {
      const { countTokens } = await import('../database/utils');
      const tokenCount = countTokens(content);

      // Prepare data for encryption
      const chunkData = {
        document_id: documentId,
        agent_id: agentId,
        content,
        token_count: tokenCount,
        chunk_index: chunkIndex,
        embedding: `[${embedding.join(',')}]`, // Keep embedding as is - it's not sensitive
        metadata: metadata || {}
      };

      // Encrypt sensitive fields (not embedding)
      const encryptedData = await this.encryptKnowledgeData(chunkData, 'knowledge_chunks');

      const result = await client.query(
        `INSERT INTO knowledge_chunks (document_id, agent_id, content, token_count, chunk_index, embedding, metadata) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id`,
        [
          encryptedData.document_id,
          encryptedData.agent_id,
          encryptedData.content,
          encryptedData.token_count,
          encryptedData.chunk_index,
          encryptedData.embedding,
          encryptedData.metadata
        ]
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
      
      // Decrypt sensitive fields in search results
      if (this.encryption.isEnabled()) {
        const decryptedResults = await Promise.all(
          result.rows.map(async (row) => {
            try {
              // Decrypt chunk content and metadata
              const decryptedChunk = await this.decryptKnowledgeData(
                { content: row.content, metadata: row.chunk_metadata },
                'knowledge_chunks'
              );
              
              // Decrypt document title, file_path and metadata
              const decryptedDoc = await this.decryptKnowledgeData(
                { title: row.document_title, file_path: row.file_path, metadata: row.document_metadata },
                'knowledge_documents'
              );
              
              return {
                ...row,
                content: decryptedChunk.content,
                chunk_metadata: decryptedChunk.metadata,
                document_title: decryptedDoc.title,
                file_path: decryptedDoc.file_path,
                document_metadata: decryptedDoc.metadata
              };
            } catch {
              // If decryption fails, return original row (might be unencrypted legacy data)
              this.logger.debug('Failed to decrypt knowledge search result', { 
                chunkId: row.id,
                documentId: row.document_id 
              });
              return row;
            }
          })
        );
        return decryptedResults;
      }
      
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
      
      // Decrypt sensitive fields in documents
      if (this.encryption.isEnabled()) {
        const decryptedDocuments = await Promise.all(
          result.rows.map(async (document) => {
            try {
              return await this.decryptKnowledgeData(document, 'knowledge_documents');
            } catch {
              // If decryption fails, return original document (might be unencrypted legacy data)
              this.logger.debug('Failed to decrypt document', { documentId: document.id });
              return document;
            }
          })
        );
        return decryptedDocuments;
      }
      
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
      
      // Decrypt sensitive fields in chunks
      if (this.encryption.isEnabled()) {
        const decryptedChunks = await Promise.all(
          result.rows.map(async (chunk) => {
            try {
              return await this.decryptKnowledgeData(chunk, 'knowledge_chunks');
            } catch {
              // If decryption fails, return original chunk (might be unencrypted legacy data)
              this.logger.debug('Failed to decrypt chunk', { chunkId: chunk.id });
              return chunk;
            }
          })
        );
        return decryptedChunks;
      }
      
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