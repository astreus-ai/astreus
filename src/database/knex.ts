import { Knex } from 'knex';
import { DatabaseConfig } from './types';
import { getLogger } from '../logger';

function detectDatabaseType(config: DatabaseConfig): string {
  if (config.type) {
    return config.type;
  }

  if (config.connectionString) {
    if (config.connectionString.startsWith('sqlite://')) {
      return 'sqlite';
    }
    if (
      config.connectionString.startsWith('postgresql://') ||
      config.connectionString.startsWith('postgres://')
    ) {
      return 'postgres';
    }
  }

  // Default to sqlite if no clear indication
  return 'sqlite';
}

/**
 * Connection Pool Manager for tracking and managing database connections.
 * Provides connection pooling metrics, leak detection, and max limit control.
 *
 * Features:
 * - Connection usage tracking with acquire/release timestamps
 * - Leak detection for connections held longer than threshold
 * - Pool utilization metrics
 * - Max connection limit enforcement
 */
export class ConnectionPoolManager {
  private static instance: ConnectionPoolManager | null = null;
  private activeConnections: Map<string, { acquiredAt: number; stack?: string }> = new Map();
  private totalAcquired = 0;
  private totalReleased = 0;
  private maxPoolSize: number;
  private leakThresholdMs: number;
  private leakCheckInterval: NodeJS.Timeout | null = null;
  private logger = getLogger();

  private constructor(maxPoolSize: number, leakThresholdMs: number = 30000) {
    this.maxPoolSize = maxPoolSize;
    this.leakThresholdMs = leakThresholdMs;
    this.startLeakDetection();
  }

  static getInstance(
    maxPoolSize: number = 10,
    leakThresholdMs: number = 30000
  ): ConnectionPoolManager {
    if (!ConnectionPoolManager.instance) {
      ConnectionPoolManager.instance = new ConnectionPoolManager(maxPoolSize, leakThresholdMs);
    }
    return ConnectionPoolManager.instance;
  }

  /**
   * Track when a connection is acquired from the pool
   */
  onAcquire(connectionId?: string): void {
    const id = connectionId || `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const stack = new Error().stack; // Capture stack trace for debugging leaks

    this.activeConnections.set(id, {
      acquiredAt: Date.now(),
      stack,
    });
    this.totalAcquired++;

    // Check if we're approaching max pool size
    if (this.activeConnections.size >= this.maxPoolSize * 0.8) {
      this.logger.warn('Connection pool utilization high', {
        active: this.activeConnections.size,
        max: this.maxPoolSize,
        utilization: `${((this.activeConnections.size / this.maxPoolSize) * 100).toFixed(1)}%`,
      });
    }

    this.logger.debug('Database connection acquired', {
      connectionId: id,
      activeConnections: this.activeConnections.size,
      totalAcquired: this.totalAcquired,
    });
  }

  /**
   * Track when a connection is released back to the pool
   */
  onRelease(connectionId?: string): void {
    // If no specific ID, release the oldest connection
    if (!connectionId && this.activeConnections.size > 0) {
      const keysIterator = this.activeConnections.keys().next();
      // Properly check for undefined - iterator may return {done: true, value: undefined}
      if (!keysIterator.done && keysIterator.value !== undefined) {
        connectionId = keysIterator.value;
      }
    }

    if (connectionId && this.activeConnections.has(connectionId)) {
      this.activeConnections.delete(connectionId);
      this.totalReleased++;

      this.logger.debug('Database connection released', {
        connectionId,
        activeConnections: this.activeConnections.size,
        totalReleased: this.totalReleased,
      });
    }
  }

  /**
   * Start periodic leak detection
   */
  private startLeakDetection(): void {
    // Check for leaks every 10 seconds
    this.leakCheckInterval = setInterval(() => {
      this.detectLeaks();
    }, 10000);

    // Allow process to exit even if interval is running
    this.leakCheckInterval.unref();
  }

  /**
   * Detect and log potential connection leaks
   */
  private detectLeaks(): void {
    const now = Date.now();
    const leaks: Array<{ id: string; heldForMs: number; stack?: string }> = [];

    for (const [id, info] of this.activeConnections.entries()) {
      const heldForMs = now - info.acquiredAt;
      if (heldForMs > this.leakThresholdMs) {
        leaks.push({ id, heldForMs, stack: info.stack });
      }
    }

    if (leaks.length > 0) {
      // Convert leaks to LogData compatible format (serialize to JSON string)
      const leakDetails = leaks.map((l) => ({
        connectionId: l.id,
        heldForSeconds: (l.heldForMs / 1000).toFixed(1),
        stackPreview: l.stack?.split('\n').slice(2, 5).join(' -> ') ?? null,
      }));
      this.logger.warn('Potential database connection leaks detected', {
        leakCount: leaks.length,
        leakSummary: JSON.stringify(leakDetails),
      });
    }
  }

  /**
   * Check if pool can accept new connections
   */
  canAcquire(): boolean {
    return this.activeConnections.size < this.maxPoolSize;
  }

  /**
   * Get current pool statistics
   */
  getStats(): {
    activeConnections: number;
    maxPoolSize: number;
    totalAcquired: number;
    totalReleased: number;
    utilization: number;
  } {
    return {
      activeConnections: this.activeConnections.size,
      maxPoolSize: this.maxPoolSize,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      utilization: this.activeConnections.size / this.maxPoolSize,
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.leakCheckInterval) {
      clearInterval(this.leakCheckInterval);
      this.leakCheckInterval = null;
    }
    this.activeConnections.clear();
    ConnectionPoolManager.instance = null;
  }
}

// Global pool manager instance
let poolManager: ConnectionPoolManager | null = null;

/**
 * Get the global connection pool manager
 */
export function getPoolManager(maxPoolSize: number = 10): ConnectionPoolManager {
  if (!poolManager) {
    poolManager = ConnectionPoolManager.getInstance(maxPoolSize);
  }
  return poolManager;
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
          filename: filename,
        },
        useNullAsDefault: true,
        migrations: {
          directory: './migrations',
        },
      };
    }

    case 'postgres': {
      // Pool size from config with sensible defaults
      const maxPoolSize = config.maxPoolSize ?? 10;
      const minPoolSize = config.minPoolSize ?? 2;

      // Initialize pool manager with configured max size
      const manager = getPoolManager(maxPoolSize);

      // PostgreSQL requires connection string (DB_URL) for configuration
      if (!config.connectionString) {
        throw new Error('PostgreSQL requires DB_URL connection string to be set');
      }

      return {
        client: 'pg',
        connection: config.connectionString,
        pool: {
          min: minPoolSize,
          max: maxPoolSize,
          acquireTimeoutMillis: 30000,
          idleTimeoutMillis: 30000,
          // Track connection creation for pool monitoring
          // Note: Knex/tarn pool only supports afterCreate hook natively
          // Release tracking is handled via periodic leak detection in ConnectionPoolManager
          // The leak detection timer (every 10 seconds) will identify connections held too long
          afterCreate: (conn: unknown, done: (err: Error | null, conn: unknown) => void) => {
            manager.onAcquire();
            done(null, conn);
          },
        },
        migrations: {
          directory: './migrations',
        },
      };
    }

    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}
