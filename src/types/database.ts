import { Knex } from "knex";

// Database type
export type DatabaseType = "sqlite" | "postgresql";

// Database configuration
export interface DatabaseConfig {
  /** Required: The type of database to use */
  type: DatabaseType;
  /** Required: Connection string or configuration object */
  connection: string | Knex.StaticConnectionConfig;
}

// Database instance
export interface DatabaseInstance {
  knex: Knex;
  config: DatabaseConfig; // Database configuration
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  getTable(tableName: string): TableOperations;
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
