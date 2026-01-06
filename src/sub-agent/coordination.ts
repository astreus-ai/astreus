/**
 * Sub-agent coordination and result management
 */
import { IAgent } from '../agent/types';
import {
  SubAgentTask,
  SubAgentResult,
  SubAgentCoordinationResult,
  ContextIsolationStrategy,
} from './types';
import { ContextMessage } from '../context/types';
import { Logger } from '../logger/types';
import { SubAgentError } from '../errors';
import { randomUUID } from 'crypto';

/**
 * Coordinates execution of sub-agent tasks and manages results
 */
export class SubAgentCoordinator {
  private logger?: Logger;

  /**
   * Store context snapshots for isolation/merge strategies.
   * Uses execution ID based isolation to prevent race conditions when
   * multiple executeSubAgentTasks calls run concurrently.
   * Key format: `${executionId}:${agentId}`
   */
  private contextSnapshots: Map<string, ContextMessage[]> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Execute sub-agent tasks with coordination
   * @param tasks - Tasks to execute
   * @param subAgents - Available sub-agents
   * @param coordination - Coordination strategy (parallel/sequential)
   * @param contextIsolation - Context isolation strategy (isolated/shared/merge)
   * @param parentAgent - Optional parent agent for context merging
   */
  async executeSubAgentTasks(
    tasks: SubAgentTask[],
    subAgents: IAgent[],
    coordination: 'parallel' | 'sequential' = 'parallel',
    contextIsolation: ContextIsolationStrategy = 'isolated',
    parentAgent?: IAgent
  ): Promise<SubAgentCoordinationResult> {
    const startTime = Date.now();
    const results: SubAgentResult[] = [];
    const errors: string[] = [];

    // Generate unique execution ID to prevent race conditions when
    // multiple executeSubAgentTasks calls run concurrently
    const executionId = randomUUID();

    this.logger?.debug(`Sub-agent context isolation strategy: ${contextIsolation}`, {
      hasParentAgent: !!parentAgent,
      subAgentCount: subAgents.length,
      executionId,
    });

    try {
      // Handle context isolation BEFORE execution
      if (contextIsolation === 'isolated' || contextIsolation === 'merge') {
        // Snapshot sub-agent contexts before execution for isolation
        await this.snapshotContexts(subAgents, executionId);
      }

      if (coordination === 'parallel') {
        await this.executeParallel(tasks, subAgents, results, errors);
      } else {
        await this.executeSequential(tasks, subAgents, results, errors);
      }

      // Handle context isolation AFTER execution
      if (contextIsolation === 'isolated') {
        // Restore sub-agent contexts to pre-execution state (full isolation)
        await this.restoreContexts(subAgents, executionId);
        this.logger?.debug('Sub-agent contexts restored (isolated mode)');
      } else if (contextIsolation === 'merge' && parentAgent) {
        // Merge sub-agent context changes back to parent
        await this.mergeContextsToParent(subAgents, parentAgent, executionId);
        // Then restore sub-agent contexts to original state
        await this.restoreContexts(subAgents, executionId);
        this.logger?.debug('Sub-agent contexts merged to parent and restored');
      }
      // 'shared' mode: contexts are not restored, changes persist

      // Clear snapshots for this execution only
      this.clearExecutionSnapshots(executionId, subAgents);

      // Generate final result from all sub-agent results
      const finalResult = this.aggregateResults(results);

      const totalExecutionTime = Date.now() - startTime;

      this.logger?.info(`Sub-agent coordination completed in ${totalExecutionTime}ms`, {
        coordination,
        contextIsolation,
        tasksExecuted: tasks.length,
        successfulResults: results.filter((r) => r.success).length,
        errors: errors.length,
        executionId,
      });

      return {
        success: errors.length === 0,
        results,
        finalResult,
        totalExecutionTime,
        errors,
      };
    } catch (error) {
      // Ensure contexts are restored even on error (for isolated/merge modes)
      if (contextIsolation === 'isolated' || contextIsolation === 'merge') {
        try {
          await this.restoreContexts(subAgents, executionId);
        } catch (restoreError) {
          this.logger?.warn('Failed to restore contexts after error', {
            error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
        }
      }
      // Clear snapshots for this execution only
      this.clearExecutionSnapshots(executionId, subAgents);

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('Sub-agent coordination failed', error as Error);

      return {
        success: false,
        results,
        finalResult: '',
        totalExecutionTime: Date.now() - startTime,
        errors: [errorMessage, ...errors],
      };
    }
  }

  /**
   * Clear snapshots for a specific execution only (prevents affecting concurrent executions)
   */
  private clearExecutionSnapshots(executionId: string, subAgents: IAgent[]): void {
    for (const agent of subAgents) {
      const key = `${executionId}:${agent.id}`;
      this.contextSnapshots.delete(key);
    }
  }

  /**
   * Snapshot contexts for all sub-agents (for isolation/merge strategies)
   * @param subAgents - Agents to snapshot
   * @param executionId - Unique execution ID for isolation
   */
  private async snapshotContexts(subAgents: IAgent[], executionId: string): Promise<void> {
    for (const agent of subAgents) {
      try {
        // Get current context messages from agent (safely handle optional method)
        const context = typeof agent.getContext === 'function' ? agent.getContext() : [];
        // Deep copy to prevent reference issues, keyed by execution ID for isolation
        const key = `${executionId}:${agent.id}`;
        this.contextSnapshots.set(key, JSON.parse(JSON.stringify(context)));
        this.logger?.debug(`Snapshotted context for agent ${agent.name}`, {
          messageCount: context.length,
          executionId,
        });
      } catch (error) {
        this.logger?.warn(`Failed to snapshot context for agent ${agent.name}`, {
          error: error instanceof Error ? error.message : String(error),
          executionId,
        });
      }
    }
  }

  /**
   * Restore contexts for all sub-agents from snapshots
   * @param subAgents - Agents to restore
   * @param executionId - Unique execution ID for isolation
   */
  private async restoreContexts(subAgents: IAgent[], executionId: string): Promise<void> {
    for (const agent of subAgents) {
      const key = `${executionId}:${agent.id}`;
      const snapshot = this.contextSnapshots.get(key);
      if (!snapshot) continue;

      try {
        // Type guard for optional context methods not in IAgent interface
        const agentWithContext = agent as IAgent & {
          clearContext?: () => Promise<void>;
          importContext?: (data: string) => void;
          exportContext?: () => string;
        };

        // Clear current context and restore snapshot
        if (agentWithContext.clearContext) {
          await agentWithContext.clearContext();
        }

        // Re-add snapshotted messages (if agent has addMemory method)
        // Note: This is a simplified restore - in production you might want
        // to use importContext if available
        if (
          agentWithContext.importContext &&
          typeof agentWithContext.exportContext === 'function'
        ) {
          // Use import/export for cleaner restore
          const exportData = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            messages: snapshot,
            metadata: { restored: true },
          };
          agentWithContext.importContext(JSON.stringify(exportData));
        }

        this.logger?.debug(`Restored context for agent ${agent.name}`, {
          messageCount: snapshot.length,
          executionId,
        });
      } catch (error) {
        this.logger?.warn(`Failed to restore context for agent ${agent.name}`, {
          error: error instanceof Error ? error.message : String(error),
          executionId,
        });
      }
    }
  }

  /**
   * Merge sub-agent context changes back to parent agent
   * @param subAgents - Agents to merge from
   * @param parentAgent - Parent agent to merge into
   * @param executionId - Unique execution ID for isolation
   */
  private async mergeContextsToParent(
    subAgents: IAgent[],
    parentAgent: IAgent,
    executionId: string
  ): Promise<void> {
    for (const agent of subAgents) {
      const key = `${executionId}:${agent.id}`;
      const originalSnapshot = this.contextSnapshots.get(key);
      if (!originalSnapshot) continue;

      try {
        // Get current context (after execution) - safely handle optional method
        const currentContext = typeof agent.getContext === 'function' ? agent.getContext() : [];

        // Find new messages (messages added during execution)
        const originalIds = new Set(originalSnapshot.map((m) => JSON.stringify(m)));
        const newMessages = currentContext.filter((m) => !originalIds.has(JSON.stringify(m)));

        // Add new messages to parent agent's context
        if (newMessages.length > 0 && parentAgent.addMemory) {
          for (const message of newMessages) {
            try {
              await parentAgent.addMemory(message.content, {
                ...message.metadata,
                mergedFrom: agent.name,
                mergedFromAgentId: agent.id,
                originalRole: message.role,
              });
            } catch (addError) {
              this.logger?.warn(`Failed to merge message to parent from ${agent.name}`, {
                error: addError instanceof Error ? addError.message : String(addError),
                executionId,
              });
            }
          }

          this.logger?.debug(
            `Merged ${newMessages.length} new messages from ${agent.name} to parent`,
            {
              executionId,
            }
          );
        }
      } catch (error) {
        this.logger?.warn(`Failed to merge context from agent ${agent.name}`, {
          error: error instanceof Error ? error.message : String(error),
          executionId,
        });
      }
    }
  }

  /**
   * Execute tasks in parallel
   */
  private async executeParallel(
    tasks: SubAgentTask[],
    subAgents: IAgent[],
    results: SubAgentResult[],
    errors: string[]
  ): Promise<void> {
    this.logger?.debug('Executing sub-agent tasks in parallel', { taskCount: tasks.length });

    // Execute all tasks concurrently
    const taskPromises = tasks.map((task) => this.executeTask(task, subAgents));

    const taskResults = await Promise.allSettled(taskPromises);

    for (let i = 0; i < taskResults.length; i++) {
      const taskResult = taskResults[i];
      const task = tasks[i];

      if (taskResult.status === 'fulfilled') {
        results.push(taskResult.value);
        // If the task itself reported an error but didn't throw, track it
        if (!taskResult.value.success && taskResult.value.error) {
          errors.push(taskResult.value.error);
        }
      } else {
        // Create a proper SubAgentError for rejected promises
        const originalError =
          taskResult.reason instanceof Error
            ? taskResult.reason
            : new Error(String(taskResult.reason));

        const subAgentError = new SubAgentError(
          `Parallel task for agent '${task.agentId}' failed: ${originalError.message}`,
          task.agentId,
          originalError
        );

        errors.push(subAgentError.message);
        this.logger?.error('Sub-agent task failed in parallel execution', subAgentError, {
          agentId: task.agentId,
          taskIndex: i,
          errorType: originalError.name,
        });
      }
    }
  }

  /**
   * Execute tasks sequentially with dependency handling
   */
  private async executeSequential(
    tasks: SubAgentTask[],
    subAgents: IAgent[],
    results: SubAgentResult[],
    errors: string[]
  ): Promise<void> {
    this.logger?.debug('Executing sub-agent tasks sequentially', { taskCount: tasks.length });

    // Sort tasks by priority and dependencies
    const sortedTasks = this.sortTasksByDependencies(tasks);

    // Track failed task IDs for dependency error propagation
    const failedTaskIds = new Set<string>();

    for (const task of sortedTasks) {
      // Check if any dependency failed - propagate error to dependent tasks
      if (task.dependencies && task.dependencies.length > 0) {
        const failedDependencies = task.dependencies.filter(
          (depId) =>
            failedTaskIds.has(depId) ||
            results.some((r) => (r.agentId === depId || task.taskId === depId) && !r.success)
        );

        if (failedDependencies.length > 0) {
          const dependencyErrorMessage = `Task skipped: dependencies failed [${failedDependencies.join(', ')}]`;
          errors.push(dependencyErrorMessage);

          // Mark this task as failed too so its dependents also get skipped
          if (task.taskId) {
            failedTaskIds.add(task.taskId);
          }
          failedTaskIds.add(task.agentId);

          // Add a failed result for this task
          const agent = subAgents.find((a) => a.id === task.agentId);
          results.push({
            agentId: task.agentId,
            agentName: agent?.name || 'Unknown',
            task: task.task,
            result: '',
            success: false,
            error: dependencyErrorMessage,
            executionTime: 0,
          });

          this.logger?.warn(`Skipping task due to failed dependencies`, {
            agentId: task.agentId,
            taskId: task.taskId,
            failedDependencies,
          });
          continue;
        }
      }

      try {
        // Build context from previous results
        const enhancedTask = this.enhanceTaskWithContext(task, results);
        const result = await this.executeTask(enhancedTask, subAgents);
        results.push(result);

        // Track failed tasks for dependency propagation
        if (!result.success) {
          if (task.taskId) {
            failedTaskIds.add(task.taskId);
          }
          failedTaskIds.add(task.agentId);
        }

        this.logger?.debug(`Sub-agent task completed: ${result.agentName}`, {
          agentId: result.agentId,
          success: result.success,
          executionTime: result.executionTime,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(errorMessage);
        this.logger?.error('Sub-agent task failed in sequential execution', error as Error);

        // Mark this task as failed for dependency propagation
        if (task.taskId) {
          failedTaskIds.add(task.taskId);
        }
        failedTaskIds.add(task.agentId);

        // Continue with remaining tasks even if one fails
      }
    }
  }

  /**
   * Execute a single sub-agent task
   */
  private async executeTask(task: SubAgentTask, subAgents: IAgent[]): Promise<SubAgentResult> {
    const startTime = Date.now();

    const agent = subAgents.find((a) => a.id === task.agentId);
    if (!agent) {
      throw new SubAgentError(`Agent with ID ${task.agentId} not found`, task.agentId);
    }

    try {
      this.logger?.debug(`Executing task for agent: ${agent.name}`, {
        agentId: agent.id,
        task: task.task.substring(0, 100) + '...',
      });

      const result = await agent.ask(task.task);
      const executionTime = Date.now() - startTime;

      return {
        agentId: agent.id,
        agentName: agent.name,
        task: task.task,
        result,
        success: true,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error(String(error));

      // Create SubAgentError with context for proper error chain propagation
      const subAgentError = new SubAgentError(
        `Sub-agent '${agent.name}' failed: ${originalError.message}`,
        agent.id,
        originalError
      );

      // Log the error with full context
      this.logger?.error(`Sub-agent execution failed: ${agent.name}`, subAgentError, {
        agentId: agent.id,
        agentName: agent.name,
        executionTime,
        errorType: originalError.name,
      });

      return {
        agentId: agent.id,
        agentName: agent.name,
        task: task.task,
        result: '',
        success: false,
        error: subAgentError.message,
        executionTime,
      };
    }
  }

  /**
   * Sort tasks by dependencies to ensure proper execution order
   * Uses task index instead of agentId to support multiple tasks for the same agent
   * @param tasks - Array of tasks to sort
   * @param maxDepth - Maximum recursion depth to prevent stack overflow (default: 1000)
   */
  private sortTasksByDependencies(tasks: SubAgentTask[], maxDepth: number = 1000): SubAgentTask[] {
    const visited = new Set<number>(); // task index
    const visiting = new Set<number>(); // task index
    const sorted: SubAgentTask[] = [];

    const visit = (index: number, depth: number = 0) => {
      // Prevent stack overflow with depth limit
      if (depth > maxDepth) {
        throw new Error(
          `Max dependency depth exceeded: ${maxDepth}. Possible circular dependency or too deep nesting.`
        );
      }

      const task = tasks[index];
      if (visiting.has(index)) {
        throw new Error(`Circular dependency detected for task ${index}`);
      }
      if (visited.has(index)) return;

      visiting.add(index);
      if (task.dependencies) {
        for (const depTaskId of task.dependencies) {
          /**
           * Dependency Resolution Strategy:
           * 1. First, try to find by taskId (unique task identifier)
           * 2. Fallback to agentId (UUID) for flexibility
           *
           * Note: When multiple tasks exist for the same agent, use taskId
           * to specify which specific task is the dependency. Using agentId
           * will match the first task for that agent, which may not be intended.
           *
           * Example:
           * - taskId: "validate-input" -> Matches specific task
           * - agentId: "uuid-xxx" -> Matches first task for agent
           */
          const depIndex = tasks.findIndex(
            (t) => t.taskId === depTaskId || t.agentId === depTaskId
          );
          if (depIndex !== -1) {
            visit(depIndex, depth + 1);
          } else {
            this.logger?.warn(
              `Dependency not found: ${depTaskId}. Ensure taskId or agentId matches a defined task.`
            );
          }
        }
      }
      visiting.delete(index);
      visited.add(index);
      sorted.push(task);
    };

    // Sort by priority first (using nullish coalescing for falsy priority values like 0)
    const prioritySorted = tasks
      .map((task, index) => ({ task, index }))
      .sort((a, b) => (b.task.priority ?? 0) - (a.task.priority ?? 0));

    for (const { index } of prioritySorted) {
      visit(index, 0);
    }

    return sorted;
  }

  /**
   * Enhance task with context from previous results
   */
  private enhanceTaskWithContext(
    task: SubAgentTask,
    previousResults: SubAgentResult[]
  ): SubAgentTask {
    if (!task.dependencies || task.dependencies.length === 0) {
      return task;
    }

    // Get results from dependency agents
    const deps = task.dependencies ?? [];
    const dependencyResults = previousResults.filter((r) => deps.includes(r.agentId) && r.success);

    if (dependencyResults.length === 0) {
      return task;
    }

    // Build context string from dependency results
    const contextParts = dependencyResults.map((r) => `Result from ${r.agentName}: ${r.result}`);

    const enhancedTask = `Previous context:\n${contextParts.join('\n\n')}\n\nBased on the above context, ${task.task}`;

    return {
      ...task,
      task: enhancedTask,
    };
  }

  /**
   * Aggregate results from all sub-agents into a final result
   */
  private aggregateResults(results: SubAgentResult[]): string {
    if (results.length === 0) {
      return 'No results from sub-agents';
    }

    if (results.length === 1) {
      return results[0].result;
    }

    // For multiple results, create a comprehensive summary
    const successfulResults = results.filter((r) => r.success);

    if (successfulResults.length === 0) {
      return 'All sub-agent tasks failed';
    }

    const resultSections = successfulResults.map((r) => `## ${r.agentName} Results\n\n${r.result}`);

    return resultSections.join('\n\n---\n\n');
  }
}
