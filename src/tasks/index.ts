import { TaskManager } from "./manager";
import { Task } from "./task";
import { TaskManagerInstance, TaskConfig, TaskInstance, TaskManagerConfig } from "../types/task";
import { MemoryInstance } from "../types";
import { logger } from "../utils";

/**
 * Create a new TaskManager instance
 * @param config Configuration for the task manager
 * @returns A new TaskManager instance
 */
export const createTaskManager = (
  config?: TaskManagerConfig
): TaskManagerInstance => {
  try {
    logger.debug("Creating task manager instance");
    return new TaskManager(config);
  } catch (error) {
    logger.error("System", "TaskManager", `Error creating task manager: ${error}`);
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
    logger.error("System", "TaskManager", `Error creating task "${config.name}": ${error}`);
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
    logger.error("System", "TaskManager", `Error creating task "${config.name}": ${error}`);
    throw error;
  }
};


export { TaskManager, Task }; 