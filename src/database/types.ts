export type DatabaseType = 'sqlite' | 'postgres';

export interface DatabaseConnection {
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

export interface DatabasePool {
  min?: number;
  max?: number;
}

export interface DatabaseConfig {
  type?: DatabaseType;
  driver?: 'sqlite' | 'postgres' | 'pg';
  connectionString?: string;
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  // Knex config properties
  client?: string;
  connection?: DatabaseConnection;
  pool?: DatabasePool;
  // Connection pool configuration
  /** Maximum number of connections in the pool (default: 10) */
  maxPoolSize?: number;
  /** Minimum number of connections in the pool (default: 2) */
  minPoolSize?: number;
}
