import { Plugin, ProviderModel, ProviderInstance } from ".";
import { TaskConfig, TaskInstance, TaskResult } from "./task";
import { MemoryInstance } from "./memory";
import { DatabaseInstance } from "./database";
import { RAGInstance } from "./rag";
import { ChatInstance } from "./chat";

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
  /** Optional: RAG instance for document retrieval and search */
  rag?: RAGInstance;
  /** Optional: Chat instance for chat management and metadata */
  chat?: ChatInstance;
}

// Agent instance
export interface AgentInstance {
  id: string;
  config: AgentConfig;
  getAvailableTools(): string[];
  addTool(tool: Plugin): void;

  // Chat system methods
  getChatManager(): ChatInstance | undefined;
  setChatManager(chatManager: ChatInstance): void;
}

// Agent factory function type
export type AgentFactory = (config: AgentConfig) => Promise<AgentInstance>;
