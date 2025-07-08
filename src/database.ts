import { Knex } from "knex";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  DatabaseConfig,
  DatabaseInstance,
  DatabaseFactory,
  TableOperations,
  TableNamesConfig,
} from "./types";
import { createSqliteDatabase } from "./database/sqlite";
import { createPostgresqlDatabase } from "./database/postgresql";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./utils";
import { validateRequiredParam, validateRequiredParams } from "./utils/validation";
import { DEFAULT_DB_PATH } from "./constants";

// Load environment variables
dotenv.config();

// Re-export configuration helpers
export { createSqliteConfig } from "./database/sqlite";
export { createPostgresqlConfig } from "./database/postgresql";

// Re-export database modules
export { 
  createUser, 
  getUserById, 
  getUserByUsername, 
  updateUser, 
  deleteUser 
} from "./database/modules/user";

// Re-export types
export { DatabaseInstance, DatabaseConfig } from "./types/database";

/**
 * Core database implementation that provides storage functionality
 * for the Astreus framework. Supports multiple database backends.
 */
class Database implements DatabaseInstance {
  public knex: Knex;
  public config: DatabaseConfig;
  private initialized: boolean = false;
  private tableNames: Required<TableNamesConfig>;
  private customTables: Map<string, string> = new Map();

  constructor(config: DatabaseConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Database constructor");
    validateRequiredParams(
      config,
      ["type"],
      "Database constructor"
    );
    
    logger.info("System", "Database", `Creating database instance: ${config.type}`);
    
    this.config = config;
    
    // Apply table prefix if specified
    const prefix = config.tablePrefix || '';
    
    // Set table names with defaults and prefix
    this.tableNames = {
      agents: prefix + (config.tableNames?.agents || 'agents'),
      users: prefix + (config.tableNames?.users || 'users'),
      tasks: prefix + (config.tableNames?.tasks || 'tasks'),
      memories: prefix + (config.tableNames?.memories || 'memories'),
      chats: prefix + (config.tableNames?.chats || 'chats'),
      custom: config.tableNames?.custom || {}
    };

    logger.debug("System", "Database", `Table configuration: ${JSON.stringify(this.tableNames)}`);

    // Register custom tables
    if (config.tableNames?.custom) {
      Object.entries(config.tableNames.custom).forEach(([name, tableName]) => {
        this.customTables.set(name, prefix + tableName);
        logger.debug("System", "Database", `Custom table registered: ${name} → ${prefix + tableName}`);
      });
    }

    // Initialize knex instance based on database type
    if (config.type === "sqlite") {
      logger.debug("System", "Database", `Initializing SQLite connection`);
      this.knex = createSqliteDatabase(config);
    } else if (config.type === "postgresql") {
      logger.debug("System", "Database", `Initializing PostgreSQL connection`);
      this.knex = createPostgresqlDatabase(config);
    } else {
      logger.error("System", "Database", `Unsupported database type: ${config.type}`);
      throw new Error(`Unsupported database type: ${config.type}`);
    }
    
    logger.success("System", "Database", `Database instance created: ${config.type}`);
  }

  /**
   * Connect to the database and verify the connection
   * @throws Error if connection fails
   */
  async connect(): Promise<void> {
    try {
      // Test the connection
      await this.knex.raw("SELECT 1");
      logger.success("System", "Database", `Connected to ${this.config.type}`);
    } catch (error) {
      logger.error("System", "Database", `Connection failed: ${error}`);
      throw error;
    }
  }

  /**
   * Gracefully disconnect from the database
   */
  async disconnect(): Promise<void> {
    await this.knex.destroy();
    logger.info("System", "Database", `Disconnected from ${this.config.type}`);
  }

  /**
   * Execute a raw SQL query against the database
   * @param query The SQL query to execute
   * @param params Parameters to bind to the query
   * @returns Results of the query
   */
  async executeQuery<T = any>(query: string, params: any[] = []): Promise<T[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "executeQuery");
    
    try {
      return this.knex.raw(query, params) as Promise<T[]>;
    } catch (error) {
      logger.error("System", "Database", `Query execution failed: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a table exists
   * @param tableName Name of the table to check
   * @returns Promise resolving to boolean indicating if table exists
   */
  async hasTable(tableName: string): Promise<boolean> {
    validateRequiredParam(tableName, "tableName", "hasTable");
    return await this.knex.schema.hasTable(tableName);
  }

  /**
   * Create a table with the given schema
   * @param tableName Name of the table to create
   * @param schema Function that defines the table schema
   */
  async createTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void> {
    validateRequiredParam(tableName, "tableName", "createTable");
    validateRequiredParam(schema, "schema", "createTable");
    
    logger.info("System", "Database", `Creating table: ${tableName}`);
    
    try {
      await this.knex.schema.createTable(tableName, schema);
      logger.success("System", "Database", `Created table: ${tableName}`);
    } catch (error) {
      logger.error("System", "Database", `Table creation failed: ${error}`);
      throw error;
    }
  }

  /**
   * Drop a table if it exists
   * @param tableName Name of the table to drop
   */
  async dropTable(tableName: string): Promise<void> {
    validateRequiredParam(tableName, "tableName", "dropTable");
    
    logger.info("System", "Database", `Dropping table: ${tableName}`);
    
    try {
      await this.knex.schema.dropTableIfExists(tableName);
      logger.success("System", "Database", `Dropped table: ${tableName}`);
    } catch (error) {
      logger.error("System", "Database", `Table drop failed: ${error}`);
      throw error;
    }
  }

  /**
   * Ensure a table exists, create it if it doesn't
   * @param tableName Name of the table to ensure
   * @param schema Function that defines the table schema
   */
  async ensureTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void> {
    validateRequiredParam(tableName, "tableName", "ensureTable");
    validateRequiredParam(schema, "schema", "ensureTable");
    
    logger.debug("System", "Database", `Ensuring table exists: ${tableName}`);
    
    const exists = await this.hasTable(tableName);
    if (!exists) {
      logger.info("System", "Database", `Table does not exist, creating: ${tableName}`);
      await this.createTable(tableName, schema);
    } else {
      logger.debug("System", "Database", `Table already exists: ${tableName}`);
    }
  }

  /**
   * Register a custom table name mapping
   * @param name Logical name for the table
   * @param tableName Actual table name in database
   */
  registerCustomTable(name: string, tableName: string): void {
    validateRequiredParam(name, "name", "registerCustomTable");
    validateRequiredParam(tableName, "tableName", "registerCustomTable");
    
    const prefix = this.config.tablePrefix || '';
    this.customTables.set(name, prefix + tableName);
    logger.debug("System", "Database", `Registered custom table: ${name} → ${prefix + tableName}`);
  }

  /**
   * Get the actual table name for a custom table
   * @param name Logical name of the custom table
   * @returns Actual table name or undefined if not found
   */
  getCustomTableName(name: string): string | undefined {
    return this.customTables.get(name);
  }

  /**
   * Initialize database schema - only handles legacy migrations now
   * Each module (createMemory, createChat, etc.) is responsible for creating its own tables
   */
  async initializeSchema(): Promise<void> {
    try {
      // Only handle legacy migrations, no auto table creation
      await this.migrateLegacyTables();
      
      // Mark as initialized
      this.initialized = true;
      logger.info("System", "Database", "Schema initialized");
    } catch (error) {
      logger.error("System", "Database", `Schema initialization failed: ${error}`);
      throw error;
    }
  }

  /**
   * Migrate legacy tables and remove deprecated ones
   * @param memoriesTableName Optional table name for memories (defaults to configured name)
   */
  private async migrateLegacyTables(memoriesTableName?: string): Promise<void> {
    const memoryTable = memoriesTableName || this.tableNames.memories;
    
    logger.debug("System", "Database", "Checking for legacy tables to migrate");
    
    // Check for task_contexts table (deprecated) and migrate data
    const hasTaskContextsTable = await this.knex.schema.hasTable("task_contexts");
    if (hasTaskContextsTable) {
      logger.info("System", "Database", "Found legacy task_contexts table, migrating data");
      try {
        const contextRecords = await this.knex("task_contexts").select("*");
        if (contextRecords.length > 0) {
          logger.info("System", "Database", `Migrating ${contextRecords.length} task context records`);
          // Check if memories table exists before migration
          const hasMemoriesTable = await this.knex.schema.hasTable(memoryTable);
          if (!hasMemoriesTable) {
            logger.warn("System", "Database", `Memories table missing, skipping migration`);
          } else {
            // Batch insert to memories table
            const memoryRecords = contextRecords.map((record: any) => ({
              id: uuidv4(),
              agentId: "system",
              sessionId: record.sessionId,
              userId: "",
              role: "task_context",
              content: record.data,
              timestamp: record.updatedAt || new Date(),
              metadata: JSON.stringify({
                contextType: "task_execution_context",
                migratedFrom: "task_contexts",
              }),
            }));

            await this.knex(memoryTable).insert(memoryRecords);
            logger.success("System", "Database", `Migrated ${memoryRecords.length} records to memories table`);
          }
        } else {
          logger.debug("System", "Database", "No task context records to migrate");
        }
      } catch (migrationError) {
        logger.error("System", "Database", `Migration error: ${migrationError}`);
      }

      // Drop the deprecated table
      await this.knex.schema.dropTable("task_contexts");
      logger.success("System", "Database", "Legacy task_contexts table removed");
    } else {
      logger.debug("System", "Database", "No legacy tables found");
    }
  }

  /**
   * Get operations interface for a specific table
   * @param tableName Name of the table to operate on
   * @returns Table operations interface
   */
  getTable(tableName: string): TableOperations {
    // Validate required parameters
    validateRequiredParam(tableName, "tableName", "getTable");
    
    const knexInstance = this.knex;

    return {
      /**
       * Insert data into table
       */
      async insert(data: Record<string, any>): Promise<number | string> {
        // Validate required parameters
        validateRequiredParam(data, "data", "insert");
        
        const result = await knexInstance(tableName).insert(data);
        return result[0];
      },

      /**
       * Find records in table
       */
      async find(filter?: Record<string, any>): Promise<Record<string, any>[]> {
        try {
          let query = knexInstance(tableName);
          if (filter) {
            query = query.where(filter);
          }
          return query.select("*");
        } catch (error) {
          logger.error("System", "Database", `Find failed: ${String(error)}`);
          throw error;
        }
      },

      /**
       * Find one record in table
       */
      async findOne(
        filter: Record<string, any>
      ): Promise<Record<string, any> | null> {
        // Validate required parameters
        validateRequiredParam(filter, "filter", "findOne");
        
        try {
          const result = await knexInstance(tableName).where(filter).first();
          return result || null;
        } catch (error) {
          logger.error("System", "Database", `FindOne failed: ${String(error)}`);
          throw error;
        }
      },

      /**
       * Update records in table
       */
      async update(
        filter: Record<string, any>,
        data: Record<string, any>
      ): Promise<number> {
        // Validate required parameters
        validateRequiredParam(filter, "filter", "update");
        validateRequiredParam(data, "data", "update");
        
        try {
          return await knexInstance(tableName).where(filter).update(data);
        } catch (error) {
          logger.error("System", "Database", `Update failed: ${String(error)}`);
          throw error;
        }
      },

      /**
       * Delete records from table
       */
      async delete(filter: Record<string, any>): Promise<number> {
        // Validate required parameters
        validateRequiredParam(filter, "filter", "delete");
        
        try {
          return await knexInstance(tableName).where(filter).delete();
        } catch (error) {
          logger.error("System", "Database", `Delete failed: ${String(error)}`);
          throw error;
        }
      },
    };
  }

  /**
   * Check if the database has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get configured table names
   * @returns Object containing all configured table names
   */
  getTableNames(): Required<TableNamesConfig> {
    return this.tableNames;
  }
}

// Database factory function
export const createDatabase: DatabaseFactory = async (
  config?: DatabaseConfig
) => {
  logger.info("System", "DatabaseFactory", "Creating database instance");
  
  // If no config is provided, create a default one
  if (!config) {
    logger.debug("System", "DatabaseFactory", "No config provided, creating default configuration");
    // Determine which database to use based on environment variables
    const dbType = process.env.DATABASE_TYPE || "sqlite";

    if (dbType === "sqlite") {
      // For SQLite, create a default file-based database
      const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;
      
      // Create database directory if it doesn't exist (for file-based SQLite)
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.debug("System", "DatabaseFactory", `Created directory: ${dir}`);
      }
      
      config = {
        type: "sqlite",
        connection: dbPath,
      };
      
      logger.debug("System", "DatabaseFactory", `Using SQLite: ${dbPath}`);
    } else if (dbType === "postgresql") {
      // For PostgreSQL, use connection URL
      if (process.env.DATABASE_URL) {
        // Parse connection string
        const url = new URL(process.env.DATABASE_URL);
        const host = url.hostname;
        const port = parseInt(url.port || "5432");
        const user = url.username;
        const password = url.password;
        const database = url.pathname.substring(1); // Remove leading slash
        
        config = {
          type: "postgresql",
          connection: {
            host,
            port,
            user,
            password,
            database,
          },
        };
        
        logger.debug("System", "DatabaseFactory", `Using PostgreSQL: ${host}:${port}/${database}`);
      } else {
        logger.error("System", "DatabaseFactory", "PostgreSQL connection requires DATABASE_URL environment variable");
        throw new Error("PostgreSQL connection requires DATABASE_URL environment variable");
      }
    } else {
      logger.error("System", "DatabaseFactory", `Unsupported database type: ${dbType}`);
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  } else {
    logger.debug("System", "DatabaseFactory", `Using provided config: ${config.type}`);
    // Validate the provided config
    validateRequiredParams(
      config,
      ["type"],
      "createDatabase"
    );
  }

  // Create a new database instance
  const db = new Database(config);

  // Connect to the database
  await db.connect();

  // Only run legacy migrations, no auto table creation
  await db.initializeSchema();

  logger.success("System", "DatabaseFactory", `Database instance created and connected: ${config.type}`);
  return db;
};