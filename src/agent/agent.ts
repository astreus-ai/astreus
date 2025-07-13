import { v4 as uuidv4 } from "uuid";
import {
  AgentConfig,
  AgentInstance,
  ProviderModel,
  ProviderInstance,
  MemoryInstance,
  TaskManagerInstance,
  DatabaseInstance,
  Plugin,
  RAGInstance,
  ChatInstance,
  ChatMetadata,
  ChatSummary,
} from "../types";
import { PersonalityInstance } from "../personality/types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { 
  DEFAULT_AGENT_NAME
} from "./config";
import { PluginRegistry } from "../plugin/";
import { analyzeMedia, analyzeImage, analyzeDocument, analyzeWithContext } from "../utils/analyze";

// Agent implementation
export class Agent implements AgentInstance {
  public id: string;
  public config: AgentConfig & { name: string };
  private memory: MemoryInstance;
  private tools: Map<string, Plugin>;
  private chatManager?: ChatInstance;
  private database?: DatabaseInstance;
  private taskManager?: TaskManagerInstance;
  private rag?: RAGInstance;
  private personality?: PersonalityInstance;

  constructor(config: AgentConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Agent constructor");
    validateRequiredParams(
      config,
      ["memory"],  // 'name' is optional now since we have a default
      "Agent constructor"
    );
    
    logger.info("System", "Agent", `Creating agent with config: ${config.name || DEFAULT_AGENT_NAME}`);
    
    // Ensure either model or provider is specified
    if (!config.model && !config.provider) {
      logger.error("System", "Agent", "Either 'model' or 'provider' must be specified in agent config");
      throw new Error("Either 'model' or 'provider' must be specified in agent config");
    }
    
    // If provider is given but model is not, use default model from provider
    if (config.provider && !config.model) {
      const defaultModelName = config.provider.getDefaultModel?.() || config.provider.listModels()[0];
      if (defaultModelName) {
        config.model = config.provider.getModel(defaultModelName);
        logger.info("System", "Agent", `Using default model from provider: ${defaultModelName}`);
      } else {
        logger.error("System", "Agent", "No default model available in provider");
        throw new Error("No default model available in provider");
      }
    }
    
    // Ensure we have a model at this point
    if (!config.model) {
      logger.error("System", "Agent", "No model could be determined for the agent");
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
    this.personality = config.personality;

    logger.info(this.config.name, "Agent", `Initialized with ID: ${this.id}`);
    logger.debug(this.config.name, "Agent", `Model: ${config.model.name}, Memory: ${!!this.memory}, Database: ${!!this.database}`);

    // Initialize tools if provided
    if (this.config.tools) {
      logger.info(this.config.name, "Agent", `Loading ${this.config.tools.length} direct tools`);
      this.config.tools.forEach((tool) => {
        this.tools.set(tool.name, tool);
        logger.debug(this.config.name, "Tools", `Added tool: ${tool.name}`);
      });
    }

    // Create RAG tools if RAG instance is provided
    if (this.config.rag) {
      logger.info(this.config.name, "Agent", "Setting up RAG tools");
      // Check if RAG instance has createRAGTools method
      if ('createRAGTools' in this.config.rag && typeof this.config.rag.createRAGTools === 'function') {
        const ragTools = this.config.rag.createRAGTools();
        ragTools.forEach((tool: Plugin) => {
          this.tools.set(tool.name, tool);
          logger.debug(this.config.name, "RAG", `Added tool: ${tool.name}`);
        });
        logger.success(this.config.name, "RAG", `Added ${ragTools.length} tools`);
      } else {
        logger.warn(this.config.name, "RAG", "No createRAGTools method found");
      }
    }

    // Initialize plugins and register their tools if provided
    if (this.config.plugins) {
      logger.info(this.config.name, "Agent", `Loading ${this.config.plugins.length} plugins`);
      for (const plugin of this.config.plugins) {
        // Check if plugin has getTools method (PluginInstance)
        if (plugin && 'getTools' in plugin && typeof plugin.getTools === 'function') {
          const pluginTools = plugin.getTools();
          
          if (pluginTools && Array.isArray(pluginTools)) {
            pluginTools.forEach((tool: Plugin) => {
              if (tool && tool.name) {
                this.tools.set(tool.name, tool);
                // Also register with the global registry
                PluginRegistry.register(tool);
                logger.debug(this.config.name, "Plugin", `Added tool: ${tool.name}`);
              }
            });
            logger.success(this.config.name, "Plugin", `Loaded plugin with ${pluginTools.length} tools`);
          }
        } 
        // Check if it's a direct Plugin object
        else if (plugin && 'name' in plugin && plugin.name && 'execute' in plugin) {
          // This is already a tool/plugin, register it directly
          const toolPlugin = plugin as Plugin;
          this.tools.set(toolPlugin.name, toolPlugin);
          PluginRegistry.register(toolPlugin);
          logger.debug(this.config.name, "Plugin", `Added direct tool: ${toolPlugin.name}`);
        }
      }
    }

    // Log final tool count
    logger.success(this.config.name, "Agent", `Initialized with ${this.tools.size} tools total`);
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

  // Personality management methods
  getPersonality(): PersonalityInstance | undefined {
    return this.personality;
  }

  setPersonality(personality: PersonalityInstance): void {
    validateRequiredParam(personality, "personality", "setPersonality");
    
    this.personality = personality;
    logger.info(this.config.name, "Agent", `Personality set: ${personality.config.name} (${personality.id})`);
  }

  removePersonality(): void {
    if (this.personality) {
      const removedName = this.personality.config.name;
      this.personality = undefined;
      logger.info(this.config.name, "Agent", `Personality removed: ${removedName}`);
    }
  }

  // Get the combined system prompt with personality
  private getCombinedSystemPrompt(baseSystemPrompt?: string): string {
    const systemPrompt = baseSystemPrompt || this.config.systemPrompt || '';
    
    if (this.personality) {
      const personalityPrompt = this.personality.getPrompt();
      // Add personality prompt at the beginning if it exists
      if (personalityPrompt) {
        return personalityPrompt + (systemPrompt ? '\n\n' + systemPrompt : '');
      }
    }
    
    return systemPrompt;
  }

  // Memory access methods
  async getHistory(sessionId: string, limit?: number): Promise<any[]> {
    validateRequiredParam(sessionId, "sessionId", "getHistory");
    logger.debug(this.config.name, "Memory", `Retrieving history for session: ${sessionId}, limit: ${limit || 'none'}`);
    const history = await this.memory.getBySession(sessionId, limit);
    logger.debug(this.config.name, "Memory", `Retrieved ${history.length} messages for session: ${sessionId}`);
    return history;
  }

  async clearHistory(sessionId: string): Promise<void> {
    validateRequiredParam(sessionId, "sessionId", "clearHistory");
    logger.info(this.config.name, "Memory", `Clearing history for session: ${sessionId}`);
    await this.memory.clear(sessionId);
    logger.success(this.config.name, "Memory", `History cleared for session: ${sessionId}`);
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

    logger.debug(this.config.name, "Memory", `Adding ${params.role} message to session: ${params.sessionId}`);
    const messageId = await this.memory.add({
      agentId: this.id,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      metadata: params.metadata || {}
    });
    logger.debug(this.config.name, "Memory", `Message added with ID: ${messageId}`);
    return messageId;
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
      logger.error("System", "Sessions", `Error listing sessions for agent ${this.id}: ${error}`);
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
    canUseTools?: boolean;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "chat");

    const {
      message,
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      systemPrompt,
      temperature = 0.7,
      maxTokens = 2000,
      metadata = {},
      stream = false,
      onChunk,
      canUseTools = true
    } = params;

    // Use combined system prompt that includes personality
    const finalSystemPrompt = this.getCombinedSystemPrompt(systemPrompt);

    logger.info(this.config.name, "Chat", `Processing message in session: ${sessionId}`);
    logger.debug(this.config.name, "Chat", `Message length: ${message.length}, Tools: ${this.tools.size}, Stream: ${stream}`);

    if (!this.chatManager) {
      logger.error(this.config.name, "Chat", "ChatManager is required for agent chat functionality");
      throw new Error("ChatManager is required for agent chat functionality. Please configure a ChatManager in the agent config.");
    }

    // Use ChatManager for all chat functionality with streaming support
    const response = await this.chatManager.chat({
      message,
      chatId: sessionId,
      agentId: this.id,
      model: this.getModel(),
      systemPrompt: finalSystemPrompt,
      tools: canUseTools ? Array.from(this.tools.values()) : [],
      metadata,
      temperature,
      maxTokens,
      stream,
      onChunk,
      canUseTools
    });

    logger.success(this.config.name, "Chat", `Response generated (${response.length} chars) for session: ${sessionId}`);
    return response;
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
    
    logger.info(this.config.name, "Tools", `Adding tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    logger.success(this.config.name, "Tools", `Tool added successfully: ${tool.name} (total: ${this.tools.size})`);
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

  // Task creation methods
  async createTask(config: Omit<TaskConfig, 'agentId'>, model?: ProviderModel): Promise<TaskInstance> {
    if (!this.taskManager) {
      throw new Error("Task manager not configured for this agent");
    }

    // Create task with agent's personality automatically included
    const taskConfig = {
      ...config,
      agentId: this.id,
      personality: config.personality || this.personality // Use task's personality or fall back to agent's
    };

    return await this.taskManager.createTask(taskConfig, model);
  }

  async executeTask(taskId: string, input?: any): Promise<TaskResult> {
    if (!this.taskManager) {
      throw new Error("Task manager not configured for this agent");
    }

    return await this.taskManager.executeTask(taskId, input);
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
    canUseTools?: boolean;
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
      systemPrompt: this.getCombinedSystemPrompt(params.systemPrompt),
      tools: (params.canUseTools !== false) ? Array.from(this.tools.values()) : [],
      metadata: params.metadata,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      canUseTools: params.canUseTools !== false
    });
  }

  // Media Analysis Methods
  async analyzeMedia(params: {
    filePath?: string;
    url?: string;
    base64Data?: string;
    prompt?: string;
    analysisType?: 'general' | 'detailed' | 'ocr' | 'document_analysis';
    sessionId?: string;
    metadata?: Record<string, unknown>;
    addToMemory?: boolean;
  }): Promise<{
    type: string;
    content: string;
    analysis: string;
    metadata?: any;
  }> {
    return analyzeMedia(params, {
      agentName: this.config.name,
      agentId: this.id,
      model: this.getModel(),
      memory: this.memory
    });
  }

  async analyzeImage(params: {
    imagePath?: string;
    imageUrl?: string;
    base64Data?: string;
    prompt?: string;
    detail?: 'low' | 'high' | 'auto';
    sessionId?: string;
    addToMemory?: boolean;
  }): Promise<string> {
    return analyzeImage(params, {
      agentName: this.config.name,
      agentId: this.id,
      model: this.getModel(),
      memory: this.memory
    });
  }

  async analyzeDocument(params: {
    filePath?: string;
    url?: string;
    prompt?: string;
    sessionId?: string;
    addToMemory?: boolean;
  }): Promise<{ text: string; analysis: string; metadata?: any }> {
    return analyzeDocument(params, {
      agentName: this.config.name,
      agentId: this.id,
      model: this.getModel(),
      memory: this.memory
    });
  }

  async analyzeWithContext(params: {
    filePath?: string;
    url?: string;
    base64Data?: string;
    context: string;
    sessionId?: string;
    addToMemory?: boolean;
  }): Promise<string> {
    return analyzeWithContext(params, {
      agentName: this.config.name,
      agentId: this.id,
      model: this.getModel(),
      memory: this.memory,
      chat: this.chat.bind(this)
    });
  }
}