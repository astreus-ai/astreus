import { Plugin, ProviderModel, ProviderInstance } from ".";
import { TaskConfig, TaskInstance, TaskResult } from "./task";
import { MemoryInstance } from "./memory";
import { DatabaseInstance } from "./database";

// Plugin instance interface for objects with getTools method
export interface PluginWithTools {
  init?: () => Promise<void>;
  getTools: () => Plugin[];
}

// Agent configuration
export interface AgentConfig {
  /** Optional: Agent ID (auto-generated if not provided) */
  id?: string;
  /** Required: Name of the agent */
  name: string;
  /** Optional: Description of the agent's purpose */
  description?: string;
  /** Required: Language model provider OR provider instance */
  model?: ProviderModel;
  /** Alternative to model: Provider instance that contains models */
  provider?: ProviderInstance;
  /** Required: Memory instance for storing conversation history */
  memory: MemoryInstance;
  /** Optional: Database instance for storage (will create one if not provided) */
  database?: DatabaseInstance;
  /** Optional: System prompt that defines the agent's behavior */
  systemPrompt?: string;
  /** Optional: Array of tools the agent can use */
  tools?: Plugin[];
  /** Optional: Array of plugins the agent can use (plugins can provide multiple tools) */
  plugins?: (Plugin | PluginWithTools)[];
}

// Agent instance
export interface AgentInstance {
  id: string;
  config: AgentConfig;
  chat(
    message: string,
    sessionId?: string,
    userId?: string,
    options?: {
      metadata?: Record<string, any>;
      embedding?: number[];
      useTaskSystem?: boolean;
    }
  ): Promise<string>;
  getHistory(sessionId?: string): Promise<any[]>;
  clearHistory(sessionId?: string): Promise<void>;
  addTool(tool: Plugin): void;

  // Task system methods
  createTask(config: TaskConfig, sessionId?: string): TaskInstance;
  getTasks(): TaskInstance[];
  getAgentTasks(): TaskInstance[];
  getSessionTasks(sessionId: string): TaskInstance[];
  runTasks(taskIds?: string[]): Promise<Map<string, TaskResult>>;
}

// Agent factory function type
export type AgentFactory = (config: AgentConfig) => Promise<AgentInstance>;
