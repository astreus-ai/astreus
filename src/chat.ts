import { 
  ChatConfig, 
  ChatInstance, 
  ChatMetadata, 
  ChatSummary, 
  ChatMessage 
} from "./types/chat";
import { logger } from "./utils/logger";
import { validateRequiredParam } from "./utils/validation";

/**
 * Creates a chat management system that works with existing memory system
 * Chat IDs are the same as session IDs for backward compatibility
 */
export async function createChat(config: ChatConfig): Promise<ChatInstance> {
  validateRequiredParam(config, "config", "createChat");
  validateRequiredParam(config.database, "config.database", "createChat");
  validateRequiredParam(config.memory, "config.memory", "createChat");

  const tableName = config.tableName || "chats";
  const maxChats = config.maxChats || 50;
  const autoGenerateTitles = config.autoGenerateTitles !== false;

  // Ensure chats table exists
  await ensureChatsTable(config.database, tableName);

  const chatInstance: ChatInstance = {
    config,

    async createChat(params) {
      validateRequiredParam(params.agentId, "params.agentId", "createChat");
      
      const chatId = params.chatId || generateChatId();
      const now = new Date();

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
      await config.database.knex(tableName).insert({
        id: chatId,
        title: params.title,
        userId: params.userId,
        agentId: params.agentId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
        messageCount: 0,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null
      });

      logger.info(`Chat created: ${chatId}`);
      return chatMetadata;
    },

    async getChat(chatId) {
      validateRequiredParam(chatId, "chatId", "getChat");

      const result = await config.database.knex(tableName)
        .where({ id: chatId })
        .first();

      if (!result) return null;

      return {
        id: result.id,
        title: result.title,
        userId: result.userId,
        agentId: result.agentId,
        status: result.status,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        lastMessageAt: result.lastMessageAt ? new Date(result.lastMessageAt) : undefined,
        messageCount: result.messageCount,
        metadata: result.metadata ? JSON.parse(result.metadata) : undefined
      };
    },

    async updateChat(chatId, updates) {
      validateRequiredParam(chatId, "chatId", "updateChat");

      const updateData: any = {
        updatedAt: new Date()
      };

      if (updates.title !== undefined) updateData.title = updates.title;
      if (updates.status !== undefined) updateData.status = updates.status;
      if (updates.metadata !== undefined) {
        updateData.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
      }

      await config.database.knex(tableName)
        .where({ id: chatId })
        .update(updateData);

      logger.info(`Chat updated: ${chatId}`);
    },

    async deleteChat(chatId) {
      validateRequiredParam(chatId, "chatId", "deleteChat");

      // Delete chat metadata
      await config.database.knex(tableName)
        .where({ id: chatId })
        .del();

      // Clear messages from memory
      await config.memory.clear(chatId);

      logger.info(`Chat deleted: ${chatId}`);
    },

    async archiveChat(chatId) {
      await this.updateChat(chatId, { status: 'archived' });
      logger.info(`Chat archived: ${chatId}`);
    },

    async listChats(params = {}) {
      let query = config.database.knex(tableName)
        .select('*')
        .orderBy('updatedAt', 'desc');

      if (params.userId) {
        query = query.where({ userId: params.userId });
      }

      if (params.agentId) {
        query = query.where({ agentId: params.agentId });
      }

      if (params.status) {
        query = query.where({ status: params.status });
      }

      const limit = params.limit || maxChats;
      const offset = params.offset || 0;

      query = query.limit(limit).offset(offset);

      const results = await query;

      return results.map(row => ({
        id: row.id,
        title: row.title,
        userId: row.userId,
        agentId: row.agentId,
        status: row.status,
        lastMessage: row.lastMessage,
        lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt) : undefined,
        messageCount: row.messageCount,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt)
      }));
    },

    async searchChats(params) {
      validateRequiredParam(params.query, "params.query", "searchChats");

      let query = config.database.knex(tableName)
        .select('*')
        .where('title', 'like', `%${params.query}%`)
        .orWhere('lastMessage', 'like', `%${params.query}%`)
        .orderBy('updatedAt', 'desc');

      if (params.userId) {
        query = query.andWhere({ userId: params.userId });
      }

      if (params.agentId) {
        query = query.andWhere({ agentId: params.agentId });
      }

      const limit = params.limit || maxChats;
      query = query.limit(limit);

      const results = await query;

      return results.map(row => ({
        id: row.id,
        title: row.title,
        userId: row.userId,
        agentId: row.agentId,
        status: row.status,
        lastMessage: row.lastMessage,
        lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt) : undefined,
        messageCount: row.messageCount,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt)
      }));
    },

    async addMessage(params) {
      validateRequiredParam(params.chatId, "params.chatId", "addMessage");
      validateRequiredParam(params.agentId, "params.agentId", "addMessage");
      validateRequiredParam(params.role, "params.role", "addMessage");
      validateRequiredParam(params.content, "params.content", "addMessage");

      // Add message to memory (using sessionId = chatId)
      const messageId = await config.memory.add({
        agentId: params.agentId,
        sessionId: params.chatId, // sessionId = chatId for compatibility
        userId: params.userId,
        role: params.role,
        content: params.content,
        metadata: params.metadata
      });

      // Update chat metadata
      const now = new Date();
      await config.database.knex(tableName)
        .where({ id: params.chatId })
        .update({
          lastMessageAt: now,
          updatedAt: now,
          lastMessage: params.content.substring(0, 200), // Store first 200 chars
          messageCount: config.database.knex.raw('messageCount + 1')
        });

      // Auto-generate title if this is the first user message and no title exists
      if (autoGenerateTitles && params.role === 'user') {
        const chat = await this.getChat(params.chatId);
        if (chat && !chat.title && chat.messageCount <= 1) {
          const title = generateTitleFromMessage(params.content);
          await this.updateChat(params.chatId, { title });
        }
      }

      return messageId;
    },

    async getMessages(chatId, limit) {
      validateRequiredParam(chatId, "chatId", "getMessages");

      // Get messages from memory using sessionId = chatId
      const messages = await config.memory.getBySession(chatId, limit);
      
      // Convert to ChatMessage format
      return messages.map(msg => ({
        ...msg,
        chatId: msg.sessionId // Add chatId for compatibility
      }));
    },

    async deleteMessage(messageId) {
      validateRequiredParam(messageId, "messageId", "deleteMessage");
      await config.memory.delete(messageId);
    },

    async clearMessages(chatId) {
      validateRequiredParam(chatId, "chatId", "clearMessages");
      
      // Clear messages from memory
      await config.memory.clear(chatId);
      
      // Reset message count in chat metadata
      await config.database.knex(tableName)
        .where({ id: chatId })
        .update({
          messageCount: 0,
          lastMessage: null,
          lastMessageAt: null,
          updatedAt: new Date()
        });
    },

    async getChatStats(params = {}) {
      let query = config.database.knex(tableName);

      if (params.userId) {
        query = query.where({ userId: params.userId });
      }

      if (params.agentId) {
        query = query.where({ agentId: params.agentId });
      }

      const stats = await query
        .select(
          config.database.knex.raw('COUNT(*) as totalChats'),
          config.database.knex.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as activeChats', ['active']),
          config.database.knex.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as archivedChats', ['archived']),
          config.database.knex.raw('SUM(messageCount) as totalMessages')
        )
        .first();

      return {
        totalChats: parseInt(stats.totalChats) || 0,
        activeChats: parseInt(stats.activeChats) || 0,
        archivedChats: parseInt(stats.archivedChats) || 0,
        totalMessages: parseInt(stats.totalMessages) || 0
      };
    }
  };

  return chatInstance;
}

// Helper function to ensure chats table exists
async function ensureChatsTable(database: any, tableName: string) {
  const hasTable = await database.knex.schema.hasTable(tableName);
  
  if (!hasTable) {
    await database.knex.schema.createTable(tableName, (table: any) => {
      table.string('id').primary();
      table.string('title').nullable();
      table.string('userId').nullable();
      table.string('agentId').notNullable();
      table.enum('status', ['active', 'archived', 'deleted']).defaultTo('active');
      table.timestamp('createdAt').defaultTo(database.knex.fn.now());
      table.timestamp('updatedAt').defaultTo(database.knex.fn.now());
      table.timestamp('lastMessageAt').nullable();
      table.integer('messageCount').defaultTo(0);
      table.text('lastMessage').nullable();
      table.text('metadata').nullable(); // JSON string
      
      // Indexes
      table.index(['userId', 'status', 'updatedAt']);
      table.index(['agentId', 'status', 'updatedAt']);
      table.index(['status', 'updatedAt']);
    });
    
    logger.info(`Created chats table: ${tableName}`);
  }
}

// Helper function to generate unique chat ID
function generateChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function to generate title from first message
function generateTitleFromMessage(content: string): string {
  // Take first 50 characters and clean up
  let title = content.substring(0, 50).trim();
  
  // Remove line breaks and extra spaces
  title = title.replace(/\s+/g, ' ');
  
  // Add ellipsis if truncated
  if (content.length > 50) {
    title += '...';
  }
  
  return title || 'New Chat';
} 