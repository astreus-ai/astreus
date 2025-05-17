import { Knex } from "knex";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  DatabaseConfig,
  DatabaseInstance,
  DatabaseFactory,
  TableOperations,
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

  constructor(config: DatabaseConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Database constructor");
    validateRequiredParams(
      config,
      ["type"],
      "Database constructor"
    );
    
    this.config = config;

    // Initialize knex instance based on database type
    if (config.type === "sqlite") {
      this.knex = createSqliteDatabase(config);
    } else if (config.type === "postgresql") {
      this.knex = createPostgresqlDatabase(config);
    } else {
      throw new Error(`Unsupported database type: ${config.type}`);
    }
  }

  /**
   * Connect to the database and verify the connection
   * @throws Error if connection fails
   */
  async connect(): Promise<void> {
    try {
      // Test the connection
      await this.knex.raw("SELECT 1");
      logger.database("Connect", `Connected to ${this.config.type} database`);
    } catch (error) {
      logger.error(`Error connecting to ${this.config.type} database:`, error);
      throw error;
    }
  }

  /**
   * Gracefully disconnect from the database
   */
  async disconnect(): Promise<void> {
    await this.knex.destroy();
    logger.database("Disconnect", `Disconnected from ${this.config.type} database`);
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
      logger.error("Error executing query:", error);
      throw error;
    }
  }

  /**
   * Initialize the database schema with all required tables
   * This will create tables if they don't exist and migrate legacy data if needed
   */
  async initializeSchema(): Promise<void> {
    try {
      // Create memories table if it doesn't exist
      await this.initializeMemoriesTable();
      
      // Migrate and remove legacy tables
      await this.migrateLegacyTables();
      
      // Initialize core system tables
      await this.initializeAgentsTable();
      await this.initializeUsersTable();
      await this.initializeTasksTable();
      
      // Mark as initialized
      this.initialized = true;
      logger.database("InitializeSchema", "Database schema initialization complete");
    } catch (error) {
      logger.error("Error initializing database schema:", error);
      throw error;
    }
  }

  /**
   * Initialize the memories table
   */
  private async initializeMemoriesTable(): Promise<void> {
    const hasMemoriesTable = await this.knex.schema.hasTable("memories");
    if (!hasMemoriesTable) {
      await this.knex.schema.createTable(
        "memories",
        (table: Knex.TableBuilder) => {
          table.string("id").primary();
          table.string("agentId").notNullable().index();
          table.string("sessionId").notNullable().index();
          table.string("userId").nullable().index();
          table.string("role").notNullable();
          table.text("content").notNullable();
          table.timestamp("timestamp").defaultTo(this.knex.fn.now());
          table.json("embedding").nullable();
          table.json("metadata");
        }
      );
      logger.database("InitializeSchema", "Created memories table");
    } else {
      logger.database("InitializeSchema", "Using existing memories table");
    }
  }

  /**
   * Migrate legacy tables and remove deprecated ones
   */
  private async migrateLegacyTables(): Promise<void> {
    // Check for task_contexts table (deprecated) and migrate data
    const hasTaskContextsTable = await this.knex.schema.hasTable("task_contexts");
    if (hasTaskContextsTable) {
      try {
        const contextRecords = await this.knex("task_contexts").select("*");
        if (contextRecords.length > 0) {
          logger.database("InitializeSchema", `Migrating ${contextRecords.length} task contexts to memory system...`);

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

          await this.knex("memories").insert(memoryRecords);
          logger.database("InitializeSchema", "Task contexts migration completed successfully");
        }
      } catch (migrationError) {
        logger.error("Error migrating task contexts:", migrationError);
      }

      // Drop the deprecated table
      await this.knex.schema.dropTable("task_contexts");
      logger.database("InitializeSchema", "Dropped deprecated task_contexts table");
    }
  }

  /**
   * Initialize the agents table
   */
  private async initializeAgentsTable(): Promise<void> {
    const hasAgentsTable = await this.knex.schema.hasTable("agents");
    if (!hasAgentsTable) {
      await this.knex.schema.createTable(
        "agents",
        (table: Knex.TableBuilder) => {
          table.string("id").primary();
          table.string("name").notNullable();
          table.text("description").nullable();
          table.text("systemPrompt").nullable();
          table.string("modelName").notNullable();
          table.timestamp("createdAt").defaultTo(this.knex.fn.now());
          table.timestamp("updatedAt").defaultTo(this.knex.fn.now());
          table.json("configuration").nullable();
        }
      );
      logger.database("InitializeSchema", "Created agents table");
    } else {
      logger.database("InitializeSchema", "Using existing agents table");
    }
  }

  /**
   * Initialize the users table
   */
  private async initializeUsersTable(): Promise<void> {
    const hasUsersTable = await this.knex.schema.hasTable("users");
    if (!hasUsersTable) {
      await this.knex.schema.createTable(
        "users",
        (table: Knex.TableBuilder) => {
          table.string("id").primary();
          table.string("username").notNullable().unique();
          table.timestamp("createdAt").defaultTo(this.knex.fn.now());
          table.json("preferences").nullable();
        }
      );
      logger.database("InitializeSchema", "Created users table");
    } else {
      logger.database("InitializeSchema", "Using existing users table");
    }
  }

  /**
   * Initialize the tasks table
   */
  private async initializeTasksTable(): Promise<void> {
    const hasTasksTable = await this.knex.schema.hasTable("tasks");
    if (!hasTasksTable) {
      await this.knex.schema.createTable(
        "tasks",
        (table: Knex.TableBuilder) => {
          table.string("id").primary();
          table.string("name").notNullable();
          table.text("description").notNullable();
          table.string("status").notNullable().index();
          table.integer("retries").defaultTo(0);
          table.json("plugins").nullable();
          table.json("input").nullable();
          table.json("dependencies").nullable();
          table.json("result").nullable();
          table.timestamp("createdAt").defaultTo(this.knex.fn.now());
          table.timestamp("startedAt").nullable();
          table.timestamp("completedAt").nullable();
          table.string("agentId").nullable().index();
          table.string("sessionId").nullable().index();
          table.string("contextId").nullable().index();
        }
      );
      logger.database("InitializeSchema", "Created tasks table");
    } else {
      logger.database("InitializeSchema", "Using existing tasks table");
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
        
        try {
          const result = await knexInstance(tableName).insert(data);
          return result[0];
        } catch (error) {
          logger.error(`Error inserting into ${tableName}:`, error);
          throw error;
        }
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
          logger.error(`Error finding in ${tableName}:`, error);
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
          logger.error(`Error finding one in ${tableName}:`, error);
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
          logger.error(`Error updating in ${tableName}:`, error);
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
          logger.error(`Error deleting from ${tableName}:`, error);
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
}

// Database factory function
export const createDatabase: DatabaseFactory = async (
  config?: DatabaseConfig
) => {
  // If no config is provided, create a default one
  if (!config) {
    // Determine which database to use based on environment variables
    const dbType = process.env.DATABASE_TYPE || "sqlite";

    if (dbType === "sqlite") {
      // For SQLite, create a default file-based database
      const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;
      
      // Create database directory if it doesn't exist (for file-based SQLite)
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.database("CreateDatabase", `Created database directory: ${dir}`);
      }
      
      config = {
        type: "sqlite",
        connection: dbPath,
      };
      
      logger.database("CreateDatabase", `Using SQLite database at ${dbPath}`);
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
        
        logger.database("CreateDatabase", `Using PostgreSQL database from URL: ${host}:${port}/${database}`);
      } else {
        throw new Error("PostgreSQL connection requires DATABASE_URL environment variable");
      }
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  } else {
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

  // Initialize the schema if needed
  if ('initializeSchema' in db) {
    await db.initializeSchema();
  }

  return db;
};