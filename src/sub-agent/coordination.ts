/**
 * Sub-agent coordination and result management
 */
import { IAgent } from '../agent/types';
import { SubAgentTask, SubAgentResult, SubAgentCoordinationResult } from './types';
import { Logger } from '../logger/types';

/**
 * Coordinates execution of sub-agent tasks and manages results
 */
export class SubAgentCoordinator {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Execute sub-agent tasks with coordination
   */
  async executeSubAgentTasks(
    tasks: SubAgentTask[],
    subAgents: IAgent[],
    coordination: 'parallel' | 'sequential' = 'parallel'
  ): Promise<SubAgentCoordinationResult> {
    const startTime = Date.now();
    const results: SubAgentResult[] = [];
    const errors: string[] = [];

    try {
      if (coordination === 'parallel') {
        await this.executeParallel(tasks, subAgents, results, errors);
      } else {
        await this.executeSequential(tasks, subAgents, results, errors);
      }

      // Generate final result from all sub-agent results
      const finalResult = this.aggregateResults(results);

      const totalExecutionTime = Date.now() - startTime;

      this.logger?.info(`Sub-agent coordination completed in ${totalExecutionTime}ms`, {
        coordination,
        tasksExecuted: tasks.length,
        successfulResults: results.filter((r) => r.success).length,
        errors: errors.length,
      });

      return {
        success: errors.length === 0,
        results,
        finalResult,
        totalExecutionTime,
        errors,
      };
    } catch (error) {
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

    for (const taskResult of taskResults) {
      if (taskResult.status === 'fulfilled') {
        results.push(taskResult.value);
      } else {
        const errorMessage =
          taskResult.reason instanceof Error
            ? taskResult.reason.message
            : String(taskResult.reason);
        errors.push(errorMessage);
        this.logger?.error('Sub-agent task failed', taskResult.reason);
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

    for (const task of sortedTasks) {
      try {
        // Build context from previous results
        const enhancedTask = this.enhanceTaskWithContext(task, results);
        const result = await this.executeTask(enhancedTask, subAgents);
        results.push(result);

        this.logger?.debug(`Sub-agent task completed: ${result.agentName}`, {
          agentId: result.agentId,
          success: result.success,
          executionTime: result.executionTime,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(errorMessage);
        this.logger?.error('Sub-agent task failed in sequential execution', error as Error);

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
      throw new Error(`Agent with ID ${task.agentId} not found`);
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
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        agentId: agent.id,
        agentName: agent.name,
        task: task.task,
        result: '',
        success: false,
        error: errorMessage,
        executionTime,
      };
    }
  }

  /**
   * Sort tasks by dependencies to ensure proper execution order
   */
  private sortTasksByDependencies(tasks: SubAgentTask[]): SubAgentTask[] {
    const sorted: SubAgentTask[] = [];
    const visited = new Set<number>();
    const visiting = new Set<number>();

    const visit = (task: SubAgentTask) => {
      if (visiting.has(task.agentId)) {
        throw new Error(`Circular dependency detected for agent ${task.agentId}`);
      }

      if (visited.has(task.agentId)) {
        return;
      }

      visiting.add(task.agentId);

      // Visit dependencies first
      if (task.dependencies) {
        for (const depId of task.dependencies) {
          const depTask = tasks.find((t) => t.agentId === depId);
          if (depTask) {
            visit(depTask);
          }
        }
      }

      visiting.delete(task.agentId);
      visited.add(task.agentId);
      sorted.push(task);
    };

    // Sort by priority first, then handle dependencies
    const prioritySorted = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const task of prioritySorted) {
      if (!visited.has(task.agentId)) {
        visit(task);
      }
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
    const dependencyResults = previousResults.filter(
      (r) => task.dependencies!.includes(r.agentId) && r.success
    );

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
