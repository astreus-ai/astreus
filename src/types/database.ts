import { Knex } from "knex";

// Database type enumeration
export type DatabaseType = "sqlite" | "postgresql";

// Table names configuration interface
export interface TableNamesConfig {
  /** Table name for agents, defaults to 'agents' */
  agents?: string;
  /** Table name for users, defaults to 'users' */
  users?: string;
  /** Table name for tasks, defaults to 'tasks' */
  tasks?: string;
  /** Table name for memories, defaults to 'memories' */
  memories?: string;
  /** Table name for chats, defaults to 'chats' */
  chats?: string;
  /** Custom table names for user-defined tables */
  custom?: Record<string, string>;
}

// Database configuration interface
export interface DatabaseConfig {
  /** Required: The type of database to use */
  type: DatabaseType;
  /** Required: Connection string or configuration object */
  connection: string | Knex.StaticConnectionConfig;
  /** Optional: Custom table names for system tables */
  tableNames?: TableNamesConfig;
  /** Optional: Prefix for all table names */
  tablePrefix?: string;
}

// Table operations interface for CRUD operations
export interface TableOperations {
  /**
   * Insert data into table
   * @param data Record to insert
   * @returns Promise resolving to the inserted record ID
   */
  insert(data: Record<string, any>): Promise<number | string>;
  
  /**
   * Find records in table
   * @param filter Optional filter criteria
   * @returns Promise resolving to array of matching records
   */
  find(filter?: Record<string, any>): Promise<Record<string, any>[]>;
  
  /**
   * Find one record in table
   * @param filter Filter criteria to match a single record
   * @returns Promise resolving to the matching record or null
   */
  findOne(filter: Record<string, any>): Promise<Record<string, any> | null>;
  
  /**
   * Update records in table
   * @param filter Filter criteria for records to update
   * @param data Data to update
   * @returns Promise resolving to number of updated records
   */
  update(
    filter: Record<string, any>,
    data: Record<string, any>
  ): Promise<number>;
  
  /**
   * Delete records from table
   * @param filter Filter criteria for records to delete
   * @returns Promise resolving to number of deleted records
   */
  delete(filter: Record<string, any>): Promise<number>;
}

// Database instance interface
export interface DatabaseInstance {
  /** Knex query builder instance for direct database access */
  knex: Knex;
  /** Database configuration */
  config: DatabaseConfig;
  
  /**
   * Connect to the database and verify the connection
   * @throws Error if connection fails
   */
  connect(): Promise<void>;
  
  /**
   * Gracefully disconnect from the database
   */
  disconnect(): Promise<void>;
  
  /**
   * Execute a raw SQL query against the database
   * @param query The SQL query to execute
   * @param params Parameters to bind to the query
   * @returns Results of the query
   */
  executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  
  /**
   * Get operations interface for a specific table
   * @param tableName Name of the table to operate on
   * @returns Table operations interface
   */
  getTable(tableName: string): TableOperations;
  
  /**
   * Get configured table names
   * @returns Object containing all configured table names
   */
  getTableNames(): Required<TableNamesConfig>;
  
  // Enhanced table management methods
  
  /**
   * Check if a table exists
   * @param tableName Name of the table to check
   * @returns Promise resolving to boolean indicating if table exists
   */
  hasTable(tableName: string): Promise<boolean>;
  
  /**
   * Create a table with the given schema
   * @param tableName Name of the table to create
   * @param schema Function that defines the table schema
   */
  createTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void>;
  
  /**
   * Drop a table if it exists
   * @param tableName Name of the table to drop
   */
  dropTable(tableName: string): Promise<void>;
  
  /**
   * Ensure a table exists, create it if it doesn't
   * @param tableName Name of the table to ensure
   * @param schema Function that defines the table schema
   */
  ensureTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void>;
  
  // Custom table registration
  
  /**
   * Register a custom table name mapping
   * @param name Logical name for the table
   * @param tableName Actual table name in database
   */
  registerCustomTable(name: string, tableName: string): void;
  
  /**
   * Get the actual table name for a custom table
   * @param name Logical name of the custom table
   * @returns Actual table name or undefined if not found
   */
  getCustomTableName(name: string): string | undefined;
  
  /**
   * Check if the database has been initialized
   * @returns Boolean indicating initialization status
   */
  isInitialized(): boolean;
}

// Database factory function type
export type DatabaseFactory = (
  config?: DatabaseConfig
) => Promise<DatabaseInstance>;
