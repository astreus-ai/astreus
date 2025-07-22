export type DatabaseType = 'sqlite' | 'postgres';

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
}