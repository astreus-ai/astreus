import { 
  ChatConfig, 
  ChatInstance, 
  ChatMetadata, 
  ChatSummary, 
  ChatMessage 
} from "./types/chat";
import { MemoryEntry, ProviderMessage, StructuredCompletionResponse, TaskConfig, TaskResult, ProviderModel } from "./types";
import { logger } from "./utils/logger";
import { validateRequiredParam } from "./utils/validation";
import { convertToolParametersToSchema } from "./utils";
import { Embedding } from "./providers";
import { 
  DEFAULT_TEMPERATURE, 
  DEFAULT_MAX_TOKENS
} from "./constants";

/**
 * Chat management system that works with existing memory system
 * Chat IDs are the same as session IDs for backward compatibility
 * Can be used standalone or integrated with Agent instances
 */
export class ChatManager implements ChatInstance {
  public config: ChatConfig;
  private tableName: string;
  private maxChats: number;
  private autoGenerateTitles: boolean;

  constructor(config: ChatConfig) {
    validateRequiredParam(config, "config", "ChatManager constructor");
    validateRequiredParam(config.database, "config.database", "ChatManager constructor");
    validateRequiredParam(config.memory, "config.memory", "ChatManager constructor");

    logger.info("System", "ChatManager", `Initializing chat manager with table: ${config.tableName || 'chats'}`);

    this.config = config;
    // Use user-provided table name or default
    this.tableName = config.tableName || "chats";
    this.maxChats = config.maxChats || 50;
    this.autoGenerateTitles = config.autoGenerateTitles !== false;
    
    logger.debug("System", "ChatManager", `Configuration: table=${this.tableName}, maxChats=${this.maxChats}, autoTitles=${this.autoGenerateTitles}`);
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

  async createChatWithMessage(params: {
    chatId?: string;
    userId?: string;
    agentId: string;
    title?: string;
    metadata?: Record<string, unknown>;
    // Chat functionality parameters
    message: string;
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
  }): Promise<string> {
    validateRequiredParam(params.agentId, "params.agentId", "createChatWithMessage");
    validateRequiredParam(params.message, "params.message", "createChatWithMessage");
    validateRequiredParam(params.model, "params.model", "createChatWithMessage");
    
    const chatId = params.chatId || generateChatId();

    // Check if chat exists, if not create it
    const existingChat = await this.getChat(chatId);
    if (!existingChat) {
      await this.createChat({
        chatId,
        agentId: params.agentId,
        userId: params.userId,
        title: params.title,
        metadata: params.metadata
      });
      logger.info("System", "ChatManager", `Created new chat: ${chatId} for agent: ${params.agentId}`);
    }

    // Process the message
    return await this.processMessage({
      chatId,
      agentId: params.agentId,
      userId: params.userId,
      message: params.message,
      model: params.model,
      systemPrompt: params.systemPrompt,
      tools: params.tools || [],
      taskManager: params.taskManager,
      metadata: params.metadata || {},
      embedding: params.embedding,
      useTaskSystem: params.useTaskSystem !== false,
      temperature: params.temperature || DEFAULT_TEMPERATURE,
      maxTokens: params.maxTokens || DEFAULT_MAX_TOKENS,
      stream: params.stream,
      onChunk: params.onChunk
    });
  }

  private async processMessage(params: {
    chatId: string;
    agentId: string;
    userId?: string;
    message: string;
    model: any;
    systemPrompt?: string;
    tools: any[];
    taskManager?: any;
    metadata: Record<string, unknown>;
    embedding?: number[];
    useTaskSystem: boolean;
    temperature: number;
    maxTokens: number;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
  }): Promise<string> {
    const {
      chatId,
      agentId,
      userId,
      message,
      model,
      systemPrompt,
      tools,
      taskManager,
      metadata,
      embedding,
      useTaskSystem,
      temperature,
      maxTokens,
      stream = false,
      onChunk
    } = params;

    // Get conversation history from chat system
    const history = await this.getMessages(chatId);

    logger.debug("System", "ChatManager", `Processing message for chat: ${chatId}, history: ${history.length} messages`);

    // Add user message to chat
    await this.addMessage({
      chatId,
      agentId,
      userId,
      role: "user",
      content: message,
      metadata: {
        ...metadata,
        timestamp: new Date().toISOString(),
        useTaskSystem,
        conversationLength: history.length
      }
    });

    // Prepare messages for model
    const messages: ProviderMessage[] = [];

    // Add system prompt
    if (systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt,
      });
    }

    // Add conversation history
    history.forEach((entry: MemoryEntry) => {
      messages.push({
        role: entry.role as "system" | "user" | "assistant",
        content: entry.content,
      });
    });

    // Add the new user message
    messages.push({
      role: "user",
      content: message,
    });

    // Get available tools - Convert parameters to proper format for provider
    const availableTools = tools.map((tool) => {
      const result = convertToolParametersToSchema(tool);
      return result;
    });
    
    logger.debug("System", "ChatManager", `Available tools: ${availableTools.length}, Task system: ${useTaskSystem}`);
    
    // If tools are available, add them to the system message
    if (availableTools.length > 0 && systemPrompt) {
      const systemMessage = messages.find((msg) => msg.role === "system");
      if (systemMessage) {
        systemMessage.content += `\n\nYou have access to the following tools:\n${JSON.stringify(
          availableTools,
          null,
          2
        )}`;
      }
    }

    let response: string | StructuredCompletionResponse;

    // Determine if we should use task-based approach
    if (useTaskSystem && tools.length > 0 && taskManager) {
      // First, analyze the message to determine if it requires tasks
      const analysisResponse = await model.complete([
        ...messages,
        {
          role: "system",
          content: `You are a task planning assistant. Analyze the user's request and determine if it should be broken down into tasks. 
If tasks are needed, format your response as a JSON array with this structure:
[
  {
    "name": "Task name",
    "description": "Detailed description of the task",
    "input": {Any input data for the task}
  }
]
The system will automatically determine which tools and plugins to use based on the task name and description.
If no tasks are needed, respond with "NO_TASKS_NEEDED".`,
        },
      ]);

      // Check if the analysis identified tasks
      const responseText = typeof analysisResponse === 'string' ? analysisResponse : analysisResponse.content;
      
      if (responseText.includes("[") && responseText.includes("]")) {
        try {
          // Extract JSON array from the response
          const jsonString = responseText.substring(
            responseText.indexOf("["),
            responseText.lastIndexOf("]") + 1
          );

          // Parse the tasks
          const taskConfigs: TaskConfig[] = JSON.parse(jsonString);

          // Set session ID in task manager
          if (taskManager.setSessionId) {
            taskManager.setSessionId(chatId);
          }

          // Create and execute tasks
          for (const taskConfig of taskConfigs) {
            taskManager.addExistingTask(taskConfig, model);
          }

          const taskResults = await taskManager.run();

          // Generate response based on task results
          const resultSummary: any[] = [];
          for (const [taskId, result] of taskResults.entries()) {
            resultSummary.push({
              taskId,
              success: result.success,
              output: result.output,
              error: result.error ? result.error.message : undefined,
            });
          }

          const taskResponse = await model.complete([
            ...messages,
            {
              role: "system",
              content: `You are assisting with a task-based workflow. Multiple tasks were executed based on the user's request. 
Here are the results of those tasks:
${JSON.stringify(resultSummary, null, 2)}

Analyze these results and generate a helpful, coherent response to the user that summarizes what was done and the outcome. 
Do not mention that tasks were executed behind the scenes - just provide the information the user needs in a natural way.`,
            },
          ]);

          response = typeof taskResponse === 'string' ? taskResponse : taskResponse.content;
        } catch (error) {
          logger.error("System", "TaskProcessing", `Error processing tasks: ${error}`);
          // Fallback to standard completion if task processing fails
          response = await model.complete(messages);
        }
      } else {
        // No tasks needed, just complete the response normally
        response = await model.complete(messages);
      }
    } else {
      // Regular chat completion
                                                      logger.debug('Unknown', 'Chat', 'Using regular chat completion');
                logger.debug('Unknown', 'Chat', `Calling model.complete with tools: ${String(availableTools.length > 0 ? availableTools : undefined)}`);
                logger.debug('Unknown', 'Chat', `toolCalling enabled: ${String(availableTools.length > 0)}`);
      
      response = await model.complete(messages, {
        tools: availableTools.length > 0 ? availableTools : undefined,
        toolCalling: availableTools.length > 0,
        temperature,
        maxTokens,
        stream,
        onChunk
      });
      
                  logger.debug('Unknown', 'Chat', `Model response type: ${typeof response}`);
            logger.debug('Unknown', 'Chat', `Response has tool_calls: ${typeof response === 'object' && response.tool_calls ? response.tool_calls.length : 'NO'}`);
    }

    // Handle tool execution if the response contains tool calls
    if (typeof response === 'object' && response.tool_calls && Array.isArray(response.tool_calls)) {
      logger.info("System", "ChatManager", `Chat ${chatId} received ${response.tool_calls.length} tool calls to execute`);
      
      const toolResults = [];
      for (const toolCall of response.tool_calls) {
        try {
          if (toolCall.type === 'function' && toolCall.name) {
            logger.debug("System", "ChatManager", `Executing tool: ${toolCall.name}`);
            
            // Find the tool to execute
            const tool = tools.find(t => t.name === toolCall.name);
            
            if (tool && tool.execute) {
              // Inject userLanguage from metadata if available and tool supports it
              let toolArguments = toolCall.arguments || {};
              
              if (metadata?.userLanguage && toolCall.name === 'rag_search') {
                logger.debug("System", "ChatManager", `Injecting userLanguage: ${metadata.userLanguage} for ${toolCall.name}`);
                toolArguments = {
                  ...toolArguments,
                  userLanguage: metadata.userLanguage
                };
              } else if (metadata?.language && toolCall.name === 'rag_search') {
                logger.debug("System", "ChatManager", `Using fallback language: ${metadata.language} for ${toolCall.name}`);
                toolArguments = {
                  ...toolArguments,
                  userLanguage: metadata.language
                };
              }
              
              // Execute the tool
              const result = await tool.execute(toolArguments);
              logger.success("System", "ChatManager", `Tool ${toolCall.name} executed successfully`);
              
              toolResults.push({
                name: toolCall.name,
                arguments: toolCall.arguments,
                result: result,
                success: true
              });
              
            } else {
              logger.warn("System", "ChatManager", `Tool ${toolCall.name} not found or not executable`);
              toolResults.push({
                name: toolCall.name,
                arguments: toolCall.arguments,
                error: `Tool ${toolCall.name} not found or not executable`,
                success: false
              });
            }
          }
        } catch (error) {
          logger.error("System", "ChatManager", `Error executing tool ${toolCall.name}: ${error}`);
          toolResults.push({
            name: toolCall.name,
            arguments: toolCall.arguments,
            error: error instanceof Error ? error.message : String(error),
            success: false
          });
        }
      }
      
      // Generate a final response based on tool results
      if (toolResults.length > 0) {
        try {
          logger.info("System", "ChatManager", `Generating final response based on ${toolResults.length} tool results`);
          
          const toolResultsMessage = {
            role: "system" as const,
            content: `You called the following tools and got these results:
${toolResults.map(tr => `Tool: ${tr.name}
Arguments: ${JSON.stringify(tr.arguments)}
Result: ${tr.success ? JSON.stringify(tr.result) : 'ERROR: ' + tr.error}`).join('\n\n')}

Based on these tool results, generate a helpful response to the user. Be natural and conversational - don't mention the technical details of the tool calls.`
          };
          
          // Call the model again with the tool results to generate the final response
          // Preserve streaming options for the final response
          const finalResponse = await model.complete([
            ...messages,
            toolResultsMessage
          ], {
            temperature,
            maxTokens,
            stream: stream, // Always preserve streaming setting
            onChunk: onChunk, // Always preserve chunk callback
            tools: undefined, // Don't use tools for the final response generation
            toolCalling: false
          });
          
          // Update response to the final result
          response = typeof finalResponse === 'string' ? finalResponse : finalResponse.content;
          
          const responseText = typeof response === 'string' ? response : response.content;
          logger.success("System", "ChatManager", `Final response generated: ${responseText.length} chars`);
        } catch (error) {
          logger.error("System", "ChatManager", `Error generating final response: ${error}`);
          // Fallback to original content plus tool results summary
          const originalContent = typeof response === 'string' ? response : response.content;
          response = `${originalContent}\n\nTool execution completed with ${toolResults.filter(r => r.success).length} successful results.`;
        }
      }
    }

    // Generate embedding for assistant response if needed
    let assistantEmbedding: number[] | undefined = undefined;
    const enableEmbeddings = this.config.memory.config?.enableEmbeddings;

    if (enableEmbeddings && embedding) {
      try {
        // Convert response to string for embedding generation
        const responseText = typeof response === 'string' ? response : response.content;
        assistantEmbedding = await Embedding.generateEmbedding(responseText);
      } catch (error) {
        logger.warn("System", "Embedding", `Error generating embedding: ${error}`);
      }
    }

    // Add assistant response to chat
    await this.addMessage({
      chatId,
      agentId,
      userId,
      role: "assistant",
      content: typeof response === 'string' ? response : response.content,
      metadata: {
        ...metadata,
        timestamp: new Date().toISOString(),
        modelUsed: model.name,
        taskSystemUsed: useTaskSystem,
        temperature,
        responseLength: (typeof response === 'string' ? response : response.content).length
      }
    });

    // Return the response (convert to string if it's a structured response)
    return typeof response === 'string' ? response : response.content;
  }

  async getChat(chatId: string): Promise<ChatMetadata | null> {
    validateRequiredParam(chatId, "chatId", "getChat");

    const result = await this.config.database.knex(this.tableName)
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
      metadata: result.metadata ? (typeof result.metadata === 'string' ? JSON.parse(result.metadata) : result.metadata) : undefined
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
    let query = this.config.database.knex(this.tableName)
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

    const limit = params.limit || this.maxChats;
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
  }

  async searchChats(params: {
    query: string;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ChatSummary[]> {
    validateRequiredParam(params.query, "params.query", "searchChats");

    let query = this.config.database.knex(this.tableName)
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

    const limit = params.limit || this.maxChats;
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
  }

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
    validateRequiredParam(params.role, "params.role", "addMessage");
    validateRequiredParam(params.content, "params.content", "addMessage");

    // Add message to memory (using sessionId = chatId)
    const messageId = await this.config.memory.add({
      agentId: params.agentId,
      sessionId: params.chatId, // sessionId = chatId for compatibility
      userId: params.userId,
      role: params.role,
      content: params.content,
      metadata: params.metadata
    });

    // Update chat metadata
    const now = new Date();
    await this.config.database.knex(this.tableName)
      .where({ id: params.chatId })
      .update({
        lastMessageAt: now,
        updatedAt: now,
        lastMessage: params.content.substring(0, 200) // Store first 200 chars
      })
      .increment('messageCount', 1);

    // Auto-generate title if this is the first user message and no title exists
    if (this.autoGenerateTitles && params.role === 'user') {
      const chat = await this.getChat(params.chatId);
      if (chat && !chat.title && chat.messageCount <= 1) {
        const title = generateTitleFromMessage(params.content);
        await this.updateChat(params.chatId, { title });
      }
    }

    return messageId;
  }

  async getMessages(chatId: string, limit?: number): Promise<ChatMessage[]> {
    validateRequiredParam(chatId, "chatId", "getMessages");

    // Get messages from memory using sessionId = chatId
    const messages = await this.config.memory.getBySession(chatId, limit);
    
    // Convert to ChatMessage format
    return messages.map(msg => ({
      ...msg,
      chatId: msg.sessionId // Add chatId for compatibility
    }));
  }

  async deleteMessage(messageId: string): Promise<void> {
    validateRequiredParam(messageId, "messageId", "deleteMessage");
    await this.config.memory.delete(messageId);
  }

  async clearMessages(chatId: string): Promise<void> {
    validateRequiredParam(chatId, "chatId", "clearMessages");
    
    // Clear messages from memory
    await this.config.memory.clear(chatId);
    
    // Reset message count in chat metadata
    await this.config.database.knex(this.tableName)
      .where({ id: chatId })
      .update({
        messageCount: 0,
        lastMessage: null,
        lastMessageAt: null,
        updatedAt: new Date()
      });
  }

  async getChatStats(params: {
    userId?: string;
    agentId?: string;
  } = {}): Promise<{
    totalChats: number;
    activeChats: number;
    archivedChats: number;
    totalMessages: number;
  }> {
    let query = this.config.database.knex(this.tableName);

    if (params.userId) {
      query = query.where({ userId: params.userId });
    }

    if (params.agentId) {
      query = query.where({ agentId: params.agentId });
    }

    const stats = await query
      .select(
        this.config.database.knex.raw('COUNT(*) as totalChats'),
        this.config.database.knex.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as activeChats', ['active']),
        this.config.database.knex.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as archivedChats', ['archived']),
        this.config.database.knex.raw('SUM(messageCount) as totalMessages')
      )
      .first();

    return {
      totalChats: parseInt(stats.totalChats) || 0,
      activeChats: parseInt(stats.activeChats) || 0,
      archivedChats: parseInt(stats.archivedChats) || 0,
      totalMessages: parseInt(stats.totalMessages) || 0
    };
  }

  async chat(params: {
    message: string;
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
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "chat");
    validateRequiredParam(params.chatId, "params.chatId", "chat");
    validateRequiredParam(params.agentId, "params.agentId", "chat");
    validateRequiredParam(params.model, "params.model", "chat");

    const {
      message,
      chatId,
      agentId,
      userId,
      model,
      systemPrompt,
      tools = [],
      taskManager,
      chatTitle,
      metadata = {},
      embedding,
      useTaskSystem = true,
      temperature = DEFAULT_TEMPERATURE,
      maxTokens = DEFAULT_MAX_TOKENS
    } = params;

    // Use createChatWithMessage which handles both creation and message processing
    return await this.createChatWithMessage({
      chatId,
      agentId,
      userId,
      title: chatTitle,
      metadata,
      message,
      model,
      systemPrompt,
      tools,
      taskManager,
      embedding,
      useTaskSystem,
      temperature,
      maxTokens,
      stream: params.stream,
      onChunk: params.onChunk
    });
  }
}

/**
 * Creates a chat management system that works with existing memory system
 * Chat IDs are the same as session IDs for backward compatibility
 * Can be used standalone or integrated with Agent instances
 */
export async function createChat(config: ChatConfig): Promise<ChatInstance> {
  const chatManager = new ChatManager(config);
  
  // Ensure chats table exists using user's custom table name
  const tableName = config.tableName || "chats";
  await config.database.ensureTable(tableName, (table: any) => {
    table.string('id').primary();
    table.string('title').nullable();
    table.string('userId').nullable();
    table.string('agentId').notNullable();
    table.string('status').defaultTo('active');
    table.timestamp('createdAt').defaultTo(config.database.knex.fn.now());
    table.timestamp('updatedAt').defaultTo(config.database.knex.fn.now());
    table.timestamp('lastMessageAt').nullable();
    table.integer('messageCount').defaultTo(0);
    table.string('lastMessage').nullable();
    table.text('metadata').nullable();
    
    // Add indexes for better performance
    table.index(['userId', 'status', 'updatedAt'], 'chats_userid_status_updated_idx');
    table.index(['agentId', 'status', 'updatedAt'], 'chats_agentid_status_updated_idx');
    table.index(['status', 'updatedAt'], 'chats_status_updated_idx');
  });
  
  logger.info("System", "ChatManager", `Chat manager initialized with custom table: ${tableName}`);
  return chatManager;
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