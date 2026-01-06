/**
 * SubAgent module - Manages sub-agent coordination and delegation
 */
import { IAgentModule, IAgent, AskOptions } from '../agent/types';
import { SubAgentCoordinator } from './coordination';
import { getDelegationStrategy } from './delegation';
import { SubAgentCoordinationResult } from './types';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { DEFAULT_SUBAGENT_CONFIG, calculateSubAgentTimeouts } from './defaults';
import { SubAgentError } from '../errors';

// Use centralized timeout configuration from defaults
const DEFAULT_EXECUTION_TIMEOUT = DEFAULT_SUBAGENT_CONFIG.defaultTimeout;

/**
 * Error thrown when sub-agent execution times out
 */
export class SubAgentTimeoutError extends Error {
  constructor(timeoutMs: number, operation?: string) {
    const message = operation
      ? `Sub-agent ${operation} timed out after ${timeoutMs}ms`
      : `Sub-agent execution timed out after ${timeoutMs}ms`;
    super(message);
    this.name = 'SubAgentTimeoutError';
  }
}

/**
 * Result of wrapping a promise with timeout using AbortController
 */
interface TimeoutResult<T> {
  promise: Promise<T>;
  abort: () => void;
}

/**
 * Wraps a promise with a timeout and provides proper cancellation via AbortController.
 * This prevents resource leaks by allowing cleanup when timeout occurs.
 *
 * @param promiseFactory - Factory function that creates the promise, receives AbortSignal
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Operation name for error messages
 * @returns Promise that resolves with result or rejects with timeout error
 */
function withTimeoutAbortable<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operation: string
): TimeoutResult<T> {
  const controller = new AbortController();
  const { signal } = controller;

  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SubAgentTimeoutError(timeoutMs, operation));
    }, timeoutMs);

    // Handle abort from external source
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });

    promiseFactory(signal)
      .then((result) => {
        clearTimeout(timer);
        if (!signal.aborted) {
          resolve(result);
        }
      })
      .catch((error) => {
        clearTimeout(timer);
        if (!signal.aborted) {
          reject(error);
        }
      });
  });

  return {
    promise,
    abort: () => controller.abort(),
  };
}

export class SubAgent implements IAgentModule {
  readonly name = 'subAgent';
  private coordinator: SubAgentCoordinator;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? getLogger();
    this.coordinator = new SubAgentCoordinator(this.logger);
  }

  async initialize(): Promise<void> {
    this.logger.debug('SubAgent module initialized');
  }

  /**
   * Execute task using sub-agents
   * @param prompt - The prompt/task to execute
   * @param subAgents - Array of sub-agents to use
   * @param options - Execution options including contextIsolation strategy
   * @param mainAgentModel - Optional model override for main agent
   * @param parentAgent - Optional parent agent for context merging
   */
  async executeWithSubAgents(
    prompt: string,
    subAgents: IAgent[],
    options: AskOptions = {},
    mainAgentModel?: string,
    parentAgent?: IAgent
  ): Promise<string> {
    if (!subAgents || subAgents.length === 0) {
      throw new Error('No sub-agents provided');
    }

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('Invalid prompt: prompt must be a non-empty string');
    }

    const timeoutMs = options.timeout ?? DEFAULT_EXECUTION_TIMEOUT;
    const contextIsolation = options.contextIsolation || 'isolated';

    this.logger.info(`Executing task with ${subAgents.length} sub-agents`, {
      delegation: options.delegation || 'auto',
      coordination: options.coordination || 'parallel',
      contextIsolation,
      timeout: timeoutMs,
    });

    try {
      // Get delegation strategy
      const delegationType = options.delegation || 'auto';
      const strategy = getDelegationStrategy(delegationType, this.logger);

      // Calculate timeout values with minimum guarantees
      // This prevents issues when node timeout is too short (e.g., 1 minute = 24s delegation)
      const { delegateTimeout, executeTimeout } = calculateSubAgentTimeouts(timeoutMs);

      this.logger.debug(
        `Sub-agent timeout allocation: delegation=${delegateTimeout}ms, execution=${executeTimeout}ms (total=${timeoutMs}ms)`
      );

      // Delegate tasks to sub-agents with proportional timeout
      const { promise: delegatePromise } = withTimeoutAbortable(
        () => strategy.delegate(prompt, subAgents, options, mainAgentModel),
        delegateTimeout,
        'task delegation'
      );
      const tasks = await delegatePromise;

      this.logger.debug(`Generated ${tasks.length} tasks for sub-agents`, {
        taskCount: tasks.length,
        agentIds: tasks.map((t) => t.agentId),
        priorities: tasks.map((t) => t.priority ?? 0),
      });

      if (tasks.length === 0) {
        throw new Error('No tasks generated for sub-agents');
      }

      // Execute tasks with coordination, context isolation, and proportional timeout
      const coordination = options.coordination || 'parallel';
      const { promise: executePromise } = withTimeoutAbortable(
        () =>
          this.coordinator.executeSubAgentTasks(
            tasks,
            subAgents,
            coordination,
            contextIsolation,
            parentAgent
          ),
        executeTimeout,
        'sub-agent execution'
      );
      const result = await executePromise;

      if (!result.success) {
        this.logger.warn('Sub-agent execution completed with errors', {
          errors: result.errors,
          successfulResults: result.results.filter((r) => r.success).length,
        });
      }

      return result.finalResult;
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SubAgentTimeoutError) {
        this.logger.error(`Sub-agent execution timed out after ${timeoutMs}ms`);
        throw error;
      }
      this.logger.error('Sub-agent execution failed', originalError, {
        errorMessage: originalError.message,
      });
      throw new SubAgentError(
        `Sub-agent execution failed: ${originalError.message}`,
        undefined,
        originalError
      );
    }
  }

  /**
   * Get detailed results from sub-agent execution
   */
  async executeWithSubAgentsDetailed(
    prompt: string,
    subAgents: IAgent[],
    options: AskOptions = {},
    mainAgentModel?: string
  ): Promise<SubAgentCoordinationResult> {
    if (!subAgents || subAgents.length === 0) {
      throw new Error('No sub-agents provided');
    }

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('Invalid prompt: prompt must be a non-empty string');
    }

    const timeoutMs = options.timeout ?? DEFAULT_EXECUTION_TIMEOUT;

    this.logger.debug('Starting detailed sub-agent execution', {
      subAgentCount: subAgents.length,
      delegation: options.delegation || 'auto',
      coordination: options.coordination || 'parallel',
      timeout: timeoutMs,
    });

    try {
      // Get delegation strategy
      const delegationType = options.delegation || 'auto';
      const strategy = getDelegationStrategy(delegationType, this.logger);

      // Calculate timeout values with minimum guarantees
      // This prevents issues when node timeout is too short (e.g., 1 minute = 24s delegation)
      const { delegateTimeout, executeTimeout } = calculateSubAgentTimeouts(timeoutMs);

      this.logger.debug(
        `Sub-agent timeout allocation: delegation=${delegateTimeout}ms, execution=${executeTimeout}ms (total=${timeoutMs}ms)`
      );

      // Delegate tasks to sub-agents with proportional timeout
      const { promise: delegatePromise } = withTimeoutAbortable(
        () => strategy.delegate(prompt, subAgents, options, mainAgentModel),
        delegateTimeout,
        'task delegation'
      );
      const tasks = await delegatePromise;

      if (tasks.length === 0) {
        throw new Error('No tasks generated for sub-agents');
      }

      // Execute tasks with coordination and proportional timeout
      const coordination = options.coordination || 'parallel';
      const { promise: executePromise } = withTimeoutAbortable(
        () => this.coordinator.executeSubAgentTasks(tasks, subAgents, coordination),
        executeTimeout,
        'sub-agent execution'
      );
      return await executePromise;
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SubAgentTimeoutError) {
        this.logger.error(`Detailed sub-agent execution timed out after ${timeoutMs}ms`);
        throw error;
      }
      this.logger.error('Detailed sub-agent execution failed', originalError, {
        errorMessage: originalError.message,
      });
      throw new SubAgentError(
        `Detailed sub-agent execution failed: ${originalError.message}`,
        undefined,
        originalError
      );
    }
  }

  /**
   * Check if an agent has sub-agents
   */
  hasSubAgents(agent: IAgent): boolean {
    if (!agent || !agent.config) {
      return false;
    }
    return Array.isArray(agent.config.subAgents) && agent.config.subAgents.length > 0;
  }

  /**
   * Get sub-agents for an agent
   */
  getSubAgents(agent: IAgent): IAgent[] {
    if (!agent || !agent.config || !Array.isArray(agent.config.subAgents)) {
      return [];
    }
    return agent.config.subAgents;
  }

  /**
   * Destroy SubAgent module and free resources.
   * Call this when the module is no longer needed.
   */
  async destroy(): Promise<void> {
    // Clear coordinator reference
    // Note: SubAgentCoordinator doesn't hold persistent state (just logger reference)
    // The coordinator doesn't have pending tasks since executeSubAgentTasks returns a promise
    // and we await it before destroy is called

    // Clear any internal references
    // SubAgentCoordinator uses IAgent references which are passed in per-call,
    // not stored permanently, so no cleanup needed there

    this.logger.debug('SubAgent module destroyed');
  }
}

// Export types and utilities
export * from './types';
export * from './delegation';
export * from './coordination';

// Export timeout utilities for advanced usage
export { withTimeoutAbortable, TimeoutResult };
