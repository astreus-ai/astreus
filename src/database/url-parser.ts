import { DatabaseConfig } from './types';

export function parseDatabaseUrl(url: string): DatabaseConfig {
  const parsed = new URL(url);
  
  const protocol = parsed.protocol.replace(':', '');
  
  let client: string;
  switch (protocol) {
    case 'postgres':
    case 'postgresql':
      client = 'pg';
      break;
    case 'mysql':
      client = 'mysql2';
      break;
    case 'sqlite':
      client = 'sqlite3';
      return {
        client,
        connection: {
          filename: parsed.pathname
        }
      };
    default:
      throw new Error(`Unsupported database protocol: ${protocol}`);
  }

  const config: DatabaseConfig = {
    client,
    connection: {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : undefined,
      user: parsed.username || undefined,
      password: parsed.password || undefined,
      database: parsed.pathname.replace('/', '') || undefined
    }
  };

  // Handle query parameters for additional config
  const searchParams = parsed.searchParams;
  if (searchParams.has('ssl')) {
    (config.connection as any).ssl = searchParams.get('ssl') === 'true';
  }
  
  if (searchParams.has('pool_min')) {
    config.pool = config.pool || {};
    config.pool.min = parseInt(searchParams.get('pool_min')!);
  }
  
  if (searchParams.has('pool_max')) {
    config.pool = config.pool || {};
    config.pool.max = parseInt(searchParams.get('pool_max')!);
  }

  return config;
}