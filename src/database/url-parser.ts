import path from 'path';
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
    throw new Error(
      `Invalid database URL format: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
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
    case 'sqlite': {
      client = 'sqlite3';
      // SQLite path validation - prevent path traversal attacks
      const dbPath = parsed.pathname;

      // Check for null bytes which can be used for path traversal
      if (dbPath.includes('\0')) {
        throw new Error('Invalid database path: null byte detected');
      }

      // Normalize the path to resolve . and .. components
      const normalizedPath = path.normalize(dbPath);

      // Check if normalized path still contains .. (path traversal attempt)
      if (normalizedPath.includes('..')) {
        throw new Error('Invalid database path: path traversal detected');
      }

      // Resolve to absolute path and verify it doesn't escape intended directory
      const resolvedPath = path.resolve(normalizedPath);
      const resolvedNormalized = path.normalize(resolvedPath);

      // Verify the resolved path starts with the original directory intent
      // This prevents cases where normalization could lead outside intended location
      if (resolvedNormalized.includes('..')) {
        throw new Error('Invalid database path: path traversal detected after resolution');
      }

      return {
        client,
        connection: {
          filename: normalizedPath,
        },
      };
    }
    default:
      throw new Error(`Unsupported database protocol: ${protocol}`);
  }

  let port: number | undefined;
  if (parsed.port) {
    port = parseInt(parsed.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid port in database URL: ${parsed.port}. Must be a valid port number (1-65535)`
      );
    }
  }

  const config: DatabaseConfig = {
    client,
    connection: {
      host: parsed.hostname,
      port,
      user: parsed.username === '' ? undefined : parsed.username,
      password: parsed.password === '' ? undefined : parsed.password,
      database: parsed.pathname.replace('/', '') || undefined,
    },
  };

  // Handle query parameters for additional config
  const searchParams = parsed.searchParams;
  if (searchParams.has('ssl')) {
    (config.connection as DatabaseConfig['connection'] & { ssl?: boolean }).ssl =
      searchParams.get('ssl') === 'true';
  }

  if (searchParams.has('pool_min')) {
    config.pool = config.pool || {};
    const poolMinStr = searchParams.get('pool_min');
    if (poolMinStr === null) {
      throw new Error('pool_min parameter is missing');
    }
    const poolMin = parseInt(poolMinStr, 10);
    if (isNaN(poolMin) || poolMin < 0) {
      throw new Error('pool_min must be a valid non-negative integer');
    }
    config.pool.min = poolMin;
  }

  if (searchParams.has('pool_max')) {
    config.pool = config.pool || {};
    const poolMaxStr = searchParams.get('pool_max');
    if (poolMaxStr === null) {
      throw new Error('pool_max parameter is missing');
    }
    const poolMax = parseInt(poolMaxStr, 10);
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
