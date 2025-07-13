import { Plugin } from "./plugin";
import { MemoryInstance } from "./memory";
import { ProviderModel } from "./provider";
import { DatabaseInstance } from "./database";
import { PersonalityInstance } from "../personality/types";

// Task status types
export type TaskStatus = "pending" | "running" | "completed" | "failed";

// Task configuration
export interface TaskConfig {
  id?: string; // Unique identifier for the task
  name: string; // Name of the task
  description: string; // Description of what the task does
  plugins?: string[]; // Names of plugins required for this task
  input?: any; // Input data for the task
  dependencies?: string[]; // IDs of tasks that must complete before this one
  dependsOn?: string[]; // IDs of tasks that this task depends on (modern alternative to dependencies)
  maxRetries?: number; // Maximum number of retries for the task
  agentId?: string; // ID of the agent that created this task
  sessionId?: string; // ID of the session this task belongs to
  model?: ProviderModel; // Model to use for executing the task with tools
  personality?: PersonalityInstance; // Personality to use for task execution
}

// Task result
export interface TaskResult {
  success: boolean; // Whether the task completed successfully
  output?: any; // Output data from the task
  error?: Error; // Error if the task failed
  context?: Record<string, any>; // Context from task execution chain
}

// Task instance
export interface TaskInstance {
  id: string; // Unique identifier
  config: TaskConfig; // Task configuration
  status: TaskStatus; // Current status
  result?: TaskResult; // Task result (when completed)
  retries: number; // Current retry count
  plugins: Plugin[]; // Loaded plugins for this task
  createdAt: Date; // When the task was created
  startedAt?: Date; // When the task started running
  completedAt?: Date; // When the task completed
  agentId?: string; // ID of the agent that owns this task
  sessionId?: string; // ID of the session this task belongs to
  contextId?: string;
  memory?: MemoryInstance;
  model?: ProviderModel; // Provider model to use
  personality?: PersonalityInstance; // Personality instance for task execution

  // Methods
  execute(input?: any): Promise<TaskResult>;
  cancel(): void;
  loadPlugins(model?: ProviderModel): Promise<void>;
  setMemory(memory: MemoryInstance): void;
}

// Task manager interface
export interface TaskManagerConfig {
  concurrency?: number; // Maximum number of concurrent tasks
  agentId?: string; // Default agent ID for all tasks created by this manager
  sessionId?: string; // Default session ID for all tasks created by this manager
  memory?: MemoryInstance; // Memory instance for storing task contexts
  database?: DatabaseInstance; // Database instance for storage
  providerModel?: ProviderModel; // Provider model to use for tasks
  personality?: PersonalityInstance; // Default personality for all tasks created by this manager
}

export interface TaskManagerInstance {
  addExistingTask(task: TaskInstance | TaskConfig, model?: ProviderModel): TaskInstance;
  getTask(id: string): TaskInstance | undefined;
  getAllTasks(): TaskInstance[];
  createTask(config: TaskConfig, model?: ProviderModel): Promise<TaskInstance>;
  cancelTask(id: string): boolean;
  waitForTasksLoaded(): Promise<void>;
  executeTask(id: string, input?: any): Promise<TaskResult>;
  // Provider model methods
  setProviderModel(model: ProviderModel): void;
  getProviderModel(): ProviderModel | undefined;
  // Deprecated methods kept for backward compatibility
  getTasks(): TaskInstance[]; // Use getAllTasks() instead
  getTasksByAgent(agentId: string): TaskInstance[]; // Get tasks for a specific agent
  getTasksBySession(sessionId: string): TaskInstance[]; // Get tasks for a specific session
  setAgentId(agentId: string): void; // Set the default agent ID
  setSessionId(sessionId: string): void; // Set the default session ID
  run(taskIds?: string[]): Promise<Map<string, TaskResult>>;
  cancel(taskId: string): boolean; // Use cancelTask instead
  cancelAll(): void;
}

// Factory function types
export type TaskFactory = (config: TaskConfig) => TaskInstance;
export type TaskManagerFactory = (
  config?: TaskManagerConfig
) => TaskManagerInstance;
