import { IAgentModule, IAgent } from '../agent/types';
import { Memory as MemoryType, MemorySearchOptions } from './types';
import { getDatabase } from '../database';
import { MetadataObject } from '../types';
import { Logger } from '../logger/types';
import { DEFAULT_MEMORY_CONFIG } from './defaults';
import { Knex } from 'knex';
import { getEncryptionService } from '../database/encryption';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';
import { getLLM } from '../llm';

/**
 * Read-Write Lock for managing concurrent access to shared resources.
 * Supports multiple concurrent readers but exclusive writers.
 *
 * Features:
 * - Multiple concurrent readers allowed
 * - Writers have exclusive access (no concurrent readers/writers)
 * - Deadlock prevention via timeouts
 * - Starvation prevention via writer priority aging
 */
class ReadWriteLock {
  private readers = 0;
  private writer = false;
  private writerQueue: Array<{ resolve: () => void; enqueuedAt: number }> = [];
  private readerQueue: Array<{ resolve: () => void; enqueuedAt: number }> = [];
  private readonly lockTimeout: number;
  private readonly starvationThreshold: number;

  constructor(lockTimeout: number = 5000, starvationThreshold: number = 3000) {
    this.lockTimeout = lockTimeout;
    this.starvationThreshold = starvationThreshold;
  }

  /**
   * Acquire a read lock. Multiple readers can hold the lock simultaneously.
   * @throws Error if lock acquisition times out (deadlock prevention)
   */
  async acquireRead(): Promise<void> {
    const startTime = Date.now();

    // If there's a writer or waiting writers (to prevent writer starvation), wait
    while (this.writer || this.hasStarvedWriters()) {
      if (Date.now() - startTime > this.lockTimeout) {
        throw new Error(
          `Read lock acquisition timeout after ${this.lockTimeout}ms (deadlock prevention)`
        );
      }

      // Create queue entry with cleanup capability
      let queueEntry: { resolve: () => void; enqueuedAt: number } | null = null;

      await new Promise<void>((resolve, reject) => {
        queueEntry = { resolve, enqueuedAt: Date.now() };
        this.readerQueue.push(queueEntry);

        // Set up timeout cleanup to remove from queue if timeout occurs
        const timeoutId = setTimeout(
          () => {
            if (queueEntry) {
              const index = this.readerQueue.indexOf(queueEntry);
              if (index !== -1) {
                this.readerQueue.splice(index, 1);
              }
            }
            reject(
              new Error(
                `Read lock acquisition timeout after ${this.lockTimeout}ms (deadlock prevention)`
              )
            );
          },
          this.lockTimeout - (Date.now() - startTime)
        );

        // Override resolve to clear timeout
        const originalResolve = resolve;
        queueEntry.resolve = () => {
          clearTimeout(timeoutId);
          originalResolve();
        };
      });
    }

    this.readers++;
  }

  /**
   * Release a read lock.
   */
  releaseRead(): void {
    this.readers = Math.max(0, this.readers - 1);

    // If no more readers, wake up waiting writers
    if (this.readers === 0 && this.writerQueue.length > 0) {
      const next = this.writerQueue.shift();
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Acquire a write lock. Only one writer can hold the lock.
   * @throws Error if lock acquisition times out (deadlock prevention)
   */
  async acquireWrite(): Promise<void> {
    const startTime = Date.now();

    // Wait for all readers and current writer to finish
    while (this.readers > 0 || this.writer) {
      if (Date.now() - startTime > this.lockTimeout) {
        throw new Error(
          `Write lock acquisition timeout after ${this.lockTimeout}ms (deadlock prevention)`
        );
      }

      // Create queue entry with cleanup capability
      let queueEntry: { resolve: () => void; enqueuedAt: number } | null = null;

      await new Promise<void>((resolve, reject) => {
        queueEntry = { resolve, enqueuedAt: Date.now() };
        this.writerQueue.push(queueEntry);

        // Set up timeout cleanup to remove from queue if timeout occurs
        const timeoutId = setTimeout(
          () => {
            if (queueEntry) {
              const index = this.writerQueue.indexOf(queueEntry);
              if (index !== -1) {
                this.writerQueue.splice(index, 1);
              }
            }
            reject(
              new Error(
                `Write lock acquisition timeout after ${this.lockTimeout}ms (deadlock prevention)`
              )
            );
          },
          this.lockTimeout - (Date.now() - startTime)
        );

        // Override resolve to clear timeout
        const originalResolve = resolve;
        queueEntry.resolve = () => {
          clearTimeout(timeoutId);
          originalResolve();
        };
      });
    }

    this.writer = true;
  }

  /**
   * Release a write lock.
   * Uses writer priority to prevent writer starvation:
   * - If writers are waiting, wake up the next writer first
   * - Only wake up readers if no writers are waiting
   */
  releaseWrite(): void {
    this.writer = false;

    // Writer priority: Check waiting writers first to prevent starvation
    if (this.writerQueue.length > 0) {
      const next = this.writerQueue.shift();
      if (next) {
        next.resolve();
        return; // Don't wake up readers when a writer is taking over
      }
    }

    // No waiting writers, wake up all waiting readers (they can proceed in parallel)
    while (this.readerQueue.length > 0) {
      const next = this.readerQueue.shift();
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Check if there are writers that have been waiting too long (starvation prevention)
   */
  private hasStarvedWriters(): boolean {
    if (this.writerQueue.length === 0) return false;
    const now = Date.now();
    return this.writerQueue.some((w) => now - w.enqueuedAt > this.starvationThreshold);
  }

  /**
   * Get current lock status
   */
  getStatus(): {
    readers: number;
    hasWriter: boolean;
    pendingWriters: number;
    pendingReaders: number;
  } {
    return {
      readers: this.readers,
      hasWriter: this.writer,
      pendingWriters: this.writerQueue.length,
      pendingReaders: this.readerQueue.length,
    };
  }
}

/**
 * Simple async mutex for protecting initialization.
 * Replaces spin-wait anti-pattern with proper promise-based waiting.
 * Includes deadlock prevention via timeouts.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly lockTimeout: number;

  constructor(lockTimeout: number = 10000) {
    this.lockTimeout = lockTimeout;
  }

  /**
   * Acquire the mutex with timeout for deadlock prevention
   * @throws Error if lock acquisition times out
   */
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.queue.findIndex((item) => item.resolve === resolve);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(
          new Error(`Mutex acquisition timeout after ${this.lockTimeout}ms (deadlock prevention)`)
        );
      }, this.lockTimeout);

      this.queue.push({
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject,
      });
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}

interface MemoryDbRow {
  id: string; // UUID
  agentId: string; // UUID
  graphId?: string; // UUID - Graph relationship
  taskId?: string; // UUID - Task relationship
  sessionId?: string; // Session ID
  content: string;
  embedding: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Callback type for memory change events
 */
export type MemoryChangeCallback = (
  event: 'update' | 'delete' | 'clear',
  data: { memoryId?: string; content?: string; metadata?: MetadataObject }
) => void | Promise<void>;

/**
 * Memory module for agent conversation memory
 *
 * Features:
 * - Read-write locking for concurrent access
 * - Deadlock prevention via lock timeouts
 * - Starvation prevention for write operations
 */
export class Memory implements IAgentModule {
  readonly name = 'memory';
  private knex: Knex | null = null;
  private logger: Logger;
  private _encryption?: ReturnType<typeof getEncryptionService>;
  private static readonly MAX_MEMORIES_FETCH = 10000; // Bounds limit for unbounded fetches

  // AsyncMutex pattern for race condition prevention (replaces spin-wait)
  private static initMutex = new AsyncMutex();
  private static initPromise: Promise<void> | null = null;

  // Read-write lock for concurrent memory access
  // Allows multiple concurrent reads but exclusive writes
  private rwLock = new ReadWriteLock(5000, 3000);

  // Callback for memory change events (used by Agent to sync with Context)
  private onChangeCallback: MemoryChangeCallback | null = null;

  private get encryption() {
    if (!this._encryption) {
      this._encryption = getEncryptionService();
    }
    return this._encryption;
  }

  constructor(private agent: IAgent) {
    this.logger = agent.logger;
  }

  /**
   * Register a callback for memory change events
   * This allows the Agent to synchronize Context when memories are updated/deleted
   */
  onMemoryChange(callback: MemoryChangeCallback): void {
    this.onChangeCallback = callback;
  }

  /**
   * Notify registered callback about memory changes
   */
  private async notifyChange(
    event: 'update' | 'delete' | 'clear',
    data: { memoryId?: string; content?: string; metadata?: MetadataObject }
  ): Promise<void> {
    if (this.onChangeCallback) {
      try {
        await this.onChangeCallback(event, data);
      } catch (error) {
        this.logger.warn('Memory change callback failed', {
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async initialize(): Promise<void> {
    await this.ensureDatabase();
  }

  private async ensureDatabase(): Promise<void> {
    if (this.knex) return;

    // Check if another instance is already initializing
    if (Memory.initPromise) {
      await Memory.initPromise;
      // After waiting, get the knex instance from the initialized database
      const db = await getDatabase();
      this.knex = db.getKnex();
      return;
    }

    // Use AsyncMutex instead of spin-wait for proper synchronization
    await Memory.initMutex.acquire();
    let lockReleased = false;
    try {
      // Double-check after acquiring lock
      if (this.knex) return;

      // Check again if initialization started while waiting for lock
      if (Memory.initPromise) {
        // Release lock before awaiting to prevent deadlock
        Memory.initMutex.release();
        lockReleased = true;
        await Memory.initPromise;
        const db = await getDatabase();
        this.knex = db.getKnex();
        return;
      }

      // Start initialization
      Memory.initPromise = this.doInitialize();
      try {
        await Memory.initPromise;
      } finally {
        Memory.initPromise = null;
      }
    } finally {
      // Only release if not already released
      if (!lockReleased) {
        Memory.initMutex.release();
      }
    }
  }

  private async doInitialize(): Promise<void> {
    const db = await getDatabase();
    this.knex = db.getKnex();
  }

  /**
   * Generate embedding for memory content
   */
  private async generateEmbedding(content: string): Promise<number[] | null> {
    try {
      // Import knowledge system to access embedding generation

      // Check if agent has knowledge/embedding capabilities
      if (!this.agent || typeof this.agent.config.embeddingModel !== 'string') {
        this.logger.debug('No embedding model configured for agent, skipping embedding generation');
        return null;
      }

      // Get embedding provider from knowledge system
      // This is a bit indirect but reuses existing embedding infrastructure
      const embeddingProvider = {
        name: this.agent.config.embeddingModel || DEFAULT_MEMORY_CONFIG.defaultEmbeddingModel,
        generateEmbedding: async (text: string) => {
          // Import and use the same embedding logic as knowledge system
          const llm = getLLM(this.logger);
          const result = await llm.generateEmbedding(text, this.agent.config.embeddingModel);
          return result;
        },
      };

      const result = await embeddingProvider.generateEmbedding(content);
      return result.embedding;
    } catch (error) {
      this.logger.debug('Failed to generate embedding for memory', {
        error: error instanceof Error ? error.message : String(error),
        contentLength: content.length,
      });
      return null;
    }
  }

  /**
   * Add a memory
   */
  async addMemory(
    content: string,
    metadata?: MetadataObject,
    context?: { graphId?: string; taskId?: string; sessionId?: string }
  ): Promise<MemoryType> {
    // User-facing info log
    const memoryType = metadata?.type || 'general';
    this.logger.info(`Adding new ${memoryType} memory`);

    this.logger.debug('Adding memory', {
      contentLength: content.length,
      agentId: this.agent.id,
      graphId: context?.graphId || 'none',
      taskId: context?.taskId || 'none',
      sessionId: context?.sessionId || 'none',
      contentPreview: content.slice(0, 100) + '...',
      type: metadata?.type ? String(metadata.type) : 'general',
      hasMetadata: !!metadata,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    // Generate embedding for content (before encryption)
    const embedding = await this.generateEmbedding(content);

    // Prepare data for encryption
    const insertData = {
      id: crypto.randomUUID(), // Generate UUID for memory
      agentId: this.agent.id,
      graphId: context?.graphId || null, // Graph relationship
      taskId: context?.taskId || null, // Task relationship
      sessionId: context?.sessionId || null, // Session ID
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Acquire write lock for exclusive access during insert
    await this.rwLock.acquireWrite();
    try {
      // Encrypt sensitive fields using centralized encryption (embedding stays unencrypted for search)
      const encryptedData = await encryptSensitiveFields(insertData, 'memories');

      // Use transaction for atomicity - ensures data consistency
      const memory = await this.knex.transaction(async (trx) => {
        const [inserted] = await trx(tableName).insert(encryptedData).returning('*');
        return inserted;
      });

      // Decrypt for response using centralized decryption
      const decryptedMemory = await decryptSensitiveFields(
        memory as Record<string, string | number | boolean | null>,
        'memories'
      );
      const formattedMemory = this.formatMemory(decryptedMemory as unknown as MemoryDbRow);

      this.logger.debug('Memory added successfully', {
        memoryId: formattedMemory.id || 0,
        type: String(memoryType),
      });

      return formattedMemory;
    } finally {
      this.rwLock.releaseWrite();
    }
  }

  /**
   * Remember a conversation (alias for add with conversation metadata)
   */
  async rememberConversation(
    content: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<MemoryType> {
    return this.addMemory(content, { type: 'conversation', role });
  }

  /**
   * Get a memory by ID
   */
  async getMemory(id: string): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Acquire read lock for concurrent read access
    await this.rwLock.acquireRead();
    try {
      const memory = await this.knex(tableName).where({ id, agentId: this.agent.id }).first();

      if (!memory) return null;

      // Decrypt sensitive fields using centralized decryption
      const decryptedMemory = await decryptSensitiveFields(
        memory as Record<string, string | number | boolean | null>,
        'memories'
      );
      return this.formatMemory(decryptedMemory as unknown as MemoryDbRow);
    } finally {
      this.rwLock.releaseRead();
    }
  }

  /**
   * Search memories
   */
  async searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryType[]> {
    // Check if we should use embedding search
    if (options?.useEmbedding !== false) {
      // Try embedding search first, fallback to text search if needed
      try {
        return await this.searchMemoriesBySimilarity(query, options);
      } catch (error) {
        this.logger.warn('Embedding search failed, falling back to text search', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // User-facing info log
    this.logger.info(`Searching memories for: "${query}"`);

    this.logger.debug('Searching memories', {
      query,
      ...(options?.limit && { limit: options.limit }),
      ...(options?.startDate && { startDate: options.startDate }),
      ...(options?.endDate && { endDate: options.endDate }),
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    let dbQuery = this.knex(tableName)
      .where({ agentId: this.agent.id })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Apply graphId/taskId/sessionId filters for memory isolation
    if (options?.graphId !== undefined) {
      dbQuery = dbQuery.andWhere({ graphId: options.graphId });
    }

    if (options?.taskId !== undefined) {
      dbQuery = dbQuery.andWhere({ taskId: options.taskId });
    }

    if (options?.sessionId !== undefined) {
      dbQuery = dbQuery.andWhere({ sessionId: options.sessionId });
    }

    // When encryption is enabled, we can't search encrypted content directly in SQL
    // We need to retrieve all memories and search after decryption
    if (this.encryption.isEnabled()) {
      // Remove the SQL LIKE search and do it in memory after decryption
      if (options?.startDate) {
        dbQuery = dbQuery.where('created_at', '>=', options.startDate);
      }

      if (options?.endDate) {
        dbQuery = dbQuery.where('created_at', '<=', options.endDate);
      }

      // Get all memories for this agent (with date filters if applicable)
      // Apply bounds limit to prevent unbounded memory growth
      const allMemories = await dbQuery.limit(Memory.MAX_MEMORIES_FETCH);

      // Decrypt and search in memory
      const matchingMemories: Record<
        string,
        string | number | boolean | Date | null | undefined
      >[] = [];
      for (const memory of allMemories) {
        try {
          const decryptedMemory = await decryptSensitiveFields(memory, 'memories');
          if (
            decryptedMemory.content &&
            typeof decryptedMemory.content === 'string' &&
            decryptedMemory.content.toLowerCase().includes(query.toLowerCase())
          ) {
            matchingMemories.push(decryptedMemory);
            if (matchingMemories.length >= limit) break;
          }
        } catch {
          // Handle unencrypted data gracefully - skip on decryption failure
          this.logger.warn('Failed to decrypt memory during search, skipping', {
            memoryId: memory.id,
          });
        }
      }

      // User-facing result summary
      this.logger.info(
        `Found ${matchingMemories.length} matching ${matchingMemories.length === 1 ? 'memory' : 'memories'}`
      );

      this.logger.debug(`Found ${matchingMemories.length} memories`, {
        resultCount: matchingMemories.length,
        sampleIds: matchingMemories.slice(0, 3).map((m) => Number(m.id)),
        hasResults: matchingMemories.length > 0,
      });

      return matchingMemories.map((memory) => this.formatMemory(memory as unknown as MemoryDbRow));
    } else {
      // Encryption not enabled, use traditional SQL search
      // Escape special SQL LIKE characters to prevent injection
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      dbQuery = dbQuery.where('content', 'like', `%${escapedQuery}%`);

      if (options?.startDate) {
        dbQuery = dbQuery.where('created_at', '>=', options.startDate);
      }

      if (options?.endDate) {
        dbQuery = dbQuery.where('created_at', '<=', options.endDate);
      }

      const memories = await dbQuery;

      // User-facing result summary
      this.logger.info(
        `Found ${memories.length} matching ${memories.length === 1 ? 'memory' : 'memories'}`
      );

      this.logger.debug(`Found ${memories.length} memories`, {
        resultCount: memories.length,
        sampleIds: memories.slice(0, 3).map((m) => Number(m.id)),
        hasResults: memories.length > 0,
      });

      return memories.map((memory) => this.formatMemory(memory));
    }
  }

  /**
   * List memories
   */
  async listMemories(options?: MemorySearchOptions): Promise<MemoryType[]> {
    // User-facing info log
    this.logger.info('Listing memories');

    this.logger.debug('Listing memories', {
      ...(options?.limit && { limit: options.limit }),
      ...(options?.graphId && { graphId: options.graphId }),
      ...(options?.taskId && { taskId: options.taskId }),
      ...(options?.sessionId && { sessionId: options.sessionId }),
      ...(options?.orderBy && { orderBy: options.orderBy }),
      ...(options?.startDate && { startDate: options.startDate }),
      ...(options?.endDate && { endDate: options.endDate }),
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    // Respect orderBy and order options, default to created_at desc
    // Map TypeScript property names to database column names
    let orderColumn = 'created_at';
    if (options?.orderBy === 'createdAt') {
      orderColumn = 'created_at';
    } else if (options?.orderBy === 'updatedAt') {
      orderColumn = 'updated_at';
    }
    const orderDirection = options?.order === 'asc' ? 'asc' : 'desc';

    let query = this.knex(tableName)
      .where({ agentId: this.agent.id })
      .orderBy(orderColumn, orderDirection)
      .limit(limit)
      .offset(offset);

    if (options?.graphId !== undefined) {
      query = query.andWhere({ graphId: options.graphId });
    }

    if (options?.taskId !== undefined) {
      query = query.andWhere({ taskId: options.taskId });
    }

    if (options?.sessionId !== undefined) {
      query = query.andWhere({ sessionId: options.sessionId });
    }

    if (options?.startDate) {
      query = query.where('created_at', '>=', options.startDate);
    }

    if (options?.endDate) {
      query = query.where('created_at', '<=', options.endDate);
    }

    const memories = await query;

    // Decrypt memories if encryption is enabled
    if (this.encryption.isEnabled()) {
      const decryptedMemories = await Promise.all(
        memories.map(async (memory) => {
          try {
            const decrypted = await decryptSensitiveFields(
              memory as Record<string, string | number | boolean | null>,
              'memories'
            );
            return this.formatMemory(decrypted as unknown as MemoryDbRow);
          } catch {
            // Handle unencrypted data gracefully
            this.logger.warn('Failed to decrypt memory during list, returning raw data', {
              memoryId: memory.id,
            });
            return this.formatMemory(memory);
          }
        })
      );
      return decryptedMemories;
    } else {
      return memories.map((memory) => this.formatMemory(memory));
    }
  }

  /**
   * Update a memory
   */
  async updateMemory(
    id: string,
    updates: { content?: string; metadata?: MetadataObject }
  ): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';

    const updateData: Partial<MemoryDbRow> = {};

    // If content is being updated, regenerate embedding
    if (updates.content !== undefined) {
      updateData.content = updates.content;
      // Generate new embedding for updated content
      const embedding = await this.generateEmbedding(updates.content);
      updateData.embedding = embedding ? JSON.stringify(embedding) : null;
    }

    if (updates.metadata !== undefined) {
      updateData.metadata = JSON.stringify(updates.metadata);
    }

    if (Object.keys(updateData).length === 0) {
      return this.getMemory(id);
    }

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Acquire write lock for exclusive access during update
    await this.rwLock.acquireWrite();
    try {
      // Encrypt sensitive fields using centralized encryption (embedding stays unencrypted)
      const encryptedUpdateData = await encryptSensitiveFields(updateData, 'memories');

      const [memory] = await this.knex(tableName)
        .where({ id, agentId: this.agent.id })
        .update(encryptedUpdateData)
        .returning('*');

      if (!memory) return null;

      // Decrypt for response using centralized decryption
      const decryptedMemory = await decryptSensitiveFields(
        memory as Record<string, string | number | boolean | null>,
        'memories'
      );
      const formattedMemory = this.formatMemory(decryptedMemory as unknown as MemoryDbRow);

      // Notify listeners about the update (for Context synchronization)
      await this.notifyChange('update', {
        memoryId: id,
        content: formattedMemory.content,
        metadata: formattedMemory.metadata,
      });

      return formattedMemory;
    } finally {
      this.rwLock.releaseWrite();
    }
  }

  /**
   * Delete a memory
   */
  async deleteMemory(id: string): Promise<boolean> {
    this.logger.info(`Deleting memory: ${id}`);

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Acquire write lock for exclusive access during delete
    await this.rwLock.acquireWrite();
    try {
      const deleted = await this.knex(tableName).where({ id, agentId: this.agent.id }).delete();

      const success = deleted > 0;

      if (success) {
        this.logger.info(`Memory ${id} deleted successfully`);

        // Notify listeners about the deletion (for Context synchronization)
        await this.notifyChange('delete', { memoryId: id });
      } else {
        this.logger.warn(`Failed to delete memory ${id} - not found or unauthorized`);
      }

      this.logger.debug('Delete memory result', {
        memoryId: id,
        success,
        agentId: this.agent.id,
      });

      return success;
    } finally {
      this.rwLock.releaseWrite();
    }
  }

  /**
   * Search memories using vector similarity with pagination to prevent memory leaks
   */
  async searchMemoriesBySimilarity(
    query: string,
    options?: MemorySearchOptions
  ): Promise<MemoryType[]> {
    // User-facing info log
    this.logger.info(`Searching memories by similarity for: "${query}"`);

    this.logger.debug('Vector similarity search for memories', {
      query,
      threshold: options?.similarityThreshold || 0.7,
      limit: options?.limit || 10,
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Generate embedding for search query
    const queryEmbedding = await this.generateEmbedding(query);

    if (!queryEmbedding) {
      this.logger.warn('Could not generate embedding for query, falling back to text search');
      return this.searchMemories(query, { ...options, useEmbedding: false });
    }

    const limit = options?.limit ?? 10;
    const threshold = options?.similarityThreshold ?? 0.7;
    const pageSize = options?.pageSize || 100;

    // For SQLite: Calculate similarity in memory with pagination (prevents memory leak)
    // For PostgreSQL: Use pgvector for efficient similarity search
    const memoriesWithSimilarity: Array<{
      memory: MemoryDbRow;
      similarity: number;
    }> = [];
    let offset = 0;
    let hasMore = true;

    // Paginated fetch to prevent loading all memories into memory at once
    while (hasMore && memoriesWithSimilarity.length < limit * 10) {
      const batch = await this.knex(tableName)
        .where({ agentId: this.agent.id })
        .whereNotNull('embedding')
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      if (batch.length < pageSize) {
        hasMore = false;
      }

      // Process batch and calculate similarities
      for (const memory of batch) {
        if (!memory.embedding) continue;

        try {
          const memoryEmbedding = JSON.parse(memory.embedding);
          const similarity = this.cosineSimilarity(queryEmbedding, memoryEmbedding);

          if (similarity >= threshold) {
            memoriesWithSimilarity.push({ memory, similarity });
          }
        } catch {
          this.logger.debug('Failed to parse embedding for memory', { memoryId: memory.id });
        }
      }

      offset += pageSize;

      // Early exit if we have enough high-similarity results
      if (memoriesWithSimilarity.length >= limit * 2) {
        break;
      }
    }

    // Sort by similarity and take top results
    const topResults = memoriesWithSimilarity
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Decrypt and format results
    const decryptedMemories = await Promise.all(
      topResults.map(async ({ memory }) => {
        try {
          const decrypted = await decryptSensitiveFields(
            memory as unknown as Record<string, string | number | boolean | null>,
            'memories'
          );
          return this.formatMemory(decrypted as unknown as MemoryDbRow);
        } catch {
          this.logger.debug('Failed to decrypt memory during similarity search', {
            memoryId: memory.id,
          });
          return this.formatMemory(memory);
        }
      })
    );

    // User-facing result summary
    this.logger.info(
      `Found ${decryptedMemories.length} similar ${decryptedMemories.length === 1 ? 'memory' : 'memories'}`
    );

    this.logger.debug(`Vector similarity search completed`, {
      resultCount: decryptedMemories.length,
      sampleIds: decryptedMemories.slice(0, 3).map((m) => Number(m.id)),
      hasResults: decryptedMemories.length > 0,
    });

    return decryptedMemories;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @throws Error if embedding dimensions do not match
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Generate embedding for a specific memory
   */
  async generateEmbeddingForMemory(memoryId: string): Promise<{
    success: boolean;
    message: string;
    embedding?: number[];
  }> {
    this.logger.info(`Generating embedding for memory: ${memoryId}`);

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Get memory by ID
    const memory = await this.knex(tableName)
      .where({ id: memoryId, agentId: this.agent.id })
      .first();

    if (!memory) {
      this.logger.debug('Memory not found for embedding generation', {
        memoryId,
        agentId: this.agent.id,
      });
      return {
        success: false,
        message: 'Memory not found',
      };
    }

    // Check if memory already has embedding
    if (memory.embedding) {
      this.logger.debug('Memory already has embedding', { memoryId });
      return {
        success: false,
        message: 'Memory already has embedding',
      };
    }

    // Decrypt content for embedding generation using centralized decryption
    let content: string;
    try {
      const decryptedMemory = await decryptSensitiveFields(
        memory as Record<string, string | number | boolean | null>,
        'memories'
      );
      content = String(decryptedMemory.content);
    } catch (error) {
      this.logger.debug('Failed to decrypt memory content', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: 'Failed to decrypt memory content',
      };
    }

    // Generate embedding for the content
    const embedding = await this.generateEmbedding(content);

    if (!embedding) {
      this.logger.debug('Failed to generate embedding', {
        memoryId,
        contentLength: content.length,
      });
      return {
        success: false,
        message: 'Failed to generate embedding',
      };
    }

    // Update memory with embedding
    try {
      await this.knex(tableName)
        .where({ id: memoryId, agentId: this.agent.id })
        .update({ embedding: JSON.stringify(embedding) });

      this.logger.info(`Embedding generated successfully for memory: ${memoryId}`);

      this.logger.debug('Embedding generation completed', {
        memoryId,
        embeddingDimensions: embedding.length,
        contentLength: content.length,
      });

      return {
        success: true,
        message: 'Embedding generated successfully',
        embedding,
      };
    } catch (error) {
      this.logger.debug('Failed to update memory with embedding', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: 'Failed to store embedding',
      };
    }
  }

  /**
   * Clear all memories
   * @param options - Optional settings for clearing memories
   * @param options.syncWithContext - If true (default), notifies Context to also clear. Set to false to clear only Memory.
   */
  async clearMemories(options?: { syncWithContext?: boolean }): Promise<number> {
    this.logger.info('Clearing all memories');

    await this.ensureDatabase();
    const tableName = 'memories';

    if (!this.knex) {
      throw new Error('Database not initialized');
    }

    // Acquire write lock for exclusive access during bulk delete
    await this.rwLock.acquireWrite();
    try {
      const deletedCount = await this.knex(tableName).where({ agentId: this.agent.id }).delete();

      this.logger.info(`Cleared ${deletedCount} ${deletedCount === 1 ? 'memory' : 'memories'}`);

      this.logger.debug('Clear memories result', {
        deletedCount,
        agentId: this.agent.id,
        syncWithContext: options?.syncWithContext !== false,
      });

      // Notify listeners about the clear operation (for Context synchronization)
      // Default: sync with context. Set syncWithContext: false to skip.
      if (deletedCount > 0 && options?.syncWithContext !== false) {
        await this.notifyChange('clear', {});
      }

      return deletedCount;
    } finally {
      this.rwLock.releaseWrite();
    }
  }

  /**
   * Format memory from database
   */
  private formatMemory(memory: MemoryDbRow): MemoryType {
    let parsedEmbedding: number[] | undefined;
    let parsedMetadata: MetadataObject | undefined;

    // Parse embedding with error handling
    if (memory.embedding) {
      try {
        parsedEmbedding =
          typeof memory.embedding === 'string' ? JSON.parse(memory.embedding) : memory.embedding;
      } catch {
        this.logger.debug('Failed to parse embedding JSON', { memoryId: memory.id });
        parsedEmbedding = undefined;
      }
    }

    // Parse metadata with error handling
    if (memory.metadata) {
      try {
        parsedMetadata =
          typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : memory.metadata;
      } catch {
        this.logger.debug('Failed to parse metadata JSON', { memoryId: memory.id });
        parsedMetadata = undefined;
      }
    }

    return {
      id: memory.id,
      agentId: memory.agentId,
      graphId: memory.graphId,
      taskId: memory.taskId,
      sessionId: memory.sessionId,
      content: memory.content,
      embedding: parsedEmbedding,
      metadata: parsedMetadata,
      createdAt: new Date(memory.created_at),
      updatedAt: new Date(memory.updated_at),
    };
  }

  /**
   * Destroy Memory module and free resources.
   * Call this when the module is no longer needed.
   */
  async destroy(): Promise<void> {
    // Clear the memory change callback to prevent memory leaks
    this.onChangeCallback = null;

    // Clear the knex reference (shared database, don't close)
    this.knex = null;

    // Clear the encryption service reference
    this._encryption = undefined;
  }
}

// Export types
export type { Memory as MemoryType, MemorySearchOptions } from './types';
