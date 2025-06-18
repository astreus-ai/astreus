import { Plugin, ProviderModel, ProviderInstance } from ".";
import { TaskConfig, TaskInstance, TaskResult, TaskManagerInstance } from "./task";
import { MemoryInstance } from "./memory";
import { DatabaseInstance } from "./database";
import { RAGInstance } from "./rag";
import { ChatInstance, ChatMetadata, ChatSummary } from "./chat";

// Plugin instance interface for objects with getTools method
export interface PluginWithTools {
  init?: () => Promise<void>;
  getTools: () => Plugin[];
}

// Agent configuration interface
export interface AgentConfig {
  /** Optional: Agent ID (auto-generated if not provided) */
  id?: string;
  /** Optional: Name of the agent (defaults to 'astreus-agent') */
  name?: string;
  /** Optional: Description of the agent's purpose */
  description?: string;
  /** Optional: Language model to use - if not provided, uses provider's default */
  model?: ProviderModel;
  /** Optional: Provider instance that contains models - either model or provider must be specified */
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
  /** Optional: RAG instance for document retrieval and search (automatically creates RAG tools) */
  rag?: RAGInstance;
  /** Optional: Chat instance for chat management and metadata */
  chat?: ChatInstance;
  /** Optional: Task manager instance for task-based operations */
  taskManager?: TaskManagerInstance;
}

// Agent instance interface
export interface AgentInstance {
  /** Unique identifier for the agent */
  id: string;
  /** Agent configuration */
  config: AgentConfig;
  
  // Tool management methods
  getAvailableTools(): string[];
  addTool(tool: Plugin): void;

  // Chat system methods
  getChatManager(): ChatInstance | undefined;
  setChatManager(chatManager: ChatInstance): void;

  // Chat management methods (new)
  createChat(params: {
    chatId?: string;
    userId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatMetadata>;

  getChat(chatId: string): Promise<ChatMetadata | null>;
  updateChat(chatId: string, updates: Partial<ChatMetadata>): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  archiveChat(chatId: string): Promise<void>;

  listChats(params?: {
    userId?: string;
    status?: 'active' | 'archived' | 'deleted';
    limit?: number;
    offset?: number;
  }): Promise<ChatSummary[]>;

  searchChats(params: {
    query: string;
    userId?: string;
    limit?: number;
  }): Promise<ChatSummary[]>;

  getChatStats(params?: {
    userId?: string;
  }): Promise<{
    totalChats: number;
    activeChats: number;
    archivedChats: number;
    totalMessages: number;
  }>;

  // Enhanced chat methods with chat ID support
  chatWithId(params: {
    message: string;
    chatId: string;
    userId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  // Original session-based methods (for backward compatibility)
  chat(params: {
    message: string;
    sessionId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
  }): Promise<string>;

  // Memory access methods
  getHistory(sessionId: string, limit?: number): Promise<any[]>;
  clearHistory(sessionId: string): Promise<void>;
  addToMemory(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  // Session management methods
  listSessions(limit?: number): Promise<{
    sessionId: string;
    lastMessage?: string;
    messageCount: number;
    lastActivity: Date;
    metadata?: Record<string, unknown>;
  }[]>;

  // Instance access methods
  getModel(): ProviderModel;
  getProvider(): ProviderInstance | undefined;
  getMemory(): MemoryInstance;
  getDatabase(): DatabaseInstance | undefined;
  getTaskManager(): TaskManagerInstance | undefined;
  getRAG(): RAGInstance | undefined;
}

// Agent factory function type
export type AgentFactory = (config: AgentConfig) => Promise<AgentInstance>;
