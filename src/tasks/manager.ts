import {
  TaskManagerInstance,
  TaskConfig,
  TaskInstance,
  TaskResult,
  TaskManagerConfig
} from "../types/task";
import { MemoryInstance } from "../types/memory";
import { ProviderModel } from "../types/provider";
import { createDatabase, DatabaseInstance } from "../database";
import { logger } from "../utils";
import { Task } from "./task";

/**
 * Task Manager class that manages multiple tasks
 * 
 * This class provides functionality for:
 * - Creating and managing multiple tasks
 * - Executing tasks with dependencies in order
 * - Persisting task state to the database
 * - Restoring tasks from previous sessions
 */
export class TaskManager implements TaskManagerInstance {
  private readonly tasks = new Map<string, TaskInstance>();
  private tasksLoaded = false;
  private loadingPromise: Promise<void> | null = null;
  private config: TaskManagerConfig;
  private agentId?: string;
  private sessionId?: string;
  private memory?: MemoryInstance;
  private database?: DatabaseInstance;

  /**
   * Create a new TaskManager instance
   * @param config Configuration options for the task manager
   */
  constructor(config?: TaskManagerConfig) {
    this.config = config || { concurrency: 5 };
    this.agentId = config?.agentId;
    this.sessionId = config?.sessionId;
    this.memory = config?.memory;
    this.database = config?.database;

    // Load existing tasks from the database
    this.loadTasksFromDatabase().catch((err) => {
      logger.error("Error loading tasks from database:", err);
    });
    
    logger.info("Task manager initialized");
  }

  /**
   * Add an existing task to the manager
   * @param task Task instance or configuration to add
   * @param model Optional LLM model to use for tool selection
   * @returns The added task instance
   */
  public addExistingTask(task: TaskInstance | TaskConfig, model?: ProviderModel): TaskInstance {
    try {
      // If this is a configuration, first check if we already have this task by ID
      if (!(task instanceof Task) && task.id) {
        // Look for existing task in our memory
        const existingTask = this.tasks.get(task.id);
        if (existingTask) {
          logger.debug(`Task ${task.id} already exists in manager, returning existing instance`);
          return existingTask;
        }
      }
      
      // Ensure task.plugins only contains string values
      if (!(task instanceof Task) && task.plugins) {
        const validPlugins = task.plugins.filter(plugin => typeof plugin === 'string');
        if (validPlugins.length !== task.plugins.length) {
          logger.warn(`TaskManager: Filtered out ${task.plugins.length - validPlugins.length} invalid plugins from task config`);
          task.plugins = validPlugins;
        }
      }
      
      // If this is not already a Task instance, create one
      const taskInstance =
        task instanceof Task
          ? task
          : new Task(
              {
                ...(task as TaskConfig),
                agentId: task.agentId || this.agentId,
                sessionId: task.sessionId || this.sessionId,
              },
              this.memory,
              model,
              this.database
            );

      // If task was created without memory, set it now
      if (this.memory && taskInstance instanceof Task) {
        taskInstance.setMemory(this.memory);
      }

      // Add task to memory
      this.tasks.set(taskInstance.id, taskInstance);

      // Check for a parent in dependencies and add it if needed
      this.addTaskWithParent(taskInstance);

      // Ensure the task is saved to the database - but don't immediately await
      // This helps prevent duplicate requests and race conditions
      if (!taskInstance.savePromise) {
        taskInstance.savePromise = taskInstance.saveToDatabase()
          .catch(err => {
            // Log error but don't fail the add operation
            logger.error(`Error saving task ${taskInstance.id} to database:`, err);
          });
      }
      
      logger.debug(`Task "${taskInstance.config.name}" (${taskInstance.id}) added to manager`);
      
      return taskInstance;
    } catch (error) {
      logger.error("Error adding existing task:", error);
      throw error;
    }
  }

  /**
   * Helper method to check for parent ID in dependencies and add it if needed
   * @param task Task to check for parent dependencies
   */
  private addTaskWithParent(task: TaskInstance): void {
    try {
      // Add parent dependency if it exists
      if (task.config.dependencies && task.config.dependencies.length > 0) {
        const parentId = task.config.dependencies[0];
        const parent = this.getTask(parentId);
        if (parent) {
          // Parent exists, nothing to do
          return;
        }
        // Parent doesn't exist, warn about it
        logger.warn(`Parent task ${parentId} not found for task ${task.id}`);
      }
    } catch (error) {
      logger.error(`Error checking parent dependencies for task ${task.id}:`, error);
    }
  }

  /**
   * Get a task by ID
   * @param id ID of the task to retrieve
   * @returns Task instance if found, undefined otherwise
   */
  public getTask(id: string): TaskInstance | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks managed by this instance
   * @returns Array of all task instances
   */
  public getAllTasks(): TaskInstance[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Create and add a new task
   * @param config Configuration for the new task
   * @param model Optional LLM model to use for tool selection
   * @returns The created task instance
   */
  public async createTask(config: TaskConfig, model?: ProviderModel): Promise<TaskInstance> {
    try {
      // Create task with the manager's agent and session IDs if not provided
      const updatedConfig = {
        ...config,
        agentId: config.agentId || this.agentId,
        sessionId: config.sessionId || this.sessionId,
      };

      // Create the task with memory and database
      const task = await Task.createTask(updatedConfig, this.memory, model, this.database);

      // Add task to manager
      this.addExistingTask(task);
      
      logger.info(`Created new task: "${task.config.name}" (${task.id})`);

      return task;
    } catch (error) {
      logger.error("Error creating task:", error);
      throw error;
    }
  }

  /**
   * Cancel a task by ID
   * @param id ID of the task to cancel
   * @returns true if task was found and canceled, false otherwise
   */
  public cancelTask(id: string): boolean {
    try {
      const task = this.getTask(id);
      if (task) {
        task.cancel();
        logger.info(`Task ${id} canceled`);
        return true;
      }
      logger.warn(`Task ${id} not found for cancellation`);
      return false;
    } catch (error) {
      logger.error(`Error canceling task ${id}:`, error);
      return false;
    }
  }

  /**
   * Load tasks from database
   * @returns Promise that resolves when tasks are loaded
   */
  private async loadTasksFromDatabase(): Promise<void> {
    // Set loading flag
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      try {
        // Use database from config if provided, otherwise create a new one
        const db = this.database || await createDatabase();
        const tasksTable = db.getTable("tasks");

        // Get all tasks or filter by session/agent ID if provided
        const filter: any = {};
        if (this.sessionId) {
          filter.sessionId = this.sessionId;
        } else if (this.agentId) {
          filter.agentId = this.agentId;
        }

        const taskRecords = await tasksTable.find(filter);
        logger.info(`Loading ${taskRecords.length} tasks from database`);

        // Convert database records to Task instances
        for (const record of taskRecords) {
          try {
            // Reconstruct the task config
            const taskConfig: TaskConfig = {
              id: record.id,
              name: record.name,
              description: record.description,
              plugins: JSON.parse(record.plugins || "[]"),
              input: JSON.parse(record.input || "null"),
              dependencies: JSON.parse(record.dependencies || "[]"),
              maxRetries: 0, // Default value, could be stored in DB
              agentId: record.agentId,
              sessionId: record.sessionId,
            };

            // Create task instance
            const task = new Task(taskConfig, this.memory);

            // Restore task state
            task.status = record.status as any;
            task.retries = record.retries;
            if (record.startedAt) task.startedAt = new Date(record.startedAt);
            if (record.completedAt)
              task.completedAt = new Date(record.completedAt);
            if (record.result) {
              try {
                task.result = JSON.parse(record.result);
              } catch (e) {
                logger.error(`Error parsing result for task ${record.id}:`, e);
              }
            }

            // Add task to manager without saving (it's already in DB)
            this.tasks.set(task.id, task);
            logger.debug(`Loaded task "${task.config.name}" (${task.id}) from database`);
          } catch (error) {
            logger.error(`Error loading task ${record.id}:`, error);
          }
        }

        this.tasksLoaded = true;
        logger.info(`Successfully loaded ${this.tasks.size} tasks from database`);
      } catch (error) {
        logger.error("Error loading tasks from database:", error);
        this.tasksLoaded = true; // Set to true so we don't keep trying
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  /**
   * Wait for tasks to be loaded from database
   * @returns Promise that resolves when tasks are loaded
   */
  public async waitForTasksLoaded(): Promise<void> {
    if (this.tasksLoaded) {
      return;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    // If tasks haven't been loaded yet, load them now
    return this.loadTasksFromDatabase();
  }

  /**
   * Execute a specific task by ID
   * @param id ID of the task to execute
   * @param input Optional input data to pass to the task
   * @returns Promise that resolves with the task execution result
   */
  public async executeTask(id: string, input?: any): Promise<TaskResult> {
    try {
      await this.waitForTasksLoaded();
      
      const task = this.getTask(id);
      if (!task) {
        throw new Error(`Task with ID ${id} not found`);
      }

      logger.info(`Executing task: "${task.config.name}" (${id})`);
      return task.execute(input);
    } catch (error) {
      logger.error(`Error executing task ${id}:`, error);
      throw error;
    }
  }

  /**
   * Get all tasks
   * @deprecated Use getAllTasks() instead for newer implementations
   * @returns Array of all task instances
   */
  public getTasks(): TaskInstance[] {
    logger.debug("DEPRECATED: getTasks() called, use getAllTasks() instead");
    return this.getAllTasks();
  }

  /**
   * Get tasks by agent ID
   * @param agentId Agent ID to filter by
   * @returns Array of tasks belonging to the specified agent
   */
  public getTasksByAgent(agentId: string): TaskInstance[] {
    return Array.from(this.tasks.values()).filter(
      (task) => task.config.agentId === agentId
    );
  }

  /**
   * Get tasks by session ID
   * @param sessionId Session ID to filter by
   * @returns Array of tasks belonging to the specified session
   */
  public getTasksBySession(sessionId: string): TaskInstance[] {
    return Array.from(this.tasks.values()).filter(
      (task) => task.config.sessionId === sessionId
    );
  }

  /**
   * Set the agent ID for this task manager
   * @param agentId Agent ID to set
   */
  public setAgentId(agentId: string): void {
    this.agentId = agentId;
    logger.debug(`Task manager agent ID set to ${agentId}`);
  }

  /**
   * Set the session ID for this task manager
   * @param sessionId Session ID to set
   */
  public setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    logger.debug(`Task manager session ID set to ${sessionId}`);
  }

  /**
   * Set the memory instance for this task manager
   * @param memory Memory instance to use for task context storage
   */
  public setMemory(memory: MemoryInstance): void {
    try {
      this.memory = memory;
      
      // Update memory for all tasks
      for (const task of this.tasks.values()) {
        if (task instanceof Task) {
          task.setMemory(memory);
        }
      }
      
      logger.debug("Memory instance set for task manager");
    } catch (error) {
      logger.error("Error setting memory for task manager:", error);
      throw error;
    }
  }

  /**
   * Run specified tasks (or all if no IDs provided)
   * @param taskIds Optional array of task IDs to run
   * @returns Promise that resolves with a map of task IDs to results
   */
  public async run(taskIds?: string[]): Promise<Map<string, TaskResult>> {
    await this.waitForTasksLoaded();
    
    const results = new Map<string, TaskResult>();
    let tasksToRun: TaskInstance[];

    // Determine which tasks to run
    if (taskIds && taskIds.length > 0) {
      tasksToRun = taskIds
        .map((id) => this.getTask(id))
        .filter((task): task is TaskInstance => !!task);
      
      logger.info(`Running ${tasksToRun.length} specified tasks`);
    } else {
      tasksToRun = this.getAllTasks();
      logger.info(`Running all ${tasksToRun.length} tasks`);
    }

    // Execute tasks with proper concurrency
    const concurrency = this.config.concurrency || 5;
    const runningTasks: Promise<void>[] = [];
    
    for (const task of tasksToRun) {
      // Create a promise that executes the task and stores its result
      const taskPromise = task.execute().then(result => {
        results.set(task.id, result);
      }).catch(error => {
        logger.error(`Error executing task ${task.id}:`, error);
        results.set(task.id, {
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        });
      });
      
      runningTasks.push(taskPromise);
      
      // If we've reached concurrency limit, wait for one task to complete
      if (runningTasks.length >= concurrency) {
        await Promise.race(runningTasks);
        // Remove completed tasks from the array
        const completedTaskPromises = runningTasks.filter(promise => 
          promise.then(() => true, () => true)
        );
        for (const completedPromise of completedTaskPromises) {
          const index = runningTasks.indexOf(completedPromise);
          if (index >= 0) {
            runningTasks.splice(index, 1);
          }
        }
      }
    }
    
    // Wait for all remaining tasks to complete
    await Promise.all(runningTasks);
    
    logger.info(`Completed running ${tasksToRun.length} tasks`);
    return results;
  }

  /**
   * Cancel a specific task
   * @deprecated Use cancelTask() instead for newer implementations
   * @param taskId ID of the task to cancel
   * @returns true if task was found and canceled, false otherwise
   */
  public cancel(taskId: string): boolean {
    logger.debug("DEPRECATED: cancel() called, use cancelTask() instead");
    return this.cancelTask(taskId);
  }

  /**
   * Cancel all tasks
   */
  public cancelAll(): void {
    try {
      for (const task of this.tasks.values()) {
        task.cancel();
      }
      logger.info(`Canceled all ${this.tasks.size} tasks`);
    } catch (error) {
      logger.error("Error canceling all tasks:", error);
    }
  }
} 