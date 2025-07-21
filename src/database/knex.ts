import { Knex } from 'knex';
import { DatabaseConfig } from './types';

export function createKnexConfig(config: DatabaseConfig): Knex.Config {
  switch (config.type) {
    case 'sqlite':
      return {
        client: 'sqlite3',
        connection: {
          filename: config.filename || ':memory:'
        },
        useNullAsDefault: true,
        migrations: {
          directory: './migrations'
        }
      };
    
    case 'postgres':
      return {
        client: 'pg',
        connection: config.connectionString || {
          host: 'localhost',
          port: 5432,
          database: 'astreus',
          user: 'postgres',
          password: 'postgres'
        },
        migrations: {
          directory: './migrations'
        }
      };
    
    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}