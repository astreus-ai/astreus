import { Knex } from 'knex';
import { DatabaseConfig } from './types';

function detectDatabaseType(config: DatabaseConfig): string {
  if (config.type) {
    return config.type;
  }
  
  if (config.connectionString) {
    if (config.connectionString.startsWith('sqlite://')) {
      return 'sqlite';
    }
    if (config.connectionString.startsWith('postgresql://') || config.connectionString.startsWith('postgres://')) {
      return 'postgres';
    }
  }
  
  // Default to sqlite if no clear indication
  return 'sqlite';
}

export function createKnexConfig(config: DatabaseConfig): Knex.Config {
  const dbType = detectDatabaseType(config);
  
  switch (dbType) {
    case 'sqlite': {
      let filename = config.filename || ':memory:';
      
      // Extract filename from sqlite:// URL
      if (config.connectionString && config.connectionString.startsWith('sqlite://')) {
        filename = config.connectionString.replace('sqlite://', '');
      }
      
      return {
        client: 'sqlite3',
        connection: {
          filename: filename
        },
        useNullAsDefault: true,
        migrations: {
          directory: './migrations'
        }
      };
    }
    
    case 'postgres':
      return {
        client: 'pg',
        connection: config.connectionString || {
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME || 'astreus',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres'
        },
        migrations: {
          directory: './migrations'
        }
      };
    
    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}