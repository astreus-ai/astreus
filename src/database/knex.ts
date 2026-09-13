import { Knex } from 'knex';
import type { Pool } from 'tarn';
import { DatabaseConfig } from './types';
import { getLogger } from '../logger';
import type { Logger } from '../logger/types';

function detectDatabaseType(config: DatabaseConfig): string {
  if (config.type) return config.type;
  if (config.driver) return config.driver === 'pg' ? 'postgres' : config.driver;
  if (config.connectionString?.startsWith('sqlite://')) return 'sqlite';
  if (
    config.connectionString?.startsWith('postgresql://') ||
    config.connectionString?.startsWith('postgres://')
  ) {
    return 'postgres';
  }
  return 'sqlite';
}

interface ConnectionCheckout {
  id: number;
  acquiredAt: number;
  stack?: string;
}

/** Tracks successful checkouts, not the lifetime of physical pooled connections. */
export class ConnectionPoolManager {
  private static managers = new WeakMap<Pool<unknown>, ConnectionPoolManager>();
  private static destroyedPools = new WeakSet<Pool<unknown>>();
  private activeConnections = new Map<unknown, ConnectionCheckout>();
  private totalAcquired = 0;
  private totalReleased = 0;
  private totalDestroyed = 0;
  private leakCheckInterval: NodeJS.Timeout;
  private disposed = false;

  private constructor(
    private pool: Pool<unknown>,
    private maxPoolSize: number,
    private leakThresholdMs: number,
    private logger: Logger
  ) {
    pool.on('acquireSuccess', this.onAcquire);
    pool.on('release', this.onRelease);
    pool.on('destroySuccess', this.onDestroy);
    pool.on('poolDestroySuccess', this.onPoolDestroy);
    this.leakCheckInterval = setInterval(() => this.detectLeaks(), 10000);
    this.leakCheckInterval.unref();
  }

  static getInstance(
    pool: Pool<unknown>,
    maxPoolSize: number,
    leakThresholdMs: number = 30000,
    logger: Logger = getLogger()
  ): ConnectionPoolManager {
    if (this.destroyedPools.has(pool)) {
      throw new Error('Cannot monitor a disconnected database pool');
    }
    let manager = this.managers.get(pool);
    if (!manager) {
      manager = new ConnectionPoolManager(pool, maxPoolSize, leakThresholdMs, logger);
      this.managers.set(pool, manager);
    }
    return manager;
  }

  private onAcquire = (eventId: number, resource: unknown): void => {
    this.activeConnections.set(resource, {
      id: eventId,
      acquiredAt: Date.now(),
      stack: new Error().stack,
    });
    this.totalAcquired++;

    if (this.activeConnections.size >= this.maxPoolSize * 0.8) {
      this.logger.warn('Connection pool utilization high', {
        active: this.activeConnections.size,
        max: this.maxPoolSize,
        utilization: `${((this.activeConnections.size / this.maxPoolSize) * 100).toFixed(1)}%`,
      });
    }
  };

  private onRelease = (resource: unknown): void => {
    // Tarn emits release even for an unknown resource. Never guess which checkout ended.
    if (this.activeConnections.delete(resource)) this.totalReleased++;
  };

  private onDestroy = (_eventId: number, resource: unknown): void => {
    this.activeConnections.delete(resource);
    this.totalDestroyed++;
  };

  detectLeaks(): Array<{ id: number; heldForMs: number; stack?: string }> {
    const now = Date.now();
    const leaks = [...this.activeConnections.values()]
      .map(({ id, acquiredAt, stack }) => ({ id, heldForMs: now - acquiredAt, stack }))
      .filter(({ heldForMs }) => heldForMs > this.leakThresholdMs);

    if (leaks.length > 0) {
      this.logger.warn('Potential database connection leaks detected', {
        leakCount: leaks.length,
        leakSummary: JSON.stringify(
          leaks.map(({ id, heldForMs, stack }) => ({
            connectionId: id,
            heldForSeconds: (heldForMs / 1000).toFixed(1),
            stackPreview: stack?.split('\n').slice(2, 5).join(' -> ') ?? null,
          }))
        ),
      });
    }
    return leaks;
  }

  canAcquire(): boolean {
    return !this.disposed && this.activeConnections.size < this.maxPoolSize;
  }

  getStats(): {
    activeConnections: number;
    maxPoolSize: number;
    totalAcquired: number;
    totalReleased: number;
    totalDestroyed: number;
    utilization: number;
  } {
    return {
      activeConnections: this.activeConnections.size,
      maxPoolSize: this.maxPoolSize,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      totalDestroyed: this.totalDestroyed,
      utilization: this.activeConnections.size / this.maxPoolSize,
    };
  }

  private onPoolDestroy = (): void => {
    ConnectionPoolManager.destroyedPools.add(this.pool);
    this.destroy();
  };

  destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.leakCheckInterval);
    this.pool.removeListener('acquireSuccess', this.onAcquire);
    this.pool.removeListener('release', this.onRelease);
    this.pool.removeListener('destroySuccess', this.onDestroy);
    this.pool.removeListener('poolDestroySuccess', this.onPoolDestroy);
    this.activeConnections.clear();
    ConnectionPoolManager.managers.delete(this.pool);
  };
}

/** A manager belongs to exactly one live Knex/Tarn pool; no process-global fallback. */
export function getPoolManager(
  database: Knex,
  leakThresholdMs: number = 30000,
  logger: Logger = getLogger()
): ConnectionPoolManager {
  const pool = database.client.pool;
  if (!pool) throw new Error('Cannot monitor a disconnected database pool');
  const max: unknown = database.client.config.pool?.max;
  const maxPoolSize =
    typeof max === 'number' ? max : database.client.dialect === 'sqlite3' ? 1 : 10;
  return ConnectionPoolManager.getInstance(pool, maxPoolSize, leakThresholdMs, logger);
}

export function createKnexConfig(config: DatabaseConfig): Knex.Config {
  const dbType = detectDatabaseType(config);

  switch (dbType) {
    case 'sqlite': {
      const filename = config.connectionString?.startsWith('sqlite://')
        ? config.connectionString.slice('sqlite://'.length)
        : config.filename || ':memory:';
      return {
        client: 'sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        migrations: { directory: './migrations' },
      };
    }
    case 'postgres': {
      if (!config.connectionString) {
        throw new Error('PostgreSQL requires DB_URL connection string to be set');
      }
      return {
        client: 'pg',
        connection: config.connectionString,
        pool: {
          min: config.minPoolSize ?? 2,
          max: config.maxPoolSize ?? 10,
          acquireTimeoutMillis: 30000,
          idleTimeoutMillis: 30000,
        },
        migrations: { directory: './migrations' },
      };
    }
    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}
