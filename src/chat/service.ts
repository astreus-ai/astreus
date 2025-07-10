import { 
  ChatConfig, 
  ChatInstance, 
  ChatMetadata, 
  ChatSummary, 
  ChatMessage 
} from "../types/chat";
import { validateRequiredParam } from "../utils/validation";
import { logger } from "../utils/logger";

/**
 * Chat service that works with existing memory system
 * Chat IDs are the same as session IDs for backward compatibility
 * Can be used standalone or integrated with Agent instances
 */
export class ChatService implements ChatInstance {
  public config: ChatConfig;
  private tableName: string;
  private maxChats: number;
  private autoGenerateTitles: boolean;
  private enableAdaptiveContext: boolean;
  private maxContextTokens: number;
  private autoCompressContext: boolean;

  constructor(config: ChatConfig) {
    validateRequiredParam(config, "config", "ChatManager constructor");
    validateRequiredParam(config.database, "config.database", "ChatManager constructor");
    validateRequiredParam(config.memory, "config.memory", "ChatManager constructor");

    logger.info("System", "ChatManager", `Initializing chat manager with table: ${config.tableName || 'chats'}`);

    this.config = config;
    this.tableName = config.tableName || "chats";
    this.maxChats = config.maxChats || 50;
    this.autoGenerateTitles = config.autoGenerateTitles !== false;
    this.enableAdaptiveContext = config.enableAdaptiveContext || false;
    this.maxContextTokens = config.maxContextTokens || 4000;
    this.autoCompressContext = config.autoCompressContext || false;
  }

  async createChat(params: {
    chatId?: string;
    userId?: string;
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatMetadata> {
    validateRequiredParam(params.agentId, "params.agentId", "createChat");
    
    const chatId = params.chatId || generateChatId();
    const now = new Date();

    logger.info("System", "ChatManager", `Creating chat: ${chatId} for agent: ${params.agentId}`);

    // Check if chat already exists
    const existingChat = await this.getChat(chatId);
    if (existingChat) {
      logger.debug("System", "ChatManager", `Chat already exists: ${chatId}`);
      return existingChat;
    }

    const chatMetadata: ChatMetadata = {
      id: chatId,
      title: params.title,
      userId: params.userId,
      agentId: params.agentId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      metadata: params.metadata
    };

    // Insert chat metadata
    await this.config.database.knex(this.tableName).insert({
      id: chatId,
      title: params.title,
      userId: params.userId,
      agentId: params.agentId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      messageCount: 0,
      lastMessage: null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null
    });

    logger.success("System", "ChatManager", `Chat created: ${chatId}`);
    return chatMetadata;
  }

  async getChat(chatId: string): Promise<ChatMetadata | null> {
    validateRequiredParam(chatId, "chatId", "getChat");

    const result = await this.config.database.knex(this.tableName)
      .where({ id: chatId })
      .first();

    if (!result) {
      return null;
    }

    return this.formatChatMetadata(result);
  }

  async chat(params: {
    message?: string;
    chatId: string;
    agentId: string;
    userId?: string;
    model: any;
    systemPrompt?: string;
    tools?: any[];
    taskManager?: any;
    chatTitle?: string;
    metadata?: Record<string, unknown>;
    embedding?: number[];
    useTaskSystem?: boolean;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
    useAdaptiveContext?: boolean;
    contextTokens?: number;
    compressionStrategy?: string;
  }): Promise<string> {
    validateRequiredParam(params.chatId, "params.chatId", "chat");
    validateRequiredParam(params.agentId, "params.agentId", "chat");

    logger.info("System", "ChatManager", `Processing chat message for chat: ${params.chatId}`);

    // Get current chat metadata
    let chatMetadata = await this.getChat(params.chatId);
    if (!chatMetadata) {
      // Create chat if it doesn't exist
      chatMetadata = await this.createChat({
        chatId: params.chatId,
        userId: params.userId,
        agentId: params.agentId,
        title: params.message && params.message.length > 50 ? params.message.substring(0, 50) + '...' : params.message || 'New Chat'
      });
    }

    // Add user message to memory if provided
    if (params.message) {
      await this.config.memory.add({
        agentId: params.agentId,
        sessionId: params.chatId,
        userId: params.userId,
        role: 'user',
        content: params.message,
        metadata: {}
      });
    }

    // For now, return a simple implementation that matches the interface
    const response = `Response to: ${params.message || 'No message provided'}`;
    
    // Add assistant response to memory
    await this.config.memory.add({
      agentId: params.agentId,
      sessionId: params.chatId,
      userId: params.userId,
      role: 'assistant',
      content: response,
      metadata: {}
    });

    // Update chat metadata
    if (params.message) {
      await this.updateChatAfterMessage(params.chatId, params.message);
    }

    return response;
  }

  async createChatWithMessage(params: {
    chatId?: string;
    userId?: string;
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
    message?: string;
    model: any;
    systemPrompt?: string;
    tools?: any[];
    taskManager?: any;
    embedding?: number[];
    useTaskSystem?: boolean;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
    useAdaptiveContext?: boolean;
    contextTokens?: number;
    compressionStrategy?: string;
  }): Promise<string> {
    validateRequiredParam(params.agentId, "params.agentId", "createChatWithMessage");

    // Create chat
    const chat = await this.createChat({
      chatId: params.chatId,
      userId: params.userId,
      agentId: params.agentId,
      title: params.title || (params.message && params.message.length > 50 ? params.message.substring(0, 50) + '...' : params.message || 'New Chat'),
      metadata: params.metadata
    });

    // Process message
    const response = await this.chat({
      chatId: chat.id,
      message: params.message,
      userId: params.userId,
      agentId: params.agentId,
      model: params.model,
      systemPrompt: params.systemPrompt,
      tools: params.tools,
      taskManager: params.taskManager,
      embedding: params.embedding,
      useTaskSystem: params.useTaskSystem,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      stream: params.stream,
      onChunk: params.onChunk,
      useAdaptiveContext: params.useAdaptiveContext,
      contextTokens: params.contextTokens,
      compressionStrategy: params.compressionStrategy
    });

    return response;
  }

  // Required ChatInstance methods
  async addMessage(params: {
    chatId: string;
    agentId: string;
    userId?: string;
    role: "system" | "user" | "assistant" | "task_context" | "task_event" | "task_tool" | "task_result";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    validateRequiredParam(params.chatId, "params.chatId", "addMessage");
    validateRequiredParam(params.agentId, "params.agentId", "addMessage");
    validateRequiredParam(params.content, "params.content", "addMessage");

    return await this.config.memory.add({
      agentId: params.agentId,
      sessionId: params.chatId,
      userId: params.userId,
      role: params.role,
      content: params.content,
      metadata: params.metadata || {}
    });
  }

  async getMessages(chatId: string, limit?: number): Promise<ChatMessage[]> {
    validateRequiredParam(chatId, "chatId", "getMessages");
    
    const memories = await this.config.memory.getBySession(chatId, limit);
    
    return memories.map(memory => ({
      ...memory,
      chatId: memory.sessionId
    }));
  }

  async deleteMessage(messageId: string): Promise<void> {
    validateRequiredParam(messageId, "messageId", "deleteMessage");
    
    await this.config.memory.delete(messageId);
  }

  async clearMessages(chatId: string): Promise<void> {
    validateRequiredParam(chatId, "chatId", "clearMessages");
    
    await this.config.memory.clear(chatId);
  }

  async getChatStats(params?: {
    userId?: string;
    agentId?: string;
  }): Promise<{
    totalChats: number;
    activeChats: number;
    archivedChats: number;
    totalMessages: number;
  }> {
    let query = this.config.database.knex(this.tableName);

    if (params?.userId) {
      query = query.where({ userId: params.userId });
    }

    if (params?.agentId) {
      query = query.where({ agentId: params.agentId });
    }

    const totalResult = await query.clone().count('* as count').first();
    const activeResult = await query.clone().where({ status: 'active' }).count('* as count').first();
    const archivedResult = await query.clone().where({ status: 'archived' }).count('* as count').first();
    const messagesResult = await query.clone().sum('messageCount as total').first();

    return {
      totalChats: parseInt(totalResult?.count as string) || 0,
      activeChats: parseInt(activeResult?.count as string) || 0,
      archivedChats: parseInt(archivedResult?.count as string) || 0,
      totalMessages: parseInt(messagesResult?.total as string) || 0
    };
  }

  async updateChat(chatId: string, updates: Partial<ChatMetadata>): Promise<void> {
    validateRequiredParam(chatId, "chatId", "updateChat");

    const updateData: any = {
      updatedAt: new Date()
    };

    if (updates.title !== undefined) updateData.title = updates.title;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
    }

    await this.config.database.knex(this.tableName)
      .where({ id: chatId })
      .update(updateData);

    logger.info("System", "ChatManager", `Chat updated: ${chatId}`);
  }

  async deleteChat(chatId: string): Promise<void> {
    validateRequiredParam(chatId, "chatId", "deleteChat");

    // Delete chat metadata
    await this.config.database.knex(this.tableName)
      .where({ id: chatId })
      .del();

    // Clear messages from memory
    await this.config.memory.clear(chatId);

    logger.info("System", "ChatManager", `Chat deleted: ${chatId}`);
  }

  async archiveChat(chatId: string): Promise<void> {
    await this.updateChat(chatId, { status: 'archived' });
    logger.info("System", "ChatManager", `Chat archived: ${chatId}`);
  }

  async listChats(params: {
    userId?: string;
    agentId?: string;
    status?: 'active' | 'archived' | 'deleted';
    limit?: number;
    offset?: number;
  } = {}): Promise<ChatSummary[]> {
    let query = this.config.database.knex(this.tableName);

    if (params.userId) {
      query = query.where({ userId: params.userId });
    }

    if (params.agentId) {
      query = query.where({ agentId: params.agentId });
    }

    if (params.status) {
      query = query.where({ status: params.status });
    }

    const results = await query
      .orderBy('updatedAt', 'desc')
      .limit(params.limit || this.maxChats)
      .offset(params.offset || 0);

    return results.map(result => ({
      id: result.id,
      title: result.title,
      userId: result.userId,
      agentId: result.agentId,
      status: result.status,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      messageCount: result.messageCount || 0,
      lastMessageAt: result.lastMessageAt,
      lastMessage: result.lastMessage
    }));
  }

  async searchChats(params: {
    query: string;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ChatSummary[]> {
    validateRequiredParam(params.query, "params.query", "searchChats");
    
    let query = this.config.database.knex(this.tableName)
      .where('title', 'like', `%${params.query}%`)
      .orWhere('lastMessage', 'like', `%${params.query}%`);

    if (params.userId) {
      query = query.andWhere({ userId: params.userId });
    }

    if (params.agentId) {
      query = query.andWhere({ agentId: params.agentId });
    }

    const results = await query
      .orderBy('updatedAt', 'desc')
      .limit(params.limit || 20);

    return results.map(result => ({
      id: result.id,
      title: result.title,
      userId: result.userId,
      agentId: result.agentId,
      status: result.status,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      messageCount: result.messageCount || 0,
      lastMessageAt: result.lastMessageAt,
      lastMessage: result.lastMessage
    }));
  }

  // Helper methods
  private formatChatMetadata(result: any): ChatMetadata {
    return {
      id: result.id,
      title: result.title,
      userId: result.userId,
      agentId: result.agentId,
      status: result.status,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      messageCount: result.messageCount || 0,
      metadata: result.metadata ? (typeof result.metadata === 'string' ? JSON.parse(result.metadata) : result.metadata) : undefined
    };
  }

  private async updateChatAfterMessage(chatId: string, message: string): Promise<void> {
    const now = new Date();
    
    // Get current message count
    const chat = await this.getChat(chatId);
    const messageCount = (chat?.messageCount || 0) + 1;
    
    // Update chat metadata
    await this.config.database.knex(this.tableName)
      .where({ id: chatId })
      .update({
        updatedAt: now,
        lastMessageAt: now,
        lastMessage: message.length > 100 ? message.substring(0, 100) + '...' : message,
        messageCount: messageCount,
        title: chat?.title || generateTitleFromMessage(message)
      });
  }

  // Optional adaptive context methods
  async getAdaptiveContext?(chatId: string, maxTokens?: number): Promise<any> {
    validateRequiredParam(chatId, "chatId", "getAdaptiveContext");
    
    if (this.config.memory.getAdaptiveContext) {
      return await this.config.memory.getAdaptiveContext(chatId, maxTokens || this.maxContextTokens);
    }
    
    return null;
  }

  async updateContextLayers?(chatId: string, newMessage: ChatMessage): Promise<void> {
    validateRequiredParam(chatId, "chatId", "updateContextLayers");
    
    if (this.config.memory.updateContextLayers) {
      await this.config.memory.updateContextLayers(chatId, newMessage);
    }
  }

  async compressContext?(chatId: string, strategy?: string): Promise<any> {
    validateRequiredParam(chatId, "chatId", "compressContext");
    
    if (this.config.memory.compressContext) {
      // Convert string to enum if needed
      const compressionStrategy = strategy as any || 'SUMMARIZE';
      return await this.config.memory.compressContext(chatId, compressionStrategy);
    }
    
    return null;
  }

  async getFormattedContext?(chatId: string, maxTokens?: number): Promise<string> {
    validateRequiredParam(chatId, "chatId", "getFormattedContext");
    
    if (this.config.memory.getFormattedContext) {
      return await this.config.memory.getFormattedContext(chatId, maxTokens || this.maxContextTokens);
    }
    
    return "";
  }
}

// Helper functions
function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateTitleFromMessage(message: string): string {
  return message.length > 50 ? message.substring(0, 50) + '...' : message;
}