import { MemoryEntry, MemoryInstance } from "./memory";
import { DatabaseInstance } from "./database";

// Media attachment interface
export interface MediaAttachment {
  id?: string;
  type: "image" | "document" | "file";
  data?: string | Buffer; // base64 or file buffer
  filePath?: string; // local file path
  url?: string; // for image URLs
  filename?: string;
  mimeType?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

// Message content interface for multimodal support
export interface ChatMessageContent {
  type: "text" | "image_url" | "image_file" | "document";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
  image_file?: {
    path: string;
    mimeType?: string;
  };
  document?: {
    path: string;
    filename: string;
    mimeType: string;
  };
}

// Chat message interface - extends MemoryEntry for compatibility
export interface ChatMessage extends MemoryEntry {
  chatId: string; // Same as sessionId for compatibility
}

// Chat metadata for chat management
export interface ChatMetadata {
  id: string; // Same as sessionId/chatId
  title?: string;
  userId?: string;
  agentId: string;
  status: 'active' | 'archived' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt?: Date;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

// Chat summary for listing chats
export interface ChatSummary {
  id: string;
  title?: string;
  userId?: string;
  agentId: string;
  status: 'active' | 'archived' | 'deleted';
  lastMessage?: string;
  lastMessageAt?: Date;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Chat configuration
export interface ChatConfig {
  /** Required: Database instance for storing chat data */
  database: DatabaseInstance;
  /** Required: Memory instance for storing messages */
  memory: MemoryInstance;
  /** Optional: Table name for storing chat metadata, defaults to "chats" */
  tableName?: string;
  /** Optional: Maximum number of chats to retrieve at once, defaults to 50 */
  maxChats?: number;
  /** Optional: Auto-generate titles for chats, defaults to true */
  autoGenerateTitles?: boolean;
}

// Chat instance interface
export interface ChatInstance {
  config: ChatConfig;
  
  // Chat management
  createChat(params: {
    chatId?: string;
    userId?: string;
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatMetadata>;
  
  createChatWithMessage(params: {
    chatId?: string;
    userId?: string;
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
    // Chat functionality parameters
    message?: string;
    media?: MediaAttachment[];
    model: any; // ProviderModel
    systemPrompt?: string;
    tools?: any[]; // Plugin[]
    taskManager?: any; // TaskManagerInstance
    embedding?: number[];
    useTaskSystem?: boolean;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
  }): Promise<string>;
  
  getChat(chatId: string): Promise<ChatMetadata | null>;
  updateChat(chatId: string, updates: Partial<ChatMetadata>): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  archiveChat(chatId: string): Promise<void>;
  
  // Chat listing and search
  listChats(params?: {
    userId?: string;
    agentId?: string;
    status?: 'active' | 'archived' | 'deleted';
    limit?: number;
    offset?: number;
  }): Promise<ChatSummary[]>;
  
  searchChats(params: {
    query: string;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ChatSummary[]>;
  
  // Message management (delegates to memory)
  addMessage(params: {
    chatId: string;
    agentId: string;
    userId?: string;
    role: "system" | "user" | "assistant" | "task_context" | "task_event" | "task_tool" | "task_result";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
  
  getMessages(chatId: string, limit?: number): Promise<ChatMessage[]>;
  deleteMessage(messageId: string): Promise<void>;
  clearMessages(chatId: string): Promise<void>;
  
  // Chat statistics
  getChatStats(params?: {
    userId?: string;
    agentId?: string;
  }): Promise<{
    totalChats: number;
    activeChats: number;
    archivedChats: number;
    totalMessages: number;
  }>;

  // Agent integration - advanced chat with AI model
  chat(params: {
    message?: string;
    media?: MediaAttachment[];
    chatId: string;
    agentId: string;
    userId?: string;
    model: any; // ProviderModel
    systemPrompt?: string;
    tools?: any[]; // Plugin[]
    taskManager?: any; // TaskManagerInstance
    chatTitle?: string;
    metadata?: Record<string, unknown>;
    embedding?: number[];
    useTaskSystem?: boolean;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
  }): Promise<string>;
}

// Chat factory function type
export interface ChatFactory {
  (config: ChatConfig): Promise<ChatInstance>;
} 