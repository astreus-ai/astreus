import { v4 as uuidv4 } from "uuid";
import { AgentConfig, AgentInstance, AgentFactory, Plugin, ProviderModel, ProviderInstance, MemoryInstance, ChatInstance, ChatMetadata, ChatSummary } from "./types";
import { createDatabase } from "./database";
import { PluginManager } from "./plugin";
import { validateRequiredParams, validateRequiredParam } from "./utils/validation";
import { logger } from "./utils/logger";
import { createRAGTools } from "./utils/rag-tools";
import { 
  DEFAULT_AGENT_NAME
} from "./constants";

// Agent implementation
class Agent implements AgentInstance {
  public id: string;
  public config: AgentConfig;
  private memory: MemoryInstance; // Replace any with MemoryInstance
  private tools: Map<string, Plugin>;
  private chatManager?: ChatInstance;

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

    // Initialize tools if provided
    if (this.config.tools) {
      this.config.tools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
    }

    // Create RAG tools if RAG instance is provided
    if (this.config.rag) {
      const ragTools = createRAGTools(this.config.rag);
      ragTools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
      logger.debug(`Added ${ragTools.length} RAG tools to agent ${this.config.name}`);
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

    // Save agent to database
    this.saveToDatabase();
  }

  private async saveToDatabase(): Promise<void> {
    try {
      // Use database from config if provided, otherwise create a new one
      const db = this.config.database || await createDatabase();
      const tableNames = db.getTableNames();
      const agentsTable = db.getTable(tableNames.agents);

      // Check if agent already exists
      const existingAgent = await agentsTable.findOne({ id: this.id });

      if (!existingAgent) {
        // Save new agent
        await agentsTable.insert({
          id: this.id,
          name: this.config.name,
          description: this.config.description || null,
          systemPrompt: this.config.systemPrompt || null,
          modelName: this.config.model?.name || "unknown",
          createdAt: new Date(),
          updatedAt: new Date(),
          configuration: JSON.stringify({
            hasTools: this.tools.size > 0,
            supportsTaskSystem: true,
          }),
        });
        logger.agent(this.config.name, `Agent saved to database with ID: ${this.id}`);
      } else {
        // Update existing agent
        await agentsTable.update(
          { id: this.id },
          {
            name: this.config.name,
            description: this.config.description || null,
            systemPrompt: this.config.systemPrompt || null,
            modelName: this.config.model?.name || "unknown",
            updatedAt: new Date(),
            configuration: JSON.stringify({
              hasTools: this.tools.size > 0,
              supportsTaskSystem: true,
            }),
          }
        );
        logger.agent(this.config.name, `Agent updated in database with ID: ${this.id}`);
      }
    } catch (error) {
      logger.error("Error saving agent to database:", error);
    }
  }

  // Helper method to safely get the model
  getModel(): ProviderModel {
    if (!this.config.model) {
      throw new Error("No model specified for agent");
    }
    return this.config.model;
  }

  // Get the provider instance
  getProvider(): ProviderInstance | undefined {
    return this.config.provider;
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

  // Chat method without streaming
  async chat(params: {
    message: string;
    sessionId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "chat");

    const {
      message,
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      systemPrompt = this.config.systemPrompt,
      temperature = 0.7,
      maxTokens = 2000,
      metadata = {}
    } = params;

    // Get conversation history
    const history = sessionId ? await this.getHistory(sessionId) : [];

    // Prepare messages for the model
    const messages = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...history.map((msg: any) => ({
        role: (msg.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: msg.content
      })),
      { role: 'user' as const, content: message }
    ];

    // Get response from model
    const model = this.getModel();
    const response = await model.complete(messages, {
      temperature,
      maxTokens
    });

    const responseContent = typeof response === 'string' ? response : response.content;

    // Save to memory
    await this.addToMemory({
      sessionId,
      role: 'user',
      content: message,
      metadata
    });

    await this.addToMemory({
      sessionId,
      role: 'assistant',
      content: responseContent,
      metadata
    });

    return responseContent;
  }

  // Streaming chat method
  async streamChat(params: {
    message: string;
    sessionId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    onChunk?: (chunk: string) => void;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "streamChat");

    const {
      message,
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      systemPrompt = this.config.systemPrompt,
      temperature = 0.7,
      maxTokens = 2000,
      metadata = {},
      onChunk
    } = params;

    // Get conversation history
    const history = sessionId ? await this.getHistory(sessionId) : [];

    // Prepare messages for the model
    const messages = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...history.map((msg: any) => ({
        role: (msg.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: msg.content
      })),
      { role: 'user' as const, content: message }
    ];

    let fullResponse = '';
    const model = this.getModel();
    const provider = this.getProvider();

    // Try to get OpenAI client for real streaming
    const openaiClient = (provider as any)?.client || (model as any)?.client;

    if (openaiClient && openaiClient.chat && openaiClient.chat.completions) {
      logger.debug(`Agent ${this.config.name}: Using real OpenAI streaming`);
      
      // Use OpenAI streaming directly for incremental chunks
      const stream = await openaiClient.chat.completions.create({
        model: model.name || 'gpt-4o-mini',
        messages: messages,
        stream: true,
        temperature,
        max_tokens: maxTokens
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          if (onChunk) {
            onChunk(content); // Send only the new chunk
          }
        }
      }
    } else if (model.complete) {
      logger.debug(`Agent ${this.config.name}: Using simulated streaming`);
      
      // Fallback to complete method with simulated streaming
      const response = await model.complete(messages, {
        temperature,
        maxTokens
      });

      const responseContent = typeof response === 'string' ? response : response.content;
      fullResponse = responseContent;

      if (onChunk) {
        // Simulate streaming by sending word by word
        const words = responseContent.split(' ');
        for (let i = 0; i < words.length; i++) {
          const word = words[i] + (i < words.length - 1 ? ' ' : '');
          onChunk(word);
          // Small delay for realistic streaming effect
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    } else {
      throw new Error('No suitable model method available for streaming');
    }

    // Save to memory
    await this.addToMemory({
      sessionId,
      role: 'user',
      content: message,
      metadata
    });

    await this.addToMemory({
      sessionId,
      role: 'assistant',
      content: fullResponse,
      metadata
    });

    return fullResponse;
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
    // Update database when tools change
    this.saveToDatabase();
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

  async streamChatWithId(params: {
    message: string;
    chatId: string;
    userId?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    onChunk?: (chunk: string) => void;
  }): Promise<string> {
    validateRequiredParam(params.message, "params.message", "streamChatWithId");
    validateRequiredParam(params.chatId, "params.chatId", "streamChatWithId");
    
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

    // For now, use the regular chat method and simulate streaming
    // This can be enhanced later with true streaming support in ChatManager
    const response = await this.chatManager.chat({
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

    // Simulate streaming by calling onChunk with the full response
    if (params.onChunk) {
      params.onChunk(response);
    }

    return response;
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

  return agent;
}; 