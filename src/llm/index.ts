import {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  RateLimiterOptions,
} from './types';
import { getProviderForModel, getSupportedModelsList } from './models';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { DEFAULT_LLM_CONFIG } from './defaults';

/**
 * Request priority levels for fair scheduling
 */
export enum RequestPriority {
  /** High priority - Agent.ask() direct user interactions */
  HIGH = 0,
  /** Normal priority - Task execution, SubAgent operations */
  NORMAL = 1,
  /** Low priority - Background tasks like context compression */
  LOW = 2,
}

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  priority: RequestPriority;
  enqueuedAt: number;
  caller?: string;
}

/**
 * Rate limiter for coordinating concurrent LLM API calls across modules.
 * Prevents API rate limit errors (429) when multiple modules call LLM simultaneously.
 *
 * Features:
 * - Concurrent request limiting
 * - Requests per minute limiting
 * - Fair scheduling with priority queues
 * - Starvation prevention for low-priority requests
 *
 * Used by:
 * - Agent.ask()
 * - Task.executeTask()
 * - ContextManager.compressContext()
 * - SubAgent.executeWithSubAgents()
 */
export class RateLimiter {
  private queues: Map<RequestPriority, QueuedRequest[]> = new Map([
    [RequestPriority.HIGH, []],
    [RequestPriority.NORMAL, []],
    [RequestPriority.LOW, []],
  ]);
  private running = 0;
  private requestTimestamps: number[] = [];
  private readonly maxConcurrent: number;
  private readonly maxRequestsPerMinute: number;
  private readonly acquireTimeout: number;
  /** Maximum time a low-priority request can wait before being promoted (prevents starvation) */
  private readonly maxStarvationTimeMs: number;
  /** How often to check for starvation (ms) */
  private readonly starvationCheckInterval: number = 1000;
  private starvationTimer: NodeJS.Timeout | null = null;
  /** Flag to track if instance is destroyed */
  private isDestroyed = false;
  /** Lock for queue operations to prevent race conditions */
  private queueLock = false;

  constructor(options: RateLimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 60;
    this.acquireTimeout = options.acquireTimeout ?? 30000;
    this.maxStarvationTimeMs = options.maxStarvationTimeMs ?? 10000;
    this.startStarvationPrevention();
  }

  /**
   * Destroy the rate limiter and cleanup all resources
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }
    this.isDestroyed = true;
    this.clear();
  }

  /**
   * Start the starvation prevention timer
   */
  private startStarvationPrevention(): void {
    if (this.starvationTimer) return;

    this.starvationTimer = setInterval(() => {
      this.promoteStarvedRequests();
    }, this.starvationCheckInterval);

    // Allow process to exit
    this.starvationTimer.unref();
  }

  /**
   * Promote requests that have been waiting too long to prevent starvation
   */
  private promoteStarvedRequests(): void {
    const now = Date.now();

    // Check LOW priority queue for starvation
    const lowQueue = this.queues.get(RequestPriority.LOW) || [];
    const normalQueue = this.queues.get(RequestPriority.NORMAL) || [];

    // Promote starved LOW -> NORMAL
    const starvedFromLow = lowQueue.filter(
      (req) => now - req.enqueuedAt > this.maxStarvationTimeMs
    );
    for (const req of starvedFromLow) {
      const index = lowQueue.indexOf(req);
      if (index !== -1) {
        lowQueue.splice(index, 1);
        req.priority = RequestPriority.NORMAL;
        normalQueue.push(req);
      }
    }

    // Check NORMAL priority queue for extreme starvation (2x threshold)
    const highQueue = this.queues.get(RequestPriority.HIGH) || [];
    const starvedFromNormal = normalQueue.filter(
      (req) => now - req.enqueuedAt > this.maxStarvationTimeMs * 2
    );
    for (const req of starvedFromNormal) {
      const index = normalQueue.indexOf(req);
      if (index !== -1) {
        normalQueue.splice(index, 1);
        req.priority = RequestPriority.HIGH;
        highQueue.push(req);
      }
    }
  }

  /**
   * Get total number of queued requests across all priorities
   */
  private getTotalQueued(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get the next request from the priority queues (fair scheduling)
   * Returns requests in priority order: HIGH -> NORMAL -> LOW
   */
  private getNextFromQueue(): QueuedRequest | undefined {
    // Process in priority order
    for (const priority of [RequestPriority.HIGH, RequestPriority.NORMAL, RequestPriority.LOW]) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        return queue.shift();
      }
    }
    return undefined;
  }

  /**
   * Acquire a slot for making an LLM request.
   * Waits if maximum concurrent requests are in progress or rate limit exceeded.
   * @param priority - Request priority for fair scheduling (default: NORMAL)
   * @param caller - Optional identifier for the caller (for debugging)
   * @throws Error if acquire timeout is exceeded
   */
  async acquire(
    priority: RequestPriority = RequestPriority.NORMAL,
    caller?: string
  ): Promise<void> {
    // Clean up old timestamps (older than 1 minute)
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60000);

    // Check rate limit (requests per minute)
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = 60000 - (now - oldestTimestamp);
      if (waitTime > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
        // Re-check after waiting
        return this.acquire(priority, caller);
      }
    }

    // Check concurrent limit
    if (this.running < this.maxConcurrent) {
      this.running++;
      this.requestTimestamps.push(Date.now());
      return;
    }

    // Wait in priority queue with proper locking
    return new Promise<void>((resolve, reject) => {
      // Check if destroyed
      if (this.isDestroyed) {
        reject(new Error('Rate limiter has been destroyed'));
        return;
      }

      const request: QueuedRequest = {
        resolve,
        reject,
        timeoutId: null as unknown as NodeJS.Timeout, // Will be set below
        priority,
        enqueuedAt: Date.now(),
        caller,
      };

      const timeoutId = setTimeout(() => {
        // Use lock to prevent race condition during removal
        this.withQueueLock(() => {
          // Find request in current priority queue (may have been promoted)
          for (const [, queue] of this.queues) {
            const index = queue.findIndex((item) => item === request);
            if (index !== -1) {
              queue.splice(index, 1);
              break;
            }
          }
        });
        reject(
          new Error(
            `Rate limiter acquire timeout after ${this.acquireTimeout}ms (priority: ${RequestPriority[priority]}, caller: ${caller || 'unknown'})`
          )
        );
      }, this.acquireTimeout);

      request.timeoutId = timeoutId;

      // Use lock when adding to queue
      this.withQueueLock(() => {
        const queue = this.queues.get(priority);
        if (queue) {
          queue.push(request);
        }
      });
    });
  }

  /**
   * Execute a function with queue lock to prevent race conditions
   */
  private withQueueLock<T>(fn: () => T): T {
    // Simple spinlock for synchronous queue operations
    // In JS single-threaded environment, this prevents interleaving during async boundaries
    while (this.queueLock) {
      // This shouldn't happen in practice due to JS single-threadedness
      // but provides safety for edge cases
    }
    this.queueLock = true;
    try {
      return fn();
    } finally {
      this.queueLock = false;
    }
  }

  /**
   * Release a slot after completing an LLM request.
   */
  release(): void {
    this.running = Math.max(0, this.running - 1);

    const next = this.getNextFromQueue();
    if (next) {
      clearTimeout(next.timeoutId);
      this.running++;
      this.requestTimestamps.push(Date.now());
      next.resolve();
    }
  }

  /**
   * Get current rate limiter status
   */
  getStatus(): {
    running: number;
    queued: number;
    queuedByPriority: { high: number; normal: number; low: number };
    requestsInLastMinute: number;
  } {
    const now = Date.now();
    const recentRequests = this.requestTimestamps.filter((ts) => now - ts < 60000);
    return {
      running: this.running,
      queued: this.getTotalQueued(),
      queuedByPriority: {
        high: this.queues.get(RequestPriority.HIGH)?.length || 0,
        normal: this.queues.get(RequestPriority.NORMAL)?.length || 0,
        low: this.queues.get(RequestPriority.LOW)?.length || 0,
      },
      requestsInLastMinute: recentRequests.length,
    };
  }

  /**
   * Clear all queued requests (useful for cleanup)
   */
  clear(): void {
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        clearTimeout(item.timeoutId);
        item.reject(new Error('Rate limiter cleared'));
      }
      queue.length = 0;
    }
    this.running = 0;
    this.requestTimestamps = [];
    if (this.starvationTimer) {
      clearInterval(this.starvationTimer);
      this.starvationTimer = null;
    }
  }
}

// Global rate limiter instance for LLM requests
let globalRateLimiter: RateLimiter | null = null;

/**
 * Get the global rate limiter instance.
 * Creates one if it doesn't exist.
 */
export function getRateLimiter(options?: RateLimiterOptions): RateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new RateLimiter(options);
  }
  return globalRateLimiter;
}

/**
 * Reset the global rate limiter (useful for testing or configuration changes)
 */
export function resetRateLimiter(options?: RateLimiterOptions): RateLimiter {
  if (globalRateLimiter) {
    globalRateLimiter.clear();
  }
  globalRateLimiter = new RateLimiter(options);
  return globalRateLimiter;
}

export class LLM {
  private providers: Map<string, LLMProvider> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || getLogger();

    // User-facing info log
    this.logger.info('LLM service initialized');

    this.logger.debug('LLM service initialized', {
      providersInitialized: 0,
      supportedModels: this.getSupportedModels().length,
    });
  }

  private initializeProvider(providerName: string): LLMProvider {
    const existingProvider = this.providers.get(providerName);
    if (existingProvider) {
      this.logger.debug('Provider already initialized', { providerName });
      return existingProvider;
    }

    // User-facing info log
    this.logger.info(`Initializing ${providerName} provider`);

    try {
      let provider: LLMProvider;

      this.logger.debug('Creating provider instance', {
        providerName,
        existingProviders: Array.from(this.providers.keys()),
      });

      switch (providerName) {
        case 'openai':
          provider = new OpenAIProvider({ logger: this.logger });
          break;
        case 'claude':
          provider = new ClaudeProvider({ logger: this.logger });
          break;
        case 'gemini':
          provider = new GeminiProvider({ logger: this.logger });
          break;
        case 'ollama':
          provider = new OllamaProvider({ logger: this.logger });
          break;
        default:
          throw new Error(`Unsupported provider: ${providerName}`);
      }

      this.providers.set(providerName, provider);

      // User-facing success message
      this.logger.info(`${providerName} provider ready`);

      this.logger.debug('Provider initialized successfully', {
        providerName,
        totalProviders: this.providers.size,
      });

      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // User-facing error message
      this.logger.error(`Failed to initialize ${providerName} provider`);

      this.logger.debug('Provider initialization failed', {
        providerName,
        error: message,
        hasStack: error instanceof Error && !!error.stack,
      });

      throw new Error(`Provider ${providerName} initialization failed: ${message}`);
    }
  }

  async generateResponse(
    options: LLMRequestOptions,
    priority: RequestPriority = RequestPriority.NORMAL,
    caller?: string
  ): Promise<LLMResponse> {
    // User-facing info log
    this.logger.info(`Generating response with ${options.model}`);

    this.logger.debug('Generating LLM response', {
      model: options.model,
      messageCount: options.messages.length,
      temperature: options.temperature || DEFAULT_LLM_CONFIG.defaultTemperature,
      maxTokens: options.maxTokens || DEFAULT_LLM_CONFIG.defaultMaxTokens,
      stream: !!options.stream,
      hasSystemPrompt: !!options.systemPrompt,
      priority: RequestPriority[priority],
      caller: caller ?? null,
    });

    const provider = this.getProviderForModel(options.model);

    // Use rate limiter to coordinate concurrent requests with fair scheduling
    const rateLimiter = getRateLimiter();
    await rateLimiter.acquire(priority, caller || 'LLM.generateResponse');

    let response: LLMResponse;
    try {
      response = await provider.generateResponse(options);
    } finally {
      rateLimiter.release();
    }

    // User-facing success message
    if (response.content.length === 0 && response.toolCalls && response.toolCalls.length > 0) {
      this.logger.info(
        `Tools called: ${response.toolCalls.map((tc) => tc.function?.name || 'unnamed').join(', ')}`
      );
    } else {
      this.logger.info(`Response generated (${response.content.length} chars)`);
    }

    this.logger.debug('LLM response generated', {
      model: response.model,
      contentLength: response.content.length,
      promptTokens: response.usage?.promptTokens || 0,
      completionTokens: response.usage?.completionTokens || 0,
      totalTokens: response.usage?.totalTokens || 0,
      hasToolCalls: !!response.toolCalls?.length,
    });

    return response;
  }

  async *generateStreamResponse(
    options: LLMRequestOptions,
    priority: RequestPriority = RequestPriority.NORMAL,
    caller?: string
  ): AsyncIterableIterator<LLMStreamChunk> {
    // User-facing info log
    this.logger.info(`Starting stream response with ${options.model}`);

    this.logger.debug('Generating streaming LLM response', {
      model: options.model,
      messageCount: options.messages.length,
      temperature: options.temperature || DEFAULT_LLM_CONFIG.defaultTemperature,
      maxTokens: options.maxTokens || DEFAULT_LLM_CONFIG.defaultMaxTokens,
      hasSystemPrompt: !!options.systemPrompt,
      priority: RequestPriority[priority],
      caller: caller ?? null,
    });

    const provider = this.getProviderForModel(options.model);
    let chunkCount = 0;
    let totalContent = '';

    // Use rate limiter to coordinate concurrent requests with fair scheduling
    const rateLimiter = getRateLimiter();
    await rateLimiter.acquire(priority, caller || 'LLM.generateStreamResponse');

    try {
      for await (const chunk of provider.generateStreamResponse(options)) {
        chunkCount++;
        totalContent += chunk.content;
        yield chunk;
      }

      // User-facing completion message
      this.logger.info(`Stream completed (${chunkCount} chunks, ${totalContent.length} chars)`);

      this.logger.debug('Streaming response completed', {
        model: options.model,
        chunkCount,
        totalContentLength: totalContent.length,
      });
    } catch (error) {
      // User-facing error message
      this.logger.error('Stream response failed');

      this.logger.debug('Streaming response failed', {
        model: options.model,
        chunkCount,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      rateLimiter.release();
    }
  }

  getSupportedModels(): string[] {
    const models = getSupportedModelsList();

    this.logger.debug('Retrieved supported models', {
      modelCount: models.length,
      models: models.slice(0, 10), // Log first 10 models to avoid clutter
    });

    return models;
  }

  getAvailableProviders(): string[] {
    const providers = Array.from(this.providers.keys());

    this.logger.debug('Retrieved available providers', {
      providerCount: providers.length,
      providers,
    });

    return providers;
  }

  async generateEmbedding(text: string, model?: string): Promise<{ embedding: number[] }> {
    const modelToUse = model || DEFAULT_LLM_CONFIG.defaultEmbeddingModel;
    const provider = this.getProviderForModel(modelToUse);

    if (!provider.generateEmbedding) {
      throw new Error(`Provider for model ${modelToUse} does not support embedding generation`);
    }

    // Use rate limiter to coordinate concurrent requests
    const rateLimiter = getRateLimiter();
    await rateLimiter.acquire();

    try {
      const result = await provider.generateEmbedding(text, modelToUse);
      return { embedding: result.embedding };
    } finally {
      rateLimiter.release();
    }
  }

  private getProviderForModel(model: string): LLMProvider {
    this.logger.debug('Looking up provider for model', { model });

    const providerType = getProviderForModel(model);

    if (!providerType) {
      // User-facing error message
      this.logger.error(`Unsupported model: ${model}`);

      this.logger.debug('Model not supported', {
        requestedModel: model,
        supportedModels: this.getSupportedModels(),
      });

      throw new Error(
        `Unsupported model: ${model}. Supported models: ${this.getSupportedModels().join(', ')}`
      );
    }

    this.logger.debug('Provider found for model', {
      model,
      providerType,
      isProviderInitialized: this.providers.has(providerType),
    });

    // Lazy initialize the provider when first needed
    return this.initializeProvider(providerType);
  }
}

// Singleton instances using string ID to avoid memory leak with Logger object keys
interface LLMInstanceEntry {
  instance: LLM;
  lastAccessTime: number;
  logger?: Logger;
}

// Use string ID for Map key instead of Logger object reference to prevent memory leak
const llmInstances: Map<string, LLMInstanceEntry> = new Map();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_INSTANCES = 50; // Prevent unlimited growth
const INSTANCE_TTL = 30 * 60 * 1000; // 30 minutes TTL for unused instances

// Counter for generating unique instance IDs
let instanceIdCounter = 0;

// WeakMap to track logger -> instanceId mapping (allows GC of logger objects)
const loggerToInstanceId: WeakMap<Logger, string> = new WeakMap();

// Cleanup old instances periodically
let cleanupTimer: NodeJS.Timeout | null = null;
let exitHandlerRegistered = false;

// Mutex promise for timer creation to prevent race conditions
let timerCreationMutex: Promise<void> | null = null;

// Store reference to handler for removal
const cleanupHandler = (): void => {
  cleanupResources();
};

function cleanupResources(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  llmInstances.clear();
  // Reset mutex when cleaning up
  timerCreationMutex = null;
}

function startCleanupTimer(): void {
  // Fast path: timer already exists
  if (cleanupTimer !== null) {
    return;
  }

  // If creation is in progress, don't start another
  if (timerCreationMutex !== null) {
    return;
  }

  // Use mutex to prevent multiple timer creations
  timerCreationMutex = (async () => {
    try {
      // Double-check after acquiring mutex
      if (cleanupTimer !== null) {
        return;
      }

      cleanupTimer = setInterval(() => {
        const now = Date.now();

        // Remove instances that haven't been accessed within TTL
        for (const [key, entry] of llmInstances.entries()) {
          if (now - entry.lastAccessTime > INSTANCE_TTL) {
            llmInstances.delete(key);
          }
        }

        // If still over MAX_INSTANCES, remove oldest entries
        if (llmInstances.size > MAX_INSTANCES) {
          const entries = Array.from(llmInstances.entries()).sort(
            (a, b) => a[1].lastAccessTime - b[1].lastAccessTime
          );
          // Remove oldest entries until we're at MAX_INSTANCES/2
          const toRemove = entries.slice(0, entries.length - Math.floor(MAX_INSTANCES / 2));
          toRemove.forEach(([key]) => llmInstances.delete(key));
        }

        // If no instances left, stop the timer to allow process to exit
        if (llmInstances.size === 0) {
          if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
          }
        }
      }, CLEANUP_INTERVAL);

      // Prevent the timer from keeping the process alive
      cleanupTimer.unref();

      // Ensure cleanup on process exit (register only once)
      if (!exitHandlerRegistered) {
        exitHandlerRegistered = true;
        process.once('beforeExit', cleanupHandler);
      }
    } finally {
      // Clear mutex after timer is created
      timerCreationMutex = null;
    }
  })();
}

// Helper function to get or create instance ID for a logger
function getInstanceId(logger?: Logger): string {
  if (!logger) {
    return '__default__';
  }

  let instanceId = loggerToInstanceId.get(logger);
  if (!instanceId) {
    instanceId = `logger_${++instanceIdCounter}`;
    loggerToInstanceId.set(logger, instanceId);
  }
  return instanceId;
}

export function getLLM(logger?: Logger): LLM {
  startCleanupTimer();

  const instanceId = getInstanceId(logger);
  const existingEntry = llmInstances.get(instanceId);
  if (existingEntry) {
    // Update last access time
    existingEntry.lastAccessTime = Date.now();
    return existingEntry.instance;
  }

  const newInstance = new LLM(logger);
  llmInstances.set(instanceId, {
    instance: newInstance,
    lastAccessTime: Date.now(),
    logger,
  });
  return newInstance;
}

// Manual cleanup function for testing or explicit cleanup
export function clearLLMInstances(): void {
  llmInstances.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  // Remove the beforeExit handler to prevent memory leaks
  if (exitHandlerRegistered) {
    process.removeListener('beforeExit', cleanupHandler);
    exitHandlerRegistered = false;
  }
}

export async function getLLMProvider(
  providerName: string,
  config?: { apiKey?: string; baseUrl?: string | null; logger?: Logger }
): Promise<LLMProvider> {
  let provider: LLMProvider;

  switch (providerName) {
    case 'openai':
      provider = new OpenAIProvider(config);
      break;
    case 'claude':
      provider = new ClaudeProvider(config);
      break;
    case 'gemini':
      provider = new GeminiProvider(config);
      break;
    case 'ollama':
      provider = new OllamaProvider(config);
      break;
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }

  return provider;
}

// Export types and utilities
export * from './types';
export * from './models';
export { OpenAIProvider, ClaudeProvider, GeminiProvider, OllamaProvider };
