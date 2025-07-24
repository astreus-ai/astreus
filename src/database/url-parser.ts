import { DatabaseConfig } from './types';

export function parseDatabaseUrl(url: string): DatabaseConfig {
  // Validate input
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Database URL must be a non-empty string');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Invalid database URL format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
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
    (config.connection as DatabaseConfig['connection'] & { ssl?: boolean }).ssl = searchParams.get('ssl') === 'true';
  }
  
  if (searchParams.has('pool_min')) {
    config.pool = config.pool || {};
    const poolMin = parseInt(searchParams.get('pool_min')!);
    if (isNaN(poolMin) || poolMin < 0) {
      throw new Error('pool_min must be a valid non-negative integer');
    }
    config.pool.min = poolMin;
  }
  
  if (searchParams.has('pool_max')) {
    config.pool = config.pool || {};
    const poolMax = parseInt(searchParams.get('pool_max')!);
    if (isNaN(poolMax) || poolMax < 1) {
      throw new Error('pool_max must be a valid positive integer');
    }
    config.pool.max = poolMax;
  }

  // Validate pool configuration
  if (config.pool && config.pool.min !== undefined && config.pool.max !== undefined) {
    if (config.pool.min > config.pool.max) {
      throw new Error('pool_min cannot be greater than pool_max');
    }
  }

  return config;
}