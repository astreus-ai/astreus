import {
  ContextManager as IContextManager,
  ContextMessage,
  ContextWindow,
  ContextAnalysis,
  CompressionResult,
  ContextCompressorOptions,
  ContextSummary,
} from './types';
import { MetadataObject } from '../types';
import { ContextCompressor } from './compressor';
import { ContextStorage } from './storage';
import { DEFAULT_CONTEXT_OPTIONS } from './defaults';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { getLLM } from '../llm';
import { getDatabase } from '../database';

// Maximum number of messages to prevent unbounded growth
const MAX_MESSAGE_COUNT = 10000;

/**
 * Callback type for compression events
 * This allows Memory module to be notified when context compression occurs
 */
export type CompressionCallback = (info: {
  originalMessageCount: number;
  compressedMessageCount: number;
  messagesRemoved: number;
  tokensReduced: number;
  strategy: string;
}) => void | Promise<void>;

/**
 * Callback type for context clear events
 * This allows Memory module to be notified when context is cleared
 */
export type ContextClearCallback = () => void | Promise<void>;

export class ContextManager implements IContextManager {
  private messages: ContextMessage[] = [];
  private compressor: ContextCompressor;
  private storage: ContextStorage | null = null;
  private logger: Logger;
  private maxTokens: number;
  private autoCompress: boolean;
  private model: string;
  private agentId: string | null = null;
  private isDirty: boolean = false; // Track if context needs saving
  private isCompressing: boolean = false; // Mutex for compression operations
  private pendingOperations: Promise<void> = Promise.resolve(); // Queue for serializing operations
  private operationLock: boolean = false; // Mutex for message operations

  // Callback for compression events (used by Agent to notify Memory)
  private onCompressionCallback: CompressionCallback | null = null;

  // Callback for context clear events (used by Agent to sync with Memory)
  private onClearCallback: ContextClearCallback | null = null;

  constructor(options: ContextCompressorOptions & { autoCompress?: boolean } = {}) {
    this.logger = getLogger();
    this.compressor = new ContextCompressor(options);
    this.maxTokens = options.maxContextLength ?? DEFAULT_CONTEXT_OPTIONS.maxContextLength ?? 8000;
    this.autoCompress = options.autoCompress ?? true;
    // Use provided model or context compression model as fallback
    this.model = options.model ?? DEFAULT_CONTEXT_OPTIONS.model ?? 'gpt-4o-mini';

    this.logger.debug('ContextManager initialized', {
      maxTokens: this.maxTokens,
      autoCompress: this.autoCompress,
      model: this.model,
    });
  }

  /**
   * Register a callback for compression events
   * This allows the Agent to notify Memory when context compression occurs
   */
  onCompression(callback: CompressionCallback): void {
    this.onCompressionCallback = callback;
  }

  /**
   * Register a callback for context clear events
   * This allows the Agent to sync Memory when context is cleared
   */
  onContextClear(callback: ContextClearCallback): void {
    this.onClearCallback = callback;
  }

  /**
   * Notify registered callback about compression events
   */
  private async notifyCompression(info: {
    originalMessageCount: number;
    compressedMessageCount: number;
    messagesRemoved: number;
    tokensReduced: number;
    strategy: string;
  }): Promise<void> {
    if (this.onCompressionCallback) {
      try {
        await this.onCompressionCallback(info);
      } catch (error) {
        this.logger.warn('Compression callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Initialize storage and load context for a specific agent
   */
  async initializeForAgent(agentId: string): Promise<void> {
    this.agentId = agentId;

    try {
      const db = await getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }
      this.storage = new ContextStorage(db.getKnex(), this.logger);

      // Load existing context from storage
      const storedContext = await this.storage.loadContext(agentId);
      if (storedContext) {
        this.messages = storedContext.contextData;
        this.logger.info('Context loaded from storage', {
          agentId,
          messagesCount: this.messages.length,
          tokensUsed: storedContext.tokensUsed,
        });
      } else {
        this.logger.debug('No stored context found, starting fresh', { agentId });
      }

      this.isDirty = false;
    } catch (error) {
      this.logger.warn('Failed to initialize context storage', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without storage - fallback to in-memory only
      this.storage = null;
    }
  }

  /**
   * Save current context to storage
   */
  async saveToStorage(): Promise<void> {
    if (!this.storage || !this.agentId || !this.isDirty) {
      return;
    }

    try {
      const tokensUsed = this.compressor.calculateTotalTokens(this.messages);

      // Check if any messages are compressed summaries
      const hasCompressedMessages = this.messages.some(
        (msg) => msg.metadata?.type === 'summary' || msg.metadata?.compressed === true
      );

      await this.storage.saveContext({
        agentId: this.agentId,
        contextData: this.messages,
        tokensUsed,
        compressionVersion: hasCompressedMessages ? 'hybrid' : undefined,
      });

      this.isDirty = false;
      this.logger.debug('Context saved to storage', {
        agentId: this.agentId,
        messagesCount: this.messages.length,
        tokensUsed,
        hasCompression: hasCompressedMessages,
      });
    } catch (error) {
      this.logger.warn('Failed to save context to storage', {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Queue for waiting lock requesters (proper mutex instead of spin-wait)
  private lockQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  /**
   * Acquire operation lock with timeout (proper mutex, no spin-wait)
   * Includes deadlock prevention via timeouts
   */
  private async acquireLock(timeoutMs: number = 5000): Promise<boolean> {
    // Fast path: lock is free
    if (!this.operationLock) {
      this.operationLock = true;
      return true;
    }

    // Wait in queue (proper promise-based waiting, not spin-wait)
    return new Promise<boolean>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.lockQueue.findIndex((item) => item.resolve === wrappedResolve);
        if (index !== -1) {
          this.lockQueue.splice(index, 1);
        }
        this.logger.warn(
          'Failed to acquire operation lock - timeout reached (deadlock prevention)',
          {
            timeoutMs,
            queueLength: this.lockQueue.length,
          }
        );
        resolve(false);
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timeoutId);
        resolve(true);
      };

      this.lockQueue.push({
        resolve: wrappedResolve,
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });
    });
  }

  /**
   * Release operation lock and wake up next waiter
   */
  private releaseLock(): void {
    const next = this.lockQueue.shift();
    if (next) {
      // Pass lock to next waiter
      next.resolve();
    } else {
      // No waiters, unlock
      this.operationLock = false;
    }
  }

  /**
   * Add a message to the context
   */
  async addMessage(message: ContextMessage): Promise<void> {
    // Queue this operation to prevent race conditions
    this.pendingOperations = this.pendingOperations
      .then(async () => {
        // Acquire mutex lock
        const lockAcquired = await this.acquireLock();
        if (!lockAcquired) {
          this.logger.error('Failed to add message - could not acquire lock');
          return;
        }

        try {
          // Validate and normalize content
          if (message.content === null || message.content === undefined) {
            message.content = '';
          }

          // Add timestamp if not provided
          if (!message.timestamp) {
            message.timestamp = new Date();
          }

          // Estimate tokens if not provided
          if (message.tokens === undefined || message.tokens === null) {
            message.tokens = this.compressor.estimateTokens(message.content);
          }

          // Bounds check: prevent unbounded message array growth
          if (this.messages.length >= MAX_MESSAGE_COUNT) {
            this.logger.warn('Message limit reached, forcing compression', {
              currentCount: this.messages.length,
              maxCount: MAX_MESSAGE_COUNT,
            });
            // Force compression before adding new message
            // Wait for any ongoing compression to complete before deciding
            if (this.isCompressing) {
              // Another compression is in progress, wait using promise-based waiting
              this.logger.warn('Compression already in progress, waiting...');
              // Use promise-based waiting instead of spin-wait
              const compressionWaitResult = await this.waitForCompressionComplete(5000);
              // If still compressing after timeout, log warning but don't delete messages
              if (!compressionWaitResult) {
                this.logger.warn(
                  'Compression timeout reached, skipping message add to prevent data loss'
                );
                return;
              }
            } else {
              try {
                await this.compressContext();
              } catch (error) {
                this.logger.error(
                  'Forced compression failed',
                  error instanceof Error ? error : undefined
                );
                // Log detailed info about messages that would be removed (backup mechanism)
                const removeCount = Math.floor(this.messages.length * 0.2);
                const removedMessages = this.messages.slice(0, removeCount);
                this.logger.warn('Removing messages due to compression failure', {
                  removedCount: removeCount,
                  removedMessagesSummary: removedMessages
                    .map((m) => `[${m.role}] ${m.content.substring(0, 50)}...`)
                    .join('; '),
                });
                this.messages = this.messages.slice(removeCount);
              }
            }
          }

          this.messages.push(message);
          this.isDirty = true; // Mark context as dirty for saving

          this.logger.debug('Message added to context', {
            role: message.role,
            tokens: message.tokens,
            totalMessages: this.messages.length,
          });

          // Auto-compress if needed BEFORE saving (skip if already compressing)
          if (this.autoCompress && !this.isCompressing && this.shouldCompress()) {
            this.logger.debug('Auto-compression triggered', {
              currentTokens: this.compressor.calculateTotalTokens(this.messages),
              maxTokens: this.maxTokens,
            });

            try {
              await this.compressContext();
              this.logger.debug('Auto-compression completed successfully');
            } catch (error) {
              this.logger.error(
                'Auto-compression failed',
                error instanceof Error ? error : undefined
              );
            }
          }

          // Auto-save to storage after potential compression
          try {
            await this.saveToStorage();
          } catch (error) {
            this.logger.debug('Auto-save failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          // Always release the lock
          this.releaseLock();
        }
      })
      .catch((error): void => {
        // Log error but don't release lock here - it's handled by finally block in the try/catch above
        // The Promise chain should continue to work, and lock is always released in the finally
        this.logger.error(
          'Message add operation failed in Promise chain',
          error instanceof Error ? error : undefined
        );
        // Don't re-throw to maintain Promise chain stability
        // The error has been logged and handled
      });

    return this.pendingOperations;
  }

  /**
   * Get all messages
   */
  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  /**
   * Get context window information
   */
  getContextWindow(): ContextWindow {
    const totalTokens = this.compressor.calculateTotalTokens(this.messages);
    const utilizationPercentage = (totalTokens / this.maxTokens) * 100;

    return {
      messages: this.getMessages(),
      totalTokens,
      maxTokens: this.maxTokens,
      utilizationPercentage,
    };
  }

  /**
   * Analyze the current context
   */
  analyzeContext(): ContextAnalysis {
    return this.compressor.analyzeContext(this.messages);
  }

  /**
   * Compress the context
   */
  async compressContext(): Promise<CompressionResult> {
    // Prevent concurrent compression operations
    if (this.isCompressing) {
      this.logger.debug('Compression already in progress, skipping');
      return {
        success: false,
        compressedMessages: this.messages,
        tokensReduced: 0,
        compressionRatio: 0,
        error: 'Compression already in progress',
      };
    }

    this.isCompressing = true;

    try {
      const originalMessageCount = this.messages.length;
      const originalTokens = this.compressor.calculateTotalTokens(this.messages);

      this.logger.debug('Starting context compression', {
        originalMessageCount,
        originalTokens,
        maxTokens: this.maxTokens,
      });

      const result = await this.compressor.compressConversation(this.messages);

      if (result.success) {
        this.messages = result.compressedMessages;
        this.isDirty = true; // Mark as dirty since messages changed

        const newTokens = this.compressor.calculateTotalTokens(this.messages);

        this.logger.info('Context compressed successfully', {
          originalMessages: originalMessageCount,
          compressedMessages: this.messages.length,
          originalTokens,
          newTokens,
          tokensReduced: result.tokensReduced,
          compressionRatio: `${(result.compressionRatio * 100).toFixed(1)}%`,
        });

        // IMPORTANT: Warn that Memory module may have stale data
        // Context compression removes/summarizes messages but Memory keeps originals
        this.logger.warn(
          'Context compressed but Memory module retains original messages. ' +
            'Consider implementing memory archiving or cleanup for long conversations. ' +
            `Removed ${originalMessageCount - this.messages.length} messages from context.`,
          {
            originalMessageCount,
            compressedMessageCount: this.messages.length,
            messagesRemoved: originalMessageCount - this.messages.length,
            agentId: this.agentId,
          }
        );

        // Save compressed context with metadata
        if (this.storage && this.agentId) {
          try {
            await this.storage.updateContextMetadata(this.agentId, {
              tokensUsed: this.compressor.calculateTotalTokens(this.messages),
              compressionVersion: result.strategy,
            });

            // Save the compressed messages
            await this.saveToStorage();
          } catch (error) {
            this.logger.warn('Failed to save compressed context', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Notify listeners about compression (for Memory module to handle archiving)
        await this.notifyCompression({
          originalMessageCount,
          compressedMessageCount: this.messages.length,
          messagesRemoved: originalMessageCount - this.messages.length,
          tokensReduced: result.tokensReduced,
          strategy: result.strategy || 'unknown',
        });
      }

      return result;
    } finally {
      this.isCompressing = false;
      // Wake up any waiters for compression completion
      this.notifyCompressionWaiters();
    }
  }

  // Queue for waiting on compression completion (replaces spin-wait)
  private compressionWaiters: Array<() => void> = [];

  /**
   * Wait for ongoing compression to complete (promise-based, no spin-wait)
   * @param timeoutMs - Maximum time to wait
   * @returns true if compression completed, false if timed out
   */
  private async waitForCompressionComplete(timeoutMs: number): Promise<boolean> {
    if (!this.isCompressing) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        const index = this.compressionWaiters.findIndex((w) => w === wrappedResolve);
        if (index !== -1) {
          this.compressionWaiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timeoutId);
        resolve(true);
      };

      this.compressionWaiters.push(wrappedResolve);
    });
  }

  /**
   * Notify all compression waiters that compression is complete
   */
  private notifyCompressionWaiters(): void {
    for (const waiter of this.compressionWaiters) {
      waiter();
    }
    this.compressionWaiters = [];
  }

  /**
   * Clear all context
   * @param options - Optional settings for clearing context
   * @param options.syncWithMemory - If true (default), notifies Memory to also clear. Set to false to clear only Context.
   */
  async clearContext(options?: { syncWithMemory?: boolean }): Promise<void> {
    // Wait for any pending operations to complete before clearing
    await this.pendingOperations;

    const previousCount = this.messages.length;
    this.messages = [];
    this.isDirty = true;

    // Reset pending operations to prevent memory leak from old Promise chain
    this.pendingOperations = Promise.resolve();

    this.logger.info('Context cleared', {
      messagesRemoved: previousCount,
      syncWithMemory: options?.syncWithMemory !== false,
    });

    // Save cleared state to storage immediately
    try {
      await this.saveToStorage();
    } catch (error) {
      this.logger.debug('Failed to save cleared context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Notify Memory module to also clear if syncWithMemory is enabled (default: true)
    if (previousCount > 0 && options?.syncWithMemory !== false && this.onClearCallback) {
      try {
        await this.onClearCallback();
      } catch (error) {
        this.logger.warn('Context clear callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Cleanup resources and reset pending operations
   * Call this when the context manager is no longer needed
   */
  async dispose(): Promise<void> {
    // Wait for any pending operations to complete
    await this.pendingOperations;

    // Reset pending operations to allow garbage collection
    this.pendingOperations = Promise.resolve();

    // Clear waiting queues to prevent memory leaks
    this.lockQueue = [];
    this.compressionWaiters = [];

    this.logger.debug('ContextManager disposed');
  }

  /**
   * Check if compression is needed
   */
  shouldCompress(): boolean {
    return this.compressor.shouldCompress(this.messages);
  }

  /**
   * Export context as JSON string
   */
  exportContext(): string {
    const exportData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      messages: this.messages,
      metadata: {
        totalMessages: this.messages.length,
        totalTokens: this.compressor.calculateTotalTokens(this.messages),
      },
    };
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import context from JSON string
   */
  importContext(data: string): void {
    try {
      const parsed = JSON.parse(data);

      if (!parsed.messages || !Array.isArray(parsed.messages)) {
        throw new Error('Invalid context data: missing messages array');
      }

      // Validate and restore messages
      const validRoles = ['user', 'assistant', 'system'] as const;
      type ValidRole = (typeof validRoles)[number];

      let invalidRoleCount = 0;
      this.messages = parsed.messages.map(
        (
          msg: {
            role?: string;
            content?: string;
            timestamp?: string;
            metadata?: MetadataObject;
            tokens?: number;
          },
          index: number
        ) => {
          // Type guard: validate role is one of the valid roles
          const isValidRole = validRoles.includes(msg.role as ValidRole);
          if (!isValidRole) {
            invalidRoleCount++;
            this.logger.warn('Invalid message role during import, defaulting to user', {
              messageIndex: index,
              originalRole: msg.role ?? 'undefined',
              expected: 'user, assistant, or system',
              contentPreview: (msg.content || '').substring(0, 50),
            });
          }
          const role: ValidRole = isValidRole ? (msg.role as ValidRole) : 'user';

          return {
            role,
            content: msg.content || '',
            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
            metadata: msg.metadata || {},
            tokens: msg.tokens,
          };
        }
      );

      // Summary warning if multiple invalid roles were found
      if (invalidRoleCount > 0) {
        this.logger.warn(
          `Import completed with ${invalidRoleCount} invalid role(s) converted to "user"`,
          {
            totalMessages: this.messages.length,
            invalidRoleCount,
          }
        );
      }

      this.isDirty = true;
      this.logger.info('Context imported successfully', {
        messagesImported: this.messages.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to import context', error instanceof Error ? error : undefined);
      throw new Error(`Failed to import context: ${errorMessage}`);
    }
  }

  /**
   * Generate a summary of the current context
   */
  async generateSummary(): Promise<ContextSummary> {
    if (this.messages.length === 0) {
      return {
        mainTopics: [],
        keyEntities: [],
        conversationFlow: 'No conversation yet',
        importantFacts: [],
        actionItems: [],
      };
    }

    const conversationText = this.messages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const summaryPrompt = `Analyze the following conversation and provide a structured summary:

${conversationText}

Provide a JSON summary with:
1. mainTopics: Array of main topics discussed
2. keyEntities: Array of important entities mentioned (people, places, concepts)
3. conversationFlow: Brief description of how the conversation progressed
4. importantFacts: Array of key facts or decisions
5. actionItems: Array of any action items or tasks mentioned

Return only valid JSON.`;

    try {
      const llm = getLLM(getLogger());
      if (!llm) {
        this.logger.warn('LLM not available for summary generation');
        return {
          mainTopics: [],
          keyEntities: [],
          conversationFlow: 'LLM not available',
          importantFacts: [],
          actionItems: [],
        };
      }
      const response = await llm.generateResponse({
        model: this.model,
        messages: [{ role: 'user' as const, content: summaryPrompt }],
        temperature: 0.3,
        maxTokens: 500,
      });

      // Safely parse JSON response with error handling
      let summary: Record<string, unknown>;
      try {
        // Try to extract JSON from response (LLM might include extra text)
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON object found in response');
        }
        summary = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        this.logger.warn('Failed to parse JSON from summary response', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          responsePreview: response.content.substring(0, 200),
        });
        return {
          mainTopics: [],
          keyEntities: [],
          conversationFlow: 'Failed to parse summary response',
          importantFacts: [],
          actionItems: [],
        };
      }

      return {
        mainTopics: Array.isArray(summary.mainTopics) ? summary.mainTopics : [],
        keyEntities: Array.isArray(summary.keyEntities) ? summary.keyEntities : [],
        conversationFlow:
          typeof summary.conversationFlow === 'string' ? summary.conversationFlow : '',
        importantFacts: Array.isArray(summary.importantFacts) ? summary.importantFacts : [],
        actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
      };
    } catch (error) {
      this.logger.error('Failed to generate summary', error instanceof Error ? error : undefined);
      return {
        mainTopics: [],
        keyEntities: [],
        conversationFlow: 'Failed to generate summary',
        importantFacts: [],
        actionItems: [],
      };
    }
  }

  /**
   * Get recent messages
   */
  getRecentMessages(count: number): ContextMessage[] {
    // Bounds check: ensure count is valid
    const safeCount = Math.max(0, Math.min(count, this.messages.length));
    return this.messages.slice(-safeCount);
  }

  /**
   * Find messages by role
   */
  getMessagesByRole(role: 'user' | 'assistant' | 'system'): ContextMessage[] {
    return this.messages.filter((msg) => msg.role === role);
  }

  /**
   * Update a message in context by memory ID
   * Used for synchronizing with Memory module updates
   */
  updateMessageByMemoryId(
    memoryId: string,
    updates: { content?: string; metadata?: MetadataObject }
  ): boolean {
    const messageIndex = this.messages.findIndex((msg) => msg.metadata?.memory_id === memoryId);

    if (messageIndex === -1) {
      this.logger.debug('Message not found in context for memory update', { memoryId });
      return false;
    }

    const message = this.messages[messageIndex];

    if (updates.content !== undefined) {
      message.content = updates.content;
      message.tokens = this.compressor.estimateTokens(updates.content);
    }

    if (updates.metadata !== undefined) {
      message.metadata = {
        ...message.metadata,
        ...updates.metadata,
      };
    }

    this.isDirty = true;
    this.logger.debug('Context message updated', { memoryId, messageIndex });
    return true;
  }

  /**
   * Remove a message from context by memory ID
   * Used for synchronizing with Memory module deletions
   */
  removeMessageByMemoryId(memoryId: string): boolean {
    const messageIndex = this.messages.findIndex((msg) => msg.metadata?.memory_id === memoryId);

    if (messageIndex === -1) {
      this.logger.debug('Message not found in context for removal', { memoryId });
      return false;
    }

    this.messages.splice(messageIndex, 1);
    this.isDirty = true;
    this.logger.debug('Context message removed', { memoryId, messageIndex });
    return true;
  }

  /**
   * Search context messages
   * Provides filtering by graphId, taskId, sessionId and text content
   */
  searchContext(options: {
    query?: string;
    graphId?: string;
    taskId?: string;
    sessionId?: string;
    role?: 'user' | 'assistant' | 'system';
    limit?: number;
  }): ContextMessage[] {
    let results = [...this.messages];

    // Filter by graphId
    if (options.graphId !== undefined) {
      results = results.filter((msg) => msg.metadata?.graphId === options.graphId);
    }

    // Filter by taskId
    if (options.taskId !== undefined) {
      results = results.filter((msg) => msg.metadata?.taskId === options.taskId);
    }

    // Filter by sessionId
    if (options.sessionId !== undefined) {
      results = results.filter((msg) => msg.metadata?.sessionId === options.sessionId);
    }

    // Filter by role
    if (options.role !== undefined) {
      results = results.filter((msg) => msg.role === options.role);
    }

    // Filter by text content (case-insensitive)
    if (options.query !== undefined && options.query.trim() !== '') {
      const queryLower = options.query.toLowerCase();
      results = results.filter((msg) => msg.content.toLowerCase().includes(queryLower));
    }

    // Apply limit
    if (options.limit !== undefined && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    this.logger.debug('Context search completed', {
      query: options.query,
      graphId: options.graphId,
      taskId: options.taskId,
      resultsCount: results.length,
    });

    return results;
  }

  /**
   * Update the model used for context operations
   */
  updateModel(model: string): void {
    this.model = model;
    this.compressor.updateOptions({ model });
    this.logger.debug('Context model updated', { model });
  }

  /**
   * Load conversation history from memory module
   * @returns true if loading was successful, false otherwise
   */
  async loadFromMemory(
    memoryModule: {
      listMemories: (options: { limit: number; orderBy: string; order: string }) => Promise<
        Array<{
          id: string; // UUID
          content: string;
          created_at: string;
          graphId?: string; // UUID - Graph relationship
          taskId?: string; // UUID - Task relationship
          sessionId?: string; // Session ID
          metadata?: MetadataObject;
        }>
      >;
    },
    limit: number = 20
  ): Promise<boolean> {
    try {
      // Get the latest conversation messages from Memory
      const recentMemories = await memoryModule.listMemories({
        limit,
        orderBy: 'created_at',
        order: 'desc',
      });

      // Clear the old context
      this.messages = [];

      // Load messages from Memory to context (old to new order)
      // Use direct push instead of addMessage to avoid triggering save for each message
      const sortedMemories = recentMemories.reverse();
      for (const memory of sortedMemories) {
        // Preserve graphId and other metadata from the original memory
        const baseMetadata = {
          source: 'memory',
          memory_id: memory.id,
          ...(memory.graphId && { graphId: memory.graphId }),
          ...(memory.taskId && { taskId: memory.taskId }),
          ...(memory.sessionId && { sessionId: memory.sessionId }),
        };

        const content = memory.content || '';
        const timestamp = new Date(memory.created_at);
        const tokens = this.compressor.estimateTokens(content);

        if (memory.metadata?.type === 'user_message') {
          this.messages.push({
            role: 'user',
            content,
            timestamp,
            tokens,
            metadata: baseMetadata,
          });
        } else if (memory.metadata?.type === 'assistant_response') {
          this.messages.push({
            role: 'assistant',
            content,
            timestamp,
            tokens,
            metadata: baseMetadata,
          });
        }
      }

      this.isDirty = true; // Mark as dirty after batch loading

      this.logger.info('Context loaded from memory', {
        messagesLoaded: this.messages.length,
        memoryLimit: limit,
      });

      // Apply compression if needed after loading from Memory
      if (this.autoCompress && this.shouldCompress()) {
        await this.compressContext();
      }

      // Save once after all messages loaded
      await this.saveToStorage();
      return true;
    } catch (error) {
      this.logger.error(
        'Failed to load context from memory',
        error instanceof Error ? error : undefined
      );
      return false;
    }
  }

  /**
   * Save current context messages to memory
   * @returns true if saving was successful, false otherwise
   */
  async saveToMemory(memoryModule: {
    addMemory: (
      content: string,
      metadata?: MetadataObject,
      context?: { graphId?: string; taskId?: string; sessionId?: string }
    ) => Promise<{ id: string; content: string }>; // UUID
  }): Promise<boolean> {
    try {
      // Save only new messages that are not already loaded from memory
      // Skip messages that have source='memory' (already in database)
      const newMessages = this.messages.filter((msg) => msg.metadata?.source !== 'memory');

      for (const message of newMessages) {
        // Extract graphId/taskId/sessionId for the context parameter (database columns)
        const context: { graphId?: string; taskId?: string; sessionId?: string } = {};
        if (message.metadata?.graphId) {
          context.graphId = String(message.metadata.graphId);
        }
        if (message.metadata?.taskId) {
          context.taskId = String(message.metadata.taskId);
        }
        if (message.metadata?.sessionId) {
          context.sessionId = String(message.metadata.sessionId);
        }

        // Base metadata for the metadata JSON field
        const baseMetadata = {
          ...(message.timestamp && { timestamp: message.timestamp.toISOString() }),
        };

        if (message.role === 'user') {
          await memoryModule.addMemory(
            message.content,
            {
              type: 'user_message',
              role: 'user',
              ...baseMetadata,
            },
            Object.keys(context).length > 0 ? context : undefined
          );
        } else if (message.role === 'assistant') {
          await memoryModule.addMemory(
            message.content,
            {
              type: 'assistant_response',
              role: 'assistant',
              ...baseMetadata,
            },
            Object.keys(context).length > 0 ? context : undefined
          );
        }
      }

      this.logger.debug('Context saved to memory', {
        messagesSaved: newMessages.length,
      });
      return true;
    } catch (error) {
      this.logger.error(
        'Failed to save context to memory',
        error instanceof Error ? error : undefined
      );
      return false;
    }
  }

  /**
   * Update compressor options
   */
  updateCompressorOptions(options: Partial<ContextCompressorOptions>): void {
    this.compressor.updateOptions(options);
    if (options.maxContextLength !== undefined) {
      this.maxTokens = options.maxContextLength;
    }
    if (options.model !== undefined) {
      this.model = options.model;
    }
  }
}
