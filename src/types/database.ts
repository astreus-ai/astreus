import { Knex } from "knex";

// Database type
export type DatabaseType = "sqlite" | "postgresql";

// Enhanced table names configuration with more flexibility
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

// Enhanced database configuration
export interface DatabaseConfig {
  /** Required: The type of database to use */
  type: DatabaseType;
  /** Required: Connection string or configuration object */
  connection: string | Knex.StaticConnectionConfig;
  /** Optional: Custom table names for system tables */
  tableNames?: TableNamesConfig;
  /** Optional: Whether to auto-create system tables, defaults to true */
  autoCreateTables?: boolean;
  /** Optional: Prefix for all table names */
  tablePrefix?: string;
}

// Enhanced database instance with better table management
export interface DatabaseInstance {
  knex: Knex;
  config: DatabaseConfig; // Database configuration
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  getTable(tableName: string): TableOperations;
  getTableNames(): Required<TableNamesConfig>;
  
  // Enhanced table management methods
  hasTable(tableName: string): Promise<boolean>;
  createTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void>;
  dropTable(tableName: string): Promise<void>;
  ensureTable(tableName: string, schema: (table: Knex.TableBuilder) => void): Promise<void>;
  
  // Custom table registration
  registerCustomTable(name: string, tableName: string): void;
  getCustomTableName(name: string): string | undefined;
}

// Table operations interface
export interface TableOperations {
  insert(data: Record<string, any>): Promise<number | string>;
  find(filter?: Record<string, any>): Promise<Record<string, any>[]>;
  findOne(filter: Record<string, any>): Promise<Record<string, any> | null>;
  update(
    filter: Record<string, any>,
    data: Record<string, any>
  ): Promise<number>;
  delete(filter: Record<string, any>): Promise<number>;
}

// Database factory function type
export type DatabaseFactory = (
  config?: DatabaseConfig
) => Promise<DatabaseInstance>;
