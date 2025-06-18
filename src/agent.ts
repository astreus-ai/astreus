import { v4 as uuidv4 } from "uuid";
import {
  AgentConfig,
  AgentInstance,
  AgentFactory,
  ProviderModel,
  ProviderInstance,
  ProviderMessage,
  MemoryInstance,
  TaskInstance,
  TaskManagerInstance,
  DatabaseInstance,
  Plugin,
  RAGInstance,
  ChatInstance,
  ChatMetadata,
  ChatSummary,
  StructuredCompletionResponse,
  TaskConfig,
  TaskResult,
  PluginWithTools,
} from "./types";
import { createTaskManager } from "./tasks";
import { logger } from "./utils";
import { validateRequiredParam, validateRequiredParams } from "./utils/validation";
import { convertToolParametersToSchema } from "./utils";
import { 
  DEFAULT_TEMPERATURE, 
  DEFAULT_MAX_TOKENS,
  DEFAULT_AGENT_NAME
} from "./constants";
import { createDatabase } from "./database";
import { PluginManager } from "./plugin";

// Agent implementation
class Agent implements AgentInstance {
  public id: string;
  public config: AgentConfig;
  private memory: MemoryInstance;
  private tools: Map<string, Plugin>;
  private chatManager?: ChatInstance;
  private database?: DatabaseInstance;
  private taskManager?: TaskManagerInstance;
  private rag?: RAGInstance;

  constructor(config: AgentConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Agent constructor");
    validateRequiredParams(
      config,
      ["memory"],  // 'name' is optional now since we have a default
      "Agent constructor"
    );
    
    // Ensure either model or provider is specified
    if (!config.model && !config.provider) {
      throw new Error("Either 'model' or 'provider' must be specified in agent config");
    }
    
    // If provider is given but model is not, use default model from provider
    if (config.provider && !config.model) {
      const defaultModelName = config.provider.getDefaultModel?.() || config.provider.listModels()[0];
      if (defaultModelName) {
        config.model = config.provider.getModel(defaultModelName);
      } else {
        throw new Error("No default model available in provider");
      }
    }
    
    // Ensure we have a model at this point
    if (!config.model) {
      throw new Error("No model could be determined for the agent");
    }
    
    // Set default values for optional parameters
    this.id = config.id || uuidv4();
    this.config = {
      ...config,
      name: config.name || DEFAULT_AGENT_NAME,
      description: config.description || `Agent ${config.name || DEFAULT_AGENT_NAME}`,
      tools: config.tools || [],
      plugins: config.plugins || []
    };
    this.memory = config.memory;
    this.tools = new Map();
    this.chatManager = config.chat;
    this.database = config.database;
    this.taskManager = config.taskManager;
    this.rag = config.rag;

    // Initialize tools if provided
    if (this.config.tools) {
      this.config.tools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
    }

    // Create RAG tools if RAG instance is provided
    if (this.config.rag) {
      logger.debug(`Agent ${this.config.name}: Checking RAG instance for tools...`);
      
      // Check if RAG instance has createRAGTools method
      if ('createRAGTools' in this.config.rag && typeof this.config.rag.createRAGTools === 'function') {
        const ragTools = this.config.rag.createRAGTools();
        ragTools.forEach((tool: Plugin) => {
          this.tools.set(tool.name, tool);
        });
        logger.debug(`Agent ${this.config.name}: Added ${ragTools.length} RAG tools`);
      } else {
        logger.warn(`Agent ${this.config.name}: RAG instance does not have createRAGTools method`);
        logger.debug(`Agent ${this.config.name}: RAG instance keys:`, Object.keys(this.config.rag));
      }
    }

    // Initialize plugins and register their tools if provided
    if (this.config.plugins) {
      for (const plugin of this.config.plugins) {
        // Check if plugin has getTools method (PluginInstance)
        if (plugin && 'getTools' in plugin && typeof plugin.getTools === 'function') {
          const pluginTools = plugin.getTools();
          
          if (pluginTools && Array.isArray(pluginTools)) {
            pluginTools.forEach((tool: Plugin) => {
              if (tool && tool.name) {
                this.tools.set(tool.name, tool);
                // Also register with the global registry
                PluginManager.register(tool);
              }
            });
          }
        } 
        // Check if it's a direct Plugin object
        else if (plugin && 'name' in plugin && plugin.name && 'execute' in plugin) {
          // This is already a tool/plugin, register it directly
          const toolPlugin = plugin as Plugin;
          this.tools.set(toolPlugin.name, toolPlugin);
          PluginManager.register(toolPlugin);
        }
      }
    }

    // Log final tool count
    logger.debug(`Agent ${this.config.name}: Initialized with ${this.tools.size} tools:`, Array.from(this.tools.keys()));
  }



  // Instance access methods
  getModel(): ProviderModel {
    if (!this.config.model) {
      throw new Error("No model specified for agent");
    }
    return this.config.model;
  }

  getProvider(): ProviderInstance | undefined {
    return this.config.provider;
  }

  getMemory(): MemoryInstance {
    return this.memory;
  }

  getDatabase(): DatabaseInstance | undefined {
    return this.database;
  }

  getTaskManager(): TaskManagerInstance | undefined {
    return this.taskManager;
  }

  getRAG(): RAGInstance | undefined {
    return this.rag;
  }

  // Memory access methods
  async getHistory(sessionId: string, limit?: number): Promise<any[]> {
    validateRequiredParam(sessionId, "sessionId", "getHistory");
    return await this.memory.getBySession(sessionId, limit);
  }

  async clearHistory(sessionId: string): Promise<void> {
    validateRequiredParam(sessionId, "sessionId", "clearHistory");
    await this.memory.clear(sessionId);
  }

  async addToMemory(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    validateRequiredParam(params.sessionId, "params.sessionId", "addToMemory");
    validateRequiredParam(params.role, "params.role", "addToMemory");
    validateRequiredParam(params.content, "params.content", "addToMemory");

    return await this.memory.add({
      agentId: this.id,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      metadata: params.metadata || {}
    });
  }

  // List all sessions for this agent
  async listSessions(limit?: number): Promise<{
    sessionId: string;
    lastMessage?: string;
    messageCount: number;
    lastActivity: Date;
    metadata?: Record<string, unknown>;
  }[]> {
    try {
      // Get all sessions from memory for this agent
      const sessions = await this.memory.listSessions(this.id, limit);
      
      return sessions.map((session: any) => ({
        sessionId: session.sessionId,
        lastMessage: session.lastMessage || session.content,
        messageCount: session.messageCount || 1,
        lastActivity: session.lastActivity || session.createdAt || new Date(),
        metadata: session.metadata || {}
      }));
    } catch (error) {
      logger.error(`Error listing sessions for agent ${this.id}:`, error);
      return [];
    }
  }

  // Chat method - delegates to ChatManager
  async chat(params: {
    message: string;
    sessionId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "chat");

    const {
      message,
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      systemPrompt = this.config.systemPrompt,
      temperature = 0.7,
      maxTokens = 2000,
      metadata = {},
      stream = false,
      onChunk
    } = params;

    if (!this.chatManager) {
      throw new Error("ChatManager is required for agent chat functionality. Please configure a ChatManager in the agent config.");
    }

    // Use ChatManager for all chat functionality with streaming support
    return await this.chatManager.chat({
      message,
      chatId: sessionId,
      agentId: this.id,
      model: this.getModel(),
      systemPrompt,
      tools: Array.from(this.tools.values()),
      metadata,
      temperature,
      maxTokens,
      stream,
      onChunk
    });
  }

  /**
   * Get available tool names
   * @returns Array of tool names available to the agent
   */
  getAvailableTools(): string[] {
    return Array.from(this.tools.keys());
  }

  addTool(tool: Plugin): void {
    // Validate required parameters
    validateRequiredParam(tool, "tool", "addTool");
    validateRequiredParams(
      tool,
      ["name", "description", "execute"],
      "addTool"
    );
    
    this.tools.set(tool.name, tool);
  }

  /**
   * Get the chat manager instance if available
   */
  getChatManager(): ChatInstance | undefined {
    return this.chatManager;
  }

  /**
   * Set or update the chat manager instance
   */
  setChatManager(chatManager: ChatInstance): void {
    this.chatManager = chatManager;
  }

  // Chat management methods
  async createChat(params: {
    chatId?: string;
    userId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatMetadata> {
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    return await this.chatManager.createChat({
      chatId: params.chatId,
      userId: params.userId,
      agentId: this.id,
      title: params.title,
      metadata: params.metadata
    });
  }

  async getChat(chatId: string): Promise<ChatMetadata | null> {
    validateRequiredParam(chatId, "chatId", "getChat");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    return await this.chatManager.getChat(chatId);
  }

  async updateChat(chatId: string, updates: Partial<ChatMetadata>): Promise<void> {
    validateRequiredParam(chatId, "chatId", "updateChat");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    await this.chatManager.updateChat(chatId, updates);
  }

  async deleteChat(chatId: string): Promise<void> {
    validateRequiredParam(chatId, "chatId", "deleteChat");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    await this.chatManager.deleteChat(chatId);
  }

  async archiveChat(chatId: string): Promise<void> {
    validateRequiredParam(chatId, "chatId", "archiveChat");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    await this.chatManager.archiveChat(chatId);
  }

  async listChats(params?: {
    userId?: string;
    status?: 'active' | 'archived' | 'deleted';
    limit?: number;
    offset?: number;
  }): Promise<ChatSummary[]> {
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    return await this.chatManager.listChats({
      ...params,
      agentId: this.id
    });
  }

  async searchChats(params: {
    query: string;
    userId?: string;
    limit?: number;
  }): Promise<ChatSummary[]> {
    validateRequiredParam(params.query, "params.query", "searchChats");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    return await this.chatManager.searchChats({
      ...params,
      agentId: this.id
    });
  }

  async getChatStats(params?: {
    userId?: string;
  }): Promise<{
    totalChats: number;
    activeChats: number;
    archivedChats: number;
    totalMessages: number;
  }> {
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    return await this.chatManager.getChatStats({
      ...params,
      agentId: this.id
    });
  }

  // Enhanced chat methods with chat ID support
  async chatWithId(params: {
    message: string;
    chatId: string;
    userId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "chatWithId");
    validateRequiredParam(params.chatId, "params.chatId", "chatWithId");
    
    if (!this.chatManager) {
      throw new Error("Chat manager not configured for this agent");
    }

    // Check if chat exists, if not create it
    const existingChat = await this.chatManager.getChat(params.chatId);
    if (!existingChat) {
      await this.chatManager.createChat({
        chatId: params.chatId,
        userId: params.userId,
        agentId: this.id,
        metadata: params.metadata
      });
    }

    return await this.chatManager.chat({
      message: params.message,
      chatId: params.chatId,
      agentId: this.id,
      userId: params.userId,
      model: this.getModel(),
      systemPrompt: params.systemPrompt || this.config.systemPrompt,
      tools: Array.from(this.tools.values()),
      metadata: params.metadata,
      temperature: params.temperature,
      maxTokens: params.maxTokens
    });
  }


}

// Agent factory function
export const createAgent: AgentFactory = async (config: AgentConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createAgent");
  validateRequiredParams(
    config,
    ["memory"],
    "createAgent"
  );
  
  // Ensure either model or provider is specified
  if (!config.model && !config.provider) {
    throw new Error("Either 'model' or 'provider' must be specified in agent config");
  }
  
  // Create a new agent instance
  const agent = new Agent(config);

  // Save agent to database
  try {
    // Use database from config if provided, otherwise create a new one
    const db = config.database || await createDatabase();
    const tableNames = db.getTableNames();
    
    // Ensure agents table exists
    await db.ensureTable(tableNames.agents, (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.text("description").nullable();
      table.text("systemPrompt").nullable();
      table.string("modelName").notNullable();
      table.timestamp("createdAt").defaultTo(db.knex.fn.now());
      table.timestamp("updatedAt").defaultTo(db.knex.fn.now());
      table.json("configuration").nullable();
    });

    const agentsTable = db.getTable(tableNames.agents);

    // Check if agent already exists
    const existingAgent = await agentsTable.findOne({ id: agent.id });

    if (!existingAgent) {
      // Save new agent
      await agentsTable.insert({
        id: agent.id,
        name: agent.config.name,
        description: agent.config.description || null,
        systemPrompt: agent.config.systemPrompt || null,
        modelName: agent.config.model?.name || "unknown",
        createdAt: new Date(),
        updatedAt: new Date(),
        configuration: JSON.stringify({
          hasTools: agent.getAvailableTools().length > 0,
          supportsTaskSystem: true,
        }),
      });
      logger.agent(agent.config.name || DEFAULT_AGENT_NAME, `Agent saved to database with ID: ${agent.id}`);
    } else {
      // Update existing agent
      await agentsTable.update(
        { id: agent.id },
        {
          name: agent.config.name,
          description: agent.config.description || null,
          systemPrompt: agent.config.systemPrompt || null,
          modelName: agent.config.model?.name || "unknown",
          updatedAt: new Date(),
          configuration: JSON.stringify({
            hasTools: agent.getAvailableTools().length > 0,
            supportsTaskSystem: true,
          }),
        }
      );
      logger.agent(agent.config.name || DEFAULT_AGENT_NAME, `Agent updated in database with ID: ${agent.id}`);
    }
  } catch (error) {
    logger.error("Error saving agent to database:", error);
  }

  return agent;
}; 