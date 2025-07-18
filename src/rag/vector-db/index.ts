import { logger } from '../../utils';
import { VectorDatabaseType, VectorDatabaseConfig } from '../../types/rag';
import { DatabaseInstance } from '../../types/database';
import dotenv from 'dotenv';
import knex from 'knex';

// Load environment variables
dotenv.config();

/**
 * Interface for vector database operations
 */
export interface VectorDatabaseConnector {
  /** Adds vectors to the database */
  addVectors(vectors: Array<{ id: string, vector: number[], metadata: Record<string, any> }>): Promise<void>;
  
  /** Adds a document to the database */
  addDocument?(document: { id: string, name: string, content: string, metadata: Record<string, any> }): Promise<void>;
  
  /** Similarity search for vectors */
  searchVectors(vector: number[], limit?: number, threshold?: number): Promise<Array<{ id: string, similarity: number }>>;
  
  /** Delete vectors by IDs */
  deleteVectors(ids: string[]): Promise<void>;
  
  /** Get metadata for a vector by ID */
  getVectorMetadata(id: string): Promise<Record<string, any> | null>;
  
  /** Get the underlying database instance for direct access */
  getDatabase?(): any;
  
  /** Close the connection */
  close(): Promise<void>;
}

/**
 * Base class for vector database connectors
 */
abstract class BaseVectorDatabaseConnector implements VectorDatabaseConnector {
  protected config: VectorDatabaseConfig;
  
  constructor(config: VectorDatabaseConfig) {
    this.config = config;
  }
  
  abstract addVectors(vectors: Array<{ id: string, vector: number[], metadata: Record<string, any> }>): Promise<void>;
  abstract searchVectors(vector: number[], limit?: number, threshold?: number): Promise<Array<{ id: string, similarity: number }>>;
  abstract deleteVectors(ids: string[]): Promise<void>;
  abstract getVectorMetadata(id: string): Promise<Record<string, any> | null>;
  abstract close(): Promise<void>;
}

/**
 * PostgreSQL vector database connector (using pgvector)
 */
class PostgresVectorDatabaseConnector extends BaseVectorDatabaseConnector {
  private knex: knex.Knex;
  private tableName: string;
  private connected: boolean = false;
  
  constructor(config: VectorDatabaseConfig) {
    super(config);
    
    // Use custom table name if provided, otherwise default
    this.tableName = config.options?.tableName || 'vector_embeddings';
    
    // Initialize knex with PostgreSQL configuration
    this.knex = knex({
      client: 'pg',
      connection: config.connectionString || {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || '',
        database: process.env.POSTGRES_DB || 'postgres'
      }
    });
    
    logger.debug(`PostgreSQL vector database connector initialized with table name: ${this.tableName}`);
  }
  
  /**
   * Ensure pgvector extension is installed and tables are created
   */
  private async ensureConnection(): Promise<void> {
    if (this.connected) return;
    
    try {
      // Check connection
      await this.knex.raw('SELECT 1');
      
      // Create pgvector extension if it doesn't exist
      await this.knex.raw('CREATE EXTENSION IF NOT EXISTS vector');
      
      // Extract base table name for creating documents table
      const baseTableName = this.tableName.replace('_chunks', '');
      const documentsTableName = `${baseTableName}_documents`;
      
      logger.debug(`PostgreSQL connector: chunks table = ${this.tableName}, base = ${baseTableName}, documents = ${documentsTableName}`);
      
      // Create documents table if it doesn't exist
      const documentsTableExists = await this.knex.schema.hasTable(documentsTableName);
      if (!documentsTableExists) {
        await this.knex.schema.createTable(documentsTableName, (table) => {
          table.string('id').primary();
          table.string('name').notNullable();
          table.text('content');
          table.jsonb('metadata');
          table.timestamp('createdAt').defaultTo(this.knex.fn.now());
        });
        
        logger.debug(`Created ${documentsTableName} table in vector database`);
      }
      
      // Create chunks table if it doesn't exist
      const chunksTableExists = await this.knex.schema.hasTable(this.tableName);
      if (!chunksTableExists) {
        await this.knex.schema.createTable(this.tableName, (table) => {
          table.string('id').primary();
          table.string('documentId').notNullable();
          table.text('content').notNullable();
          table.specificType('embedding', 'vector(1536)'); // Specify 1536 dimensions for OpenAI embeddings
          table.jsonb('metadata');
          table.timestamp('createdAt').defaultTo(this.knex.fn.now());
          
          // Add foreign key constraint to documents table
          table.foreign('documentId').references('id').inTable(documentsTableName).onDelete('CASCADE');
        });
        
        // Create index for vector similarity search
        await this.knex.raw(`CREATE INDEX ${this.tableName}_embedding_idx ON ${this.tableName} USING ivfflat (embedding vector_l2_ops)`);
        
        logger.debug(`Created ${this.tableName} table with pgvector index and foreign key to ${documentsTableName}`);
      }
      
      this.connected = true;
      logger.debug(`Connected to PostgreSQL vector database with documents and chunks tables`);
    } catch (error) {
      logger.error('Error connecting to PostgreSQL vector database:', error);
      throw new Error(`Failed to initialize PostgreSQL vector database: ${error}`);
    }
  }
  
  /**
   * Add vectors to the database
   */
  async addVectors(vectors: Array<{ id: string, vector: number[], metadata: Record<string, any> }>): Promise<void> {
    try {
      await this.ensureConnection();
      
      // Convert vectors to pgvector format and prepare batch insert
      const rows = vectors.map(({ id, vector, metadata }) => {
        // Extract documentId and content from metadata for table schema
        const { documentId, content, ...restMetadata } = metadata;
        
        return {
          id,
          documentId: documentId || 'unknown', // Provide default to prevent null constraint violation
          content: content || '', // Provide default to prevent null constraint violation
          embedding: this.knex.raw(`'[${vector.join(',')}]'::vector`),
          metadata: JSON.stringify(restMetadata),
          createdAt: new Date()
        };
      });
      
      // Use batch insert for better performance
      const batchSize = 50;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await this.knex(this.tableName).insert(batch);
      }
      
      logger.debug(`Added ${vectors.length} vectors to PostgreSQL`);
    } catch (error) {
      logger.error('Error adding vectors to PostgreSQL:', error);
      throw error;
    }
  }
  
  /**
   * Add a document to the vector database documents table
   */
  async addDocument(document: { id: string, name: string, content: string, metadata: Record<string, any> }): Promise<void> {
    try {
      await this.ensureConnection();
      
      const baseTableName = this.tableName.replace('_chunks', '');
      const documentsTableName = `${baseTableName}_documents`;
      
      // Check if document already exists
      const existingDoc = await this.knex(documentsTableName)
        .where('id', document.id)
        .first();
      
      if (!existingDoc) {
        await this.knex(documentsTableName).insert({
          id: document.id,
          name: document.name,
          content: document.content,
          metadata: JSON.stringify(document.metadata),
          createdAt: new Date()
        });
        
        logger.debug(`Added document ${document.id} to PostgreSQL vector database`);
      } else {
        logger.debug(`Document ${document.id} already exists in PostgreSQL vector database`);
      }
    } catch (error) {
      logger.error('Error adding document to PostgreSQL vector database:', error);
      throw error;
    }
  }
  
  /**
   * Search for similar vectors using pgvector's similarity search
   */
  async searchVectors(vector: number[], limit: number = 10, threshold: number = 0.7): Promise<Array<{ id: string, similarity: number }>> {
    try {
      logger.debug("Unknown", "PostgreSQL VectorDB", `Searching with ${vector.length} dimensions, limit: ${limit}, threshold: ${threshold}`);
      await this.ensureConnection();
      
      // For cosine similarity using pgvector: 1 - (embedding <=> ?) 
      // where <=> is cosine distance operator
      // We want similarity >= threshold, so cosine distance <= (1 - threshold)
      const distanceThreshold = 1 - threshold;
      // Calculate cosine distance threshold
      
      // Check total vectors for debugging
      const countResult = await this.knex.raw(`SELECT COUNT(*) as total FROM ${this.tableName}`);
      const _totalVectors = countResult.rows[0]?.total || 0;
      
      // Query using cosine distance operator for better semantic similarity
      const results = await this.knex.raw(`
        SELECT 
          id, 
          1 - (embedding <=> ?) as similarity
        FROM ${this.tableName}
        WHERE (embedding <=> ?) <= ?
        ORDER BY similarity DESC
        LIMIT ?
      `, [
        `[${vector.join(',')}]`,
        `[${vector.join(',')}]`,
        distanceThreshold,
        limit
      ]);
      
      const rows = results.rows;
      logger.debug("Unknown", "PostgreSQL VectorDB", `Found ${rows.length} similar vectors`);
      
      return rows.map((row: any) => ({
        id: row.id,
        similarity: parseFloat(row.similarity)
      }));
    } catch (error) {
      logger.error("Unknown", "PostgreSQL VectorDB", `Error searching vectors: ${error}`);
      throw error;
    }
  }
  
  /**
   * Get metadata for a vector by ID
   */
  async getVectorMetadata(id: string): Promise<Record<string, any> | null> {
    try {
      await this.ensureConnection();
      
      const result = await this.knex(this.tableName)
        .where('id', id)
        .select('metadata', 'content', 'documentId')
        .first();
      
      if (!result) {
        return null;
      }
      
      // Parse metadata if it's a string
      let parsedMetadata = {};
      try {
        if (typeof result.metadata === 'string') {
          parsedMetadata = JSON.parse(result.metadata);
        } else if (typeof result.metadata === 'object' && result.metadata !== null) {
          parsedMetadata = result.metadata;
        }
      } catch (parseError) {
        logger.warn(`Failed to parse metadata for vector ${id}:`, parseError);
        parsedMetadata = {};
      }
      
      // Return full data including content and documentId
      return {
        ...parsedMetadata,
        content: result.content,
        documentId: result.documentId,
        metadata: parsedMetadata
      };
    } catch (error) {
      logger.error(`Error getting metadata for vector ${id}:`, error);
      throw error;
    }
  }
  
  /**
   * Delete vectors by IDs
   */
  async deleteVectors(ids: string[]): Promise<void> {
    try {
      await this.ensureConnection();
      
      await this.knex(this.tableName)
        .whereIn('id', ids)
        .delete();
        
      logger.debug(`Deleted ${ids.length} vectors from PostgreSQL`);
    } catch (error) {
      logger.error('Error deleting vectors from PostgreSQL:', error);
      throw error;
    }
  }
  
  /**
   * Get the underlying database instance for direct access
   */
  getDatabase(): knex.Knex {
    return this.knex;
  }
  
  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    try {
      if (this.knex) {
        await this.knex.destroy();
        this.connected = false;
        logger.debug("Closed PostgreSQL vector database connection");
      }
    } catch (error) {
      logger.error('Error closing PostgreSQL connection:', error);
      throw error;
    }
  }
}

/**
 * Main database vector database connector (using the same database as the application)
 */
class MainDatabaseVectorConnector extends BaseVectorDatabaseConnector {
  private database: DatabaseInstance;
  private tableName: string;
  
  constructor(config: VectorDatabaseConfig, database: DatabaseInstance) {
    super(config);
    this.database = database;
    
    // Use custom table name from database configuration or provided config
    const _dbTableNames = database.getTableNames();
    this.tableName = config.options?.tableName || 
                    database.getCustomTableName('vector_embeddings') || 
                    'vector_embeddings';
    logger.debug("Main database vector connector initialized");
  }
  
  async addVectors(vectors: Array<{ id: string, vector: number[], metadata: Record<string, any> }>): Promise<void> {
    try {
      const records = vectors.map(({ id, vector, metadata }) => {
        // Extract documentId and content from metadata for table schema
        const { documentId, content, ...restMetadata } = metadata;
        
        return {
          id,
          documentId: documentId || 'unknown', // Provide default to prevent null constraint violation
          content: content || '', // Provide default to prevent null constraint violation
          embedding: JSON.stringify(vector),
          metadata: JSON.stringify(restMetadata),
          createdAt: new Date()
        };
      });
      
      // Use batch insert for better performance
      const batchSize = 50;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        await this.database.knex(this.tableName).insert(batch);
      }
      
      logger.debug(`Added ${vectors.length} vectors to main database`);
    } catch (error) {
      logger.error("Error adding vectors to main database:", error);
      throw error;
    }
  }
  
  async searchVectors(vector: number[], limit: number = 10, threshold: number = 0.7): Promise<Array<{ id: string, similarity: number }>> {
    try {
      // Retrieve all vectors from the database
      const rows = await this.database.knex(this.tableName).select('id', 'embedding');
      
      // Calculate cosine similarity for each vector
      const results = rows
        .map((row: { id: string, embedding: string | any[] }) => {
          try {
            let storedVector: number[];
            
            // Handle different embedding data types
            if (!row.embedding) {
              logger.warn(`Empty embedding for vector ${row.id}, skipping`);
              return null;
            }
            
            // If embedding is already an array (parsed by database driver)
            if (Array.isArray(row.embedding)) {
              storedVector = row.embedding;
            }
            // If embedding is a string, parse it
            else if (typeof row.embedding === 'string') {
              if (row.embedding.trim() === '') {
                logger.warn(`Empty embedding string for vector ${row.id}, skipping`);
                return null;
              }
              storedVector = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
            }
            // If embedding is an object, try to extract array
            else if (typeof row.embedding === 'object') {
              storedVector = row.embedding;
            }
            else {
              logger.warn(`Unknown embedding type for vector ${row.id}, skipping`);
              return null;
            }
            
            // Validate that we have a valid array
            if (!Array.isArray(storedVector) || storedVector.length === 0) {
              logger.warn(`Invalid embedding format for vector ${row.id}, skipping`);
              return null;
            }
            
            const similarity = this.calculateCosineSimilarity(vector, storedVector);
            return { id: row.id, similarity };
          } catch (parseError) {
            logger.warn(`Failed to parse embedding for vector ${row.id}:`, parseError);
            return null;
          }
        })
        .filter((result): result is { id: string, similarity: number } => 
          result !== null && result.similarity >= threshold
        )
        .sort((a: { similarity: number }, b: { similarity: number }) => b.similarity - a.similarity)
        .slice(0, limit);
      
      logger.debug(`Found ${results.length} similar vectors in main database`);
      return results;
    } catch (error) {
      logger.error("Error searching vectors in main database:", error);
      throw error;
    }
  }
  
  /**
   * Get metadata for a vector by ID
   */
  async getVectorMetadata(id: string): Promise<Record<string, any> | null> {
    try {
      const result = await this.database.knex(this.tableName)
        .where('id', id)
        .select('metadata', 'content', 'documentId')
        .first();
      
      if (!result) {
        return null;
      }
      
      // Parse metadata if it's a string
      let parsedMetadata = {};
      try {
        if (typeof result.metadata === 'string') {
          parsedMetadata = JSON.parse(result.metadata);
        } else if (typeof result.metadata === 'object' && result.metadata !== null) {
          parsedMetadata = result.metadata;
        }
      } catch (parseError) {
        logger.warn(`Failed to parse metadata for vector ${id}:`, parseError);
        parsedMetadata = {};
      }
      
      // Return full data including content and documentId
      return {
        ...parsedMetadata,
        content: result.content,
        documentId: result.documentId,
        metadata: parsedMetadata
      };
    } catch (error) {
      logger.error(`Error getting metadata for vector ${id}:`, error);
      throw error;
    }
  }
  
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
  
  async deleteVectors(ids: string[]): Promise<void> {
    try {
      await this.database.knex(this.tableName).whereIn('id', ids).delete();
      logger.debug(`Deleted ${ids.length} vectors from main database`);
    } catch (error) {
      logger.error("Error deleting vectors from main database:", error);
      throw error;
    }
  }
  
  /**
   * Get the underlying database instance for direct access
   */
  getDatabase(): DatabaseInstance {
    return this.database;
  }
  
  async close(): Promise<void> {
    // No need to close connection as it's managed by the main database
    logger.debug("Main database vector connector closed");
  }
}

/**
 * Factory function to create a vector database connector based on configuration
 * @param config Vector database configuration
 * @param database Main database instance (if using same database)
 * @returns Vector database connector
 */
export function createVectorDatabaseConnector(
  config?: VectorDatabaseConfig,
  database?: DatabaseInstance
): VectorDatabaseConnector {
  // If no config provided, try to load from environment variables
  if (!config) {
    config = loadVectorDatabaseConfigFromEnv();
  }
  
  // Default to using the main database if no configuration is provided
  if (!config || config.type === VectorDatabaseType.SAME_AS_MAIN) {
    if (!database) {
      throw new Error("Database instance is required when using SAME_AS_MAIN vector database type");
    }
    // Use the provided config instead of creating a new one
    const mainDbConfig = config || { type: VectorDatabaseType.SAME_AS_MAIN };
    return new MainDatabaseVectorConnector(mainDbConfig, database);
  }
  
  // Create the appropriate connector based on type
  switch (config.type) {
    case VectorDatabaseType.POSTGRES:
      return new PostgresVectorDatabaseConnector(config);
    case VectorDatabaseType.QDRANT:
    case VectorDatabaseType.PINECONE:
    case VectorDatabaseType.MILVUS:
    case VectorDatabaseType.WEAVIATE:
      // To be implemented in future PRs
      throw new Error(`Vector database type ${config.type} not yet implemented`);
    default:
      throw new Error(`Unsupported vector database type: ${config.type}`);
  }
}

/**
 * Load vector database configuration from environment variables
 * @returns Vector database configuration
 */
export function loadVectorDatabaseConfigFromEnv(): VectorDatabaseConfig {
  const type = process.env.VECTOR_DB_TYPE as VectorDatabaseType || VectorDatabaseType.SAME_AS_MAIN;
  const connectionString = process.env.VECTOR_DB_CONNECTION_STRING;
  
  // Parse connection string if provided for PostgreSQL
  let parsedOptions: Record<string, any> = {};
  if (type === VectorDatabaseType.POSTGRES && connectionString) {
    try {
      // Parse connection string format: postgres://user:password@host:port/database
      const url = new URL(connectionString);
      parsedOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        user: url.username,
        password: url.password,
        database: url.pathname.substring(1), // Remove leading slash
      };
    } catch (error) {
      logger.error("Failed to parse PostgreSQL connection string:", error);
    }
  }
  
  const config: VectorDatabaseConfig = {
    type,
    connectionString,
    apiKey: process.env.VECTOR_DB_API_KEY,
    environment: process.env.VECTOR_DB_ENVIRONMENT,
    namespace: process.env.VECTOR_DB_NAMESPACE,
    baseUrl: process.env.VECTOR_DB_BASE_URL,
    options: {
      ...parsedOptions,
      tableName: process.env.VECTOR_DB_TABLE_NAME,
    }
  };
  
  return config;
} 