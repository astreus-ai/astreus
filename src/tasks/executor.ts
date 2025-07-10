import { v4 as _uuidv4 } from "uuid";
import {
  TaskManagerInstance,
  TaskConfig,
  TaskInstance,
  TaskResult,
  TaskManagerConfig,
  TaskStatus,
} from "../types";
import { MemoryInstance, DatabaseInstance, ProviderModel } from "../types";
import { createDatabase } from "../database";
import { logger } from "../utils";
import { Task } from "./task";
import { validateRequiredParam as _validateRequiredParam } from "../utils/validation";

/**
 * Task Executor class that manages multiple tasks
 * 
 * This class provides functionality for:
 * - Creating and managing multiple tasks
 * - Executing tasks with dependencies in order
 * - Persisting task state to the database
 * - Restoring tasks from previous sessions
 */
export class TaskExecutor implements TaskManagerInstance {
  private readonly tasks = new Map<string, TaskInstance>();
  private tasksLoaded = false;
  private loadingPromise: Promise<void> | null = null;
  private config: TaskManagerConfig;
  private agentId?: string;
  private sessionId?: string;
  private memory?: MemoryInstance;
  private database?: DatabaseInstance;
  private providerModel?: ProviderModel;

  /**
   * Create a new TaskExecutor instance
   * @param config Configuration options for the task executor
   */
  constructor(config?: TaskManagerConfig) {
    logger.info("System", "TaskExecutor", "Initializing task executor");
    
    this.config = config || {};
    this.agentId = config?.agentId;
    this.sessionId = config?.sessionId;
    this.memory = config?.memory;
    this.database = config?.database;
    this.providerModel = config?.providerModel;
    
    logger.debug("System", "TaskExecutor", `Configuration: agent=${this.agentId || 'none'}, session=${this.sessionId || 'none'}`);;

    // Load existing tasks from the database
    this.loadTasksFromDatabase().catch((err) => {
      logger.error("System", "TaskExecutor", `Error loading tasks from database: ${err}`);
    });
    
    logger.success("System", "TaskExecutor", "Task executor initialized");
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
          logger.warn("System", "TaskExecutor", `Filtered out ${task.plugins.length - validPlugins.length} invalid plugins from task config`);
          task.plugins = validPlugins;
        }
      }
      
      // Determine which model to use, in order of preference:
      // 1. Explicitly provided model parameter
      // 2. Task's model (if task is a config with model)
      // 3. TaskManager's providerModel
      let taskModel = model;
      if (!taskModel) {
        if (task instanceof Task) {
          taskModel = task.config.model;
        } else if ('model' in task) {
          taskModel = task.model;
        }
      }
      if (!taskModel && this.providerModel) {
        taskModel = this.providerModel;
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
                model: taskModel  // Pass the determined model to the task
              },
              this.memory,
              undefined,  // No need to pass model here as we already set it in config
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

      // Task is already saved to database via createTask static method
      
      logger.debug(`Task "${taskInstance.config.name}" (${taskInstance.id}) added to manager`);
      
      return taskInstance;
    } catch (error) {
      logger.error("System", "TaskExecutor", `Error adding existing task: ${error}`);
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
        logger.warn("System", "TaskExecutor", `Parent task ${parentId} not found for task ${task.id}`);
      }
    } catch (error) {
              logger.error("System", "TaskExecutor", `Error checking parent dependencies for task ${task.id}: ${error}`);
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
    logger.info("System", "TaskExecutor", `Creating task: ${config.name}`);
    
    try {
      // Determine which model to use, in order of preference:
      // 1. Explicitly provided model parameter
      // 2. Task's model (from config)
      // 3. TaskManager's providerModel
      let taskModel = model;
      if (!taskModel && config.model) {
        taskModel = config.model;
      }
      if (!taskModel && this.providerModel) {
        taskModel = this.providerModel;
      }
      
      logger.debug("System", "TaskExecutor", `Task model selected: ${taskModel ? 'available' : 'none'}`);

      // Create task instance using the static factory method
      const task = await Task.createTask(
        {
          ...config,
          agentId: config.agentId || this.agentId,
          sessionId: config.sessionId || this.sessionId,
          model: taskModel
        },
        this.memory,
        taskModel,
        this.database
      );

      // Add the task to our manager
      this.tasks.set(task.id, task);
      
      logger.success("System", "TaskExecutor", `Task created and added: ${config.name} (ID: ${task.id})`);
      return task;
    } catch (error) {
      logger.error("System", "TaskExecutor", `Error creating task: ${error}`);
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
        logger.info("System", "TaskExecutor", `Task ${id} canceled`);
        return true;
      }
      logger.warn("System", "TaskExecutor", `Task ${id} not found for cancellation`);
      return false;
    } catch (error) {
              logger.error("System", "TaskExecutor", `Error canceling task ${id}: ${error}`);
      return false;
    }
  }

  /**
   * Load tasks from database
   * @returns Promise that resolves when tasks are loaded
   */
  private async loadTasksFromDatabase(): Promise<void> {
    try {
      // Use database from instance if provided, otherwise create a new one
      const db = this.database || await createDatabase();
      const tasksTable = db.getTable('tasks');

      // Load all tasks from database
      const taskRecords = await tasksTable.find();

      for (const record of taskRecords) {
        try {
          // Parse JSON fields
          const plugins = record.plugins ? JSON.parse(record.plugins) : [];
          const input = record.input ? JSON.parse(record.input) : null;
          const dependencies = record.dependencies ? JSON.parse(record.dependencies) : [];
          const result = record.result ? JSON.parse(record.result) : null;

          // Create task config from database record
          const taskConfig: TaskConfig = {
            id: record.id,
            name: record.name,
            description: record.description,
            plugins,
            input,
            dependencies,
            agentId: record.agentId,
            sessionId: record.sessionId,
          };

          // Create task instance
          const task = new Task(taskConfig, this.memory, this.providerModel, db);

          // Restore task state
          task.status = record.status as TaskStatus;
          task.retries = record.retries || 0;
          task.createdAt = new Date(record.createdAt);
          task.startedAt = record.startedAt ? new Date(record.startedAt) : undefined;
          task.completedAt = record.completedAt ? new Date(record.completedAt) : undefined;
          task.result = result;
          task.agentId = record.agentId;
          task.sessionId = record.sessionId;
          task.contextId = record.contextId;

          // Add to tasks map
          this.tasks.set(task.id, task);

          logger.debug(`Loaded task ${task.id} from database with status: ${task.status}`);
        } catch (error) {
          logger.error("System", "TaskExecutor", `Error loading task ${record.id} from database: ${error}`);
          // Continue loading other tasks
        }
      }

      logger.info("System", "TaskExecutor", `Loaded ${this.tasks.size} tasks from database`);
    } catch (error) {
      logger.error("System", "TaskExecutor", `Error loading tasks from database: ${error}`);
      // Don't throw error - allow task manager to continue without database tasks
    }
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

      logger.info("System", "TaskExecutor", `Executing task: "${task.config.name}" (${id})`);
      return task.execute(input);
    } catch (error) {
              logger.error("System", "TaskExecutor", `Error executing task ${id}: ${error}`);
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
              logger.error("System", "TaskExecutor", `Error setting memory for task executor: ${error}`);
      throw error;
    }
  }

  /**
   * Set the provider model to use for tasks
   * @param model Provider model to use
   */
  public setProviderModel(model: ProviderModel): void {
    this.providerModel = model;
    logger.debug(`Task manager provider model set to ${model.name}`);
  }

  /**
   * Get the current provider model
   * @returns The current provider model or undefined
   */
  public getProviderModel(): ProviderModel | undefined {
    return this.providerModel;
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
      
              logger.info("System", "TaskExecutor", `Running ${tasksToRun.length} specified tasks`);
    } else {
      tasksToRun = this.getAllTasks();
              logger.info("System", "TaskExecutor", `Running all ${tasksToRun.length} tasks`);
    }

    // Create a dependency graph and task execution order
    const taskDependencyMap = new Map<string, Set<string>>();
    const dependentTasksMap = new Map<string, Set<string>>();
    
    // Build dependency maps
    for (const task of tasksToRun) {
      const taskId = task.id;
      const dependencies = new Set<string>();
      
      // Check both dependencies and dependsOn fields (for backward compatibility)
      if (task.config.dependencies && task.config.dependencies.length > 0) {
        for (const depId of task.config.dependencies) {
          if (this.getTask(depId)) {
            dependencies.add(depId);
          }
        }
      }
      
      // Add dependsOn dependencies (newer approach)
      if (task.config.dependsOn && task.config.dependsOn.length > 0) {
        for (const depId of task.config.dependsOn) {
          if (this.getTask(depId)) {
            dependencies.add(depId);
          }
        }
      }
      
      // Store in the dependency map
      taskDependencyMap.set(taskId, dependencies);
      
      // Update dependent tasks map (reverse mapping)
      for (const depId of dependencies) {
        if (!dependentTasksMap.has(depId)) {
          dependentTasksMap.set(depId, new Set<string>());
        }
        dependentTasksMap.get(depId)!.add(taskId);
      }
    }
    
    // Track completed tasks and their results
    const completedTasks = new Set<string>();
    const taskQueue: TaskInstance[] = [];
    
    // Initial pass: find tasks with no dependencies
    for (const task of tasksToRun) {
      const dependencies = taskDependencyMap.get(task.id) || new Set<string>();
      if (dependencies.size === 0) {
        taskQueue.push(task);
      }
    }
    
    logger.debug(`Initial task queue: ${taskQueue.length} tasks ready to run`);
    
    // Execute tasks in dependency order with proper concurrency
    const concurrency = this.config.concurrency || 5;
    
    while (taskQueue.length > 0) {
      // Take up to concurrency tasks from the queue
      const batchTasks = taskQueue.splice(0, concurrency);
      
      // Execute this batch in parallel
      const batchPromises = batchTasks.map(async (task) => {
        try {
          // Pass in any dependent task outputs as input
          const dependencies = taskDependencyMap.get(task.id) || new Set<string>();
          
          // If there are dependencies, prepare to collect their outputs
          if (dependencies.size > 0) {
            const dependencyOutputs: Record<string, any> = {};
            let hasOutputs = false;
            
            // Collect outputs from all dependencies
            for (const depId of dependencies) {
              if (results.has(depId)) {
                const depResult = results.get(depId)!;
                if (depResult.success && depResult.output) {
                  dependencyOutputs[depId] = depResult.output;
                  hasOutputs = true;
                }
              }
            }
            
            // If we have dependency outputs, merge them with task input
            if (hasOutputs) {
              // Create merged input that preserves original task input
              const mergedInput = {
                ...(task.config.input || {}),
                _dependencyOutputs: dependencyOutputs
              };
              
              logger.debug(`Task ${task.id} received outputs from ${Object.keys(dependencyOutputs).length} dependencies`);
              
              // Execute task with merged input
              const result = await task.execute(mergedInput);
              results.set(task.id, result);
            } else {
              // No usable outputs from dependencies, just run normally
              const result = await task.execute();
              results.set(task.id, result);
            }
          } else {
            // No dependencies, run task with original input
            const result = await task.execute();
            results.set(task.id, result);
          }
          
          // Mark this task as completed
          completedTasks.add(task.id);
          
          // Check if this task completion unblocks any dependent tasks
          if (dependentTasksMap.has(task.id)) {
            const dependentTasks = dependentTasksMap.get(task.id)!;
            
            for (const dependentId of dependentTasks) {
              // Get the dependent task
              const dependentTask = this.getTask(dependentId);
              if (!dependentTask) continue;
              
              // Check if all dependencies of this dependent task are completed
              const allDependenciesCompleted = Array.from(taskDependencyMap.get(dependentId) || new Set<string>())
                .every(depId => completedTasks.has(depId));
              
              // If all dependencies are completed, add this task to the queue
              if (allDependenciesCompleted && !completedTasks.has(dependentId)) {
                taskQueue.push(dependentTask);
                logger.debug(`Task ${dependentId} unblocked and added to queue`);
              }
            }
          }
        } catch (error) {
          logger.error("System", "TaskExecutor", `Error executing task ${task.id}: ${error}`);
          results.set(task.id, {
            success: false,
            error: error instanceof Error ? error : new Error(String(error))
          });
          
          // Mark as completed even though it failed
          completedTasks.add(task.id);
        }
      });
      
      // Wait for this batch to complete before processing next batch
      await Promise.all(batchPromises);
    }
    
    // Check for unresolved tasks (might be due to circular dependencies)
    const unresolvedTasks = tasksToRun.filter(t => !completedTasks.has(t.id));
    if (unresolvedTasks.length > 0) {
              logger.warn("System", "TaskExecutor", `${unresolvedTasks.length} tasks were not executed due to dependency issues or circular dependencies`);
      
      // Add failed results for these tasks
      for (const task of unresolvedTasks) {
        results.set(task.id, {
          success: false,
          error: new Error("Task not executed due to unresolved dependencies")
        });
      }
    }
    
          logger.info("System", "TaskExecutor", `Completed running ${completedTasks.size} tasks`);
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
      logger.info("System", "TaskExecutor", `Canceled all ${this.tasks.size} tasks`);
    } catch (error) {
      logger.error("System", "TaskExecutor", `Error canceling all tasks: ${error}`);
    }
  }
} 