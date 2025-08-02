import { IAgentModule, IAgent } from '../agent/types';
import { Task } from '../task';
import { Graph } from '../graph';
// TaskType and GraphType imports removed as unused
import { Logger } from '../logger/types';
import { getSchedulerStorage, SchedulerStorage } from './storage';
import {
  Schedule,
  ScheduledItem,
  SchedulerConfig,
  ScheduledTaskRequest,
  ScheduledGraphRequest,
  ScheduledNodeRequest,
  ScheduleCalculationResult,
  ScheduleOptions
} from './types';

export class Scheduler implements IAgentModule {
  readonly name = 'scheduler';
  private storage: SchedulerStorage;
  private logger: Logger;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private config: SchedulerConfig;
  private runningJobs = new Set<string>();

  constructor(private agent: IAgent, config: SchedulerConfig = {}) {
    this.logger = agent.logger;
    this.storage = getSchedulerStorage();
    this.config = {
      checkInterval: 30000, // Check every 30 seconds
      maxConcurrentJobs: 5,
      enableRecurring: true,
      timezone: 'UTC',
      ...config
    };
  }

  async initialize(): Promise<void> {
    await this.storage.initializeTables();
  }

  // Schedule a task for future execution
  async scheduleTask(request: ScheduledTaskRequest): Promise<ScheduledItem> {
    this.logger.info('Scheduling new task');
    
    const taskModule = new Task(this.agent);
    await taskModule.initialize();

    // Create the task first
    const task = await taskModule.createTask({
      prompt: request.prompt,
      useTools: request.useTools,
      mcpServers: request.mcpServers,
      plugins: request.plugins,
      attachments: request.attachments,
      metadata: {
        ...request.metadata,
        scheduled: true,
        scheduleType: request.schedule.type,
        executeAt: request.schedule.executeAt.toISOString()
      }
    });

    // Calculate next execution time
    const nextExecution = this.calculateNextExecution(request.schedule);
    
    // Create scheduled item
    const scheduledItem: ScheduledItem = {
      id: `task_${task.id}_${Date.now()}`,
      type: 'task',
      schedule: request.schedule,
      targetId: task.id!.toString(),
      agentId: this.agent.id,
      status: 'pending',
      executionCount: 0,
      nextExecutionAt: nextExecution.nextExecution || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: request.options ? {
        maxRetries: request.options.maxRetries || 0,
        retryDelay: request.options.retryDelay || 0,
        timeout: request.options.timeout || 0,
        respectDependencies: request.options.respectDependencies !== false
      } : undefined
    };

    // Save to database
    await this.storage.saveScheduledItem(scheduledItem);

    this.logger.info(`Task scheduled for execution at ${nextExecution.nextExecution?.toISOString()}`);
    return scheduledItem;
  }

  // Schedule a graph for future execution
  async scheduleGraph(request: ScheduledGraphRequest): Promise<ScheduledItem> {
    this.logger.info('Scheduling new graph');
    
    const nextExecution = this.calculateNextExecution(request.schedule);
    
    const scheduledItem: ScheduledItem = {
      id: `graph_${request.graphId}_${Date.now()}`,
      type: 'graph',
      schedule: request.schedule,
      targetId: request.graphId,
      agentId: this.agent.id,
      status: 'pending',
      executionCount: 0,
      nextExecutionAt: nextExecution.nextExecution || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: request.options ? {
        maxRetries: request.options.maxRetries || 0,
        retryDelay: request.options.retryDelay || 0,
        timeout: request.options.timeout || 0,
        respectDependencies: request.options.respectDependencies !== false
      } : undefined
    };

    await this.storage.saveScheduledItem(scheduledItem);

    this.logger.info(`Graph scheduled for execution at ${nextExecution.nextExecution?.toISOString()}`);
    return scheduledItem;
  }

  // Schedule a specific node within a graph
  async scheduleGraphNode(request: ScheduledNodeRequest): Promise<ScheduledItem> {
    this.logger.info('Scheduling graph node');
    
    const nextExecution = this.calculateNextExecution(request.schedule);
    
    const scheduledItem: ScheduledItem = {
      id: `node_${request.graphId}_${request.nodeId}_${Date.now()}`,
      type: 'graph_node',
      schedule: request.schedule,
      targetId: `${request.graphId}:${request.nodeId}`,
      agentId: this.agent.id,
      status: 'pending',
      executionCount: 0,
      nextExecutionAt: nextExecution.nextExecution || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: request.options ? {
        maxRetries: request.options.maxRetries || 0,
        retryDelay: request.options.retryDelay || 0,
        timeout: request.options.timeout || 0,
        respectDependencies: request.options.respectDependencies !== false
      } : undefined
    };

    await this.storage.saveScheduledItem(scheduledItem);

    this.logger.info(`Graph node scheduled for execution at ${nextExecution.nextExecution?.toISOString()}`);
    return scheduledItem;
  }

  // Start the scheduler daemon
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Scheduler is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info(`Starting scheduler with check interval: ${this.config.checkInterval}ms`);

    this.intervalId = setInterval(async () => {
      try {
        await this.processScheduledItems();
      } catch (error) {
        this.logger.error('Error in scheduler processing', error instanceof Error ? error : undefined);
      }
    }, this.config.checkInterval);
  }

  // Stop the scheduler daemon
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Wait for running jobs to complete
    const maxWait = 30000; // 30 seconds
    const waitStart = Date.now();
    
    while (this.runningJobs.size > 0 && (Date.now() - waitStart) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.logger.info('Scheduler stopped');
  }

  // Process scheduled items that are due for execution
  private async processScheduledItems(): Promise<void> {
    if (this.runningJobs.size >= this.config.maxConcurrentJobs!) {
      return; // Already at max capacity
    }

    const now = new Date();
    const availableSlots = this.config.maxConcurrentJobs! - this.runningJobs.size;

    // Get items that are due for execution
    const dueItems = await this.storage.getDueScheduledItems(this.agent.id, now, availableSlots);

    for (const item of dueItems) {
      if (this.runningJobs.size >= this.config.maxConcurrentJobs!) {
        break;
      }

      this.executeScheduledItem(item).catch(error => {
        this.logger.error(`Failed to execute scheduled item ${item.id}`, error instanceof Error ? error : undefined);
      });
    }
  }

  // Execute a scheduled item
  private async executeScheduledItem(item: ScheduledItem): Promise<void> {
    this.runningJobs.add(item.id);
    
    try {
      this.logger.info(`Executing scheduled ${item.type}: ${item.id}`);
      
      // Mark as running
      await this.storage.updateScheduledItem(item.id, this.agent.id, {
        status: 'running',
        updatedAt: new Date()
      });

      // Execute based on type
      switch (item.type) {
        case 'task':
          await this.executeScheduledTask(item);
          break;
        case 'graph':
          await this.executeScheduledGraph(item);
          break;
        case 'graph_node':
          await this.executeScheduledGraphNode(item);
          break;
        default:
          throw new Error(`Unknown scheduled item type: ${(item as ScheduledItem & { type: string }).type}`);
      }

      // Mark as completed and update execution count
      const nextExecution = this.calculateNextExecution(item.schedule, item.executionCount + 1);
      
      await this.storage.updateScheduledItem(item.id, this.agent.id, {
        status: nextExecution.shouldContinue ? 'pending' : 'completed',
        executionCount: item.executionCount + 1,
        lastExecutedAt: new Date(),
        nextExecutionAt: nextExecution.nextExecution || undefined,
        updatedAt: new Date()
      });

      this.logger.info(`Scheduled ${item.type} completed: ${item.id}`);

    } catch (error) {
      this.logger.error(`Scheduled ${item.type} failed: ${item.id}`, error instanceof Error ? error : undefined);
      
      await this.storage.updateScheduledItem(item.id, this.agent.id, {
        status: 'failed',
        updatedAt: new Date()
      });
    } finally {
      this.runningJobs.delete(item.id);
    }
  }

  // Execute a scheduled task
  private async executeScheduledTask(item: ScheduledItem): Promise<void> {
    const taskModule = new Task(this.agent);
    await taskModule.initialize();

    const taskId = parseInt(item.targetId as string);
    const options = item.metadata as ScheduleOptions;

    await taskModule.executeTask(taskId, {
      model: options?.timeout ? undefined : undefined, // Could add model selection here
      stream: false
    });
  }

  // Execute a scheduled graph
  private async executeScheduledGraph(item: ScheduledItem): Promise<void> {
    // Load the graph using the static method
    const graph = await Graph.findById(parseInt(item.targetId as string));
    if (!graph) {
      throw new Error(`Graph not found: ${item.targetId}`);
    }

    await graph.run({ stream: false });
  }

  // Execute a scheduled graph node
  private async executeScheduledGraphNode(item: ScheduledItem): Promise<void> {
    const [graphId, nodeId] = (item.targetId as string).split(':');
    const options = item.metadata as Record<string, unknown>; // Use flexible type for metadata

    // Load the graph
    const graph = await Graph.findById(parseInt(graphId));
    if (!graph) {
      throw new Error(`Graph not found: ${graphId}`);
    }

    // Find the specific node
    const nodes = graph.getNodes();
    const node = nodes.find((n: { id: string }) => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId} in graph ${graphId}`);
    }

    // Check dependencies if required
    if (options?.respectDependencies) {
      const dependenciesCompleted = node.dependencies.every((depId: string) => {
        const depNode = nodes.find((n: { id: string }) => n.id === depId);
        return depNode?.status === 'completed';
      });

      if (!dependenciesCompleted) {
        throw new Error(`Dependencies not completed for node: ${nodeId}`);
      }
    }

    // Execute the specific node (this would need to be implemented in Graph class)
    // For now, we'll execute the entire graph
    await graph.run({ stream: false });
  }

  // Calculate next execution time
  private calculateNextExecution(schedule: Schedule, currentCount = 0): ScheduleCalculationResult {
    const { executeAt, recurrence, type } = schedule;
    
    if (type === 'once') {
      if (currentCount === 0) {
        return { nextExecution: executeAt, shouldContinue: true };
      } else {
        return { nextExecution: null, shouldContinue: false, reason: 'One-time schedule completed' };
      }
    }

    if (!recurrence) {
      return { nextExecution: null, shouldContinue: false, reason: 'No recurrence configuration' };
    }

    // Check max executions
    if (recurrence.maxExecutions && currentCount >= recurrence.maxExecutions) {
      return { nextExecution: null, shouldContinue: false, reason: 'Maximum executions reached' };
    }

    // Check end date
    if (recurrence.endDate && new Date() >= recurrence.endDate) {
      return { nextExecution: null, shouldContinue: false, reason: 'End date reached' };
    }

    // Calculate next execution based on pattern
    const interval = recurrence.interval || 1;
    const nextDate = new Date(executeAt);

    switch (recurrence.pattern) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + (interval * (currentCount + 1)));
        break;
      case 'weekly':
        nextDate.setDate(nextDate.getDate() + (7 * interval * (currentCount + 1)));
        break;
      case 'monthly':
        nextDate.setMonth(nextDate.getMonth() + (interval * (currentCount + 1)));
        break;
      case 'yearly':
        nextDate.setFullYear(nextDate.getFullYear() + (interval * (currentCount + 1)));
        break;
      case 'custom':
        // For custom cron expressions, you'd need a cron parser here
        // For now, fallback to daily
        nextDate.setDate(nextDate.getDate() + (currentCount + 1));
        break;
    }

    return { nextExecution: nextDate, shouldContinue: true };
  }



  // Public API methods
  async listScheduledItems(status?: string): Promise<ScheduledItem[]> {
    return await this.storage.listScheduledItems(this.agent.id, status);
  }

  async getScheduledItem(id: string): Promise<ScheduledItem | null> {
    return await this.storage.getScheduledItem(id, this.agent.id);
  }

  async cancelScheduledItem(id: string): Promise<void> {
    await this.storage.updateScheduledItem(id, this.agent.id, {
      status: 'cancelled',
      updatedAt: new Date()
    });

    this.logger.info(`Cancelled scheduled item: ${id}`);
  }

  async deleteScheduledItem(id: string): Promise<void> {
    await this.storage.deleteScheduledItem(id, this.agent.id);

    this.logger.info(`Deleted scheduled item: ${id}`);
  }

  // Health check
  getSchedulerStatus(): { running: boolean; activeJobs: number; config: SchedulerConfig } {
    return {
      running: this.isRunning,
      activeJobs: this.runningJobs.size,
      config: this.config
    };
  }

  // Alias methods for cleaner agent API
  async startScheduler(config?: Partial<SchedulerConfig>): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    await this.start();
  }

  async stopScheduler(): Promise<void> {
    await this.stop();
  }
}

// Export types
export * from './types';