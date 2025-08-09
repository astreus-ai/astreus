/**
 * SubAgent module - Manages sub-agent coordination and delegation
 */
import { IAgentModule, IAgent, AskOptions } from '../agent/types';
import { SubAgentCoordinator } from './coordination';
import { getDelegationStrategy } from './delegation';
import { SubAgentCoordinationResult } from './types';
import { Logger } from '../logger/types';

export class SubAgent implements IAgentModule {
  readonly name = 'subAgent';
  private coordinator: SubAgentCoordinator;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    this.coordinator = new SubAgentCoordinator(logger);
  }

  async initialize(): Promise<void> {
    this.logger?.debug('SubAgent module initialized');
  }

  /**
   * Execute task using sub-agents
   */
  async executeWithSubAgents(
    prompt: string,
    subAgents: IAgent[],
    options: AskOptions = {},
    mainAgentModel?: string
  ): Promise<string> {
    if (!subAgents || subAgents.length === 0) {
      throw new Error('No sub-agents provided');
    }

    this.logger?.info(`Executing task with ${subAgents.length} sub-agents`, {
      delegation: options.delegation || 'auto',
      coordination: options.coordination || 'parallel',
    });

    try {
      // Get delegation strategy
      const delegationType = options.delegation || 'auto';
      const strategy = getDelegationStrategy(delegationType, this.logger);

      // Delegate tasks to sub-agents
      const tasks = await strategy.delegate(prompt, subAgents, options, mainAgentModel);

      this.logger?.debug(`Generated ${tasks.length} tasks for sub-agents`, {
        taskCount: tasks.length,
        agentIds: tasks.map((t) => t.agentId),
        priorities: tasks.map((t) => t.priority || 0),
      });

      if (tasks.length === 0) {
        throw new Error('No tasks generated for sub-agents');
      }

      // Execute tasks with coordination
      const coordination = options.coordination || 'parallel';
      const result = await this.coordinator.executeSubAgentTasks(tasks, subAgents, coordination);

      if (!result.success) {
        this.logger?.warn('Sub-agent execution completed with errors', {
          errors: result.errors,
          successfulResults: result.results.filter((r) => r.success).length,
        });
      }

      return result.finalResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('Sub-agent execution failed', error as Error);
      throw new Error(`Sub-agent execution failed: ${errorMessage}`);
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

    // Get delegation strategy
    const delegationType = options.delegation || 'auto';
    const strategy = getDelegationStrategy(delegationType, this.logger);

    // Delegate tasks to sub-agents
    const tasks = await strategy.delegate(prompt, subAgents, options, mainAgentModel);

    if (tasks.length === 0) {
      throw new Error('No tasks generated for sub-agents');
    }

    // Execute tasks with coordination
    const coordination = options.coordination || 'parallel';
    return await this.coordinator.executeSubAgentTasks(tasks, subAgents, coordination);
  }

  /**
   * Check if an agent has sub-agents
   */
  hasSubAgents(agent: IAgent): boolean {
    return !!(agent.config.subAgents && agent.config.subAgents.length > 0);
  }

  /**
   * Get sub-agents for an agent
   */
  getSubAgents(agent: IAgent): IAgent[] {
    return agent.config.subAgents || [];
  }
}

// Export types and utilities
export * from './types';
export * from './delegation';
export * from './coordination';
