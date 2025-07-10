import { TaskExecutor } from "./executor";
import { Task } from "./task";
import { TaskManagerInstance, TaskConfig, TaskInstance, TaskManagerConfig } from "../types/task";
import { MemoryInstance } from "../types";
import { logger } from "../utils";

/**
 * Create a new TaskExecutor instance
 * @param config Configuration for the task executor
 * @returns A new TaskExecutor instance
 */
export const createTaskManager = (
  config?: TaskManagerConfig
): TaskManagerInstance => {
  try {
    logger.debug("Creating task executor instance");
    return new TaskExecutor(config);
  } catch (error) {
    logger.error("System", "TaskExecutor", `Error creating task executor: ${error}`);
    throw error;
  }
};

/**
 * Create a new task asynchronously
 * @param config Configuration for the task
 * @param memory Optional memory instance for task context storage
 * @returns Promise that resolves to the new task instance
 */
export const createTask = async (
  config: TaskConfig,
  memory?: MemoryInstance
): Promise<TaskInstance> => {
  try {
    logger.debug(`Creating task "${config.name}" asynchronously`);
    return await Task.createTask(config, memory);
  } catch (error) {
    logger.error("System", "TaskExecutor", `Error creating task "${config.name}": ${error}`);
    throw error;
  }
};

/**
 * Create a new task synchronously
 * @param config Configuration for the task
 * @param memory Optional memory instance for task context storage
 * @returns The new task instance
 */
export const createTaskSync = (
  config: TaskConfig,
  memory?: MemoryInstance
): TaskInstance => {
  try {
    logger.debug(`Creating task "${config.name}" synchronously`);
    return Task.createTaskSync(config, memory);
  } catch (error) {
    logger.error("System", "TaskExecutor", `Error creating task "${config.name}": ${error}`);
    throw error;
  }
};


export { TaskExecutor, Task };
export { TaskExecutor as TaskManager }; // Backward compatibility

// Re-export types
export * from "../types/task";

// Re-export configuration
export * from "./config"; 