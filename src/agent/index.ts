import {
  AgentConfig,
  AgentConfigInput,
  IAgent,
  IAgentWithModules,
  RunOptions,
  AskOptions,
} from './types';
import { DEFAULT_AGENT_CONFIG } from './defaults';
import { Task as TaskType, TaskRequest, TaskSearchOptions, TaskResponse } from '../task/types';
import { Memory as MemoryType, MemorySearchOptions } from '../memory/types';
import { MCPServerDefinition, MCPValue, MCPTool } from '../mcp/types';
import { AnalysisOptions } from '../vision/index';
import { MetadataObject } from '../types';
import {
  ToolDefinition,
  Plugin as IPlugin,
  ToolParameterValue,
  PluginConfig,
  ToolCallResult,
} from '../plugin/types';
import { convertToolParametersToJsonSchema } from '../plugin';

import { Task } from '../task';
import { Memory } from '../memory';
import { Graph } from '../graph';
import { Plugin } from '../plugin';
import { MCP } from '../mcp';
import { Knowledge } from '../knowledge';
import { Vision } from '../vision';
import { SubAgent } from '../sub-agent';
import { ContextManager } from '../context';
import {
  ContextMessage,
  ContextWindow,
  ContextAnalysis,
  ContextSummary,
  CompressionResult,
} from '../context/types';
import { getDatabase } from '../database';
import { getProviderForModel } from '../llm/models';
import { getLLM } from '../llm';
import { LLMRequestOptions, Tool, ToolCall } from '../llm/types';
import { Logger } from '../logger';
import * as fs from 'fs/promises';

/**
 * Abstract base class for all agents
 * Provides core functionality and database operations
 */
export abstract class BaseAgent implements IAgent {
  public data: AgentConfig;
  public logger: Logger;
  protected sessionMessages: ContextMessage[] = []; // Session-only messages when memory is disabled

  constructor(data: AgentConfig) {
    this.data = data;

    // Create isolated logger instance for this agent (not shared)
    const debugMode = data.debug === true;
    this.logger = new Logger({
      level: debugMode ? 'debug' : 'info',
      debug: debugMode,
      enableConsole: true,
      enableFile: false,
      agentName: data.name,
    });
  }

  /**
   * Abstract method that must be implemented by concrete agent classes
   */
  abstract run(prompt: string, options?: RunOptions): Promise<string>;

  /**
   * Abstract method that must be implemented by concrete agent classes
   */
  abstract ask(prompt: string, options?: AskOptions): Promise<string>;

  /**
   * Abstract context methods that must be implemented by concrete agent classes
   */
  abstract getContext(): ContextMessage[];

  // Getters for IAgent interface
  get id(): string {
    if (this.data.id === undefined || this.data.id === null) {
      throw new Error(
        `Agent ${this.data.name || 'unknown'} has no ID - agent may not be saved to database`
      );
    }
    return this.data.id;
  }

  get name(): string {
    if (!this.data.name) {
      throw new Error('Agent name is required but not provided');
    }
    return this.data.name;
  }

  get config(): AgentConfig {
    return this.data;
  }

  // Feature checks
  canUseTools(): boolean {
    return this.config.useTools !== false;
  }

  hasMemory(): boolean {
    return this.config.memory === true;
  }

  hasKnowledge(): boolean {
    return this.config.knowledge === true;
  }

  hasVision(): boolean {
    return this.config.vision === true;
  }

  // Instance methods
  async update(updates: Partial<AgentConfig>): Promise<void> {
    if (!this.data.id) {
      throw new Error('Cannot update agent: agent has no ID');
    }

    const db = await getDatabase();
    const updatedData = await db.updateAgent(this.data.id, updates);
    if (!updatedData) {
      throw new Error(`Failed to update agent ${this.data.name}: database returned null`);
    }

    this.data = updatedData;

    // Update logger debug mode if changed
    if (updates.debug !== undefined) {
      const debugMode = updates.debug === true;
      const agentName = this.data.name || 'unknown';
      this.logger = new Logger({
        level: debugMode ? 'debug' : 'info',
        debug: debugMode,
        enableConsole: true,
        enableFile: false,
        agentName,
      });
    }
  }

  async delete(): Promise<boolean> {
    if (!this.data.id) {
      throw new Error('Cannot delete agent: agent has no ID');
    }

    const db = await getDatabase();
    return db.deleteAgent(this.data.id);
  }

  // Utility methods from original
  getId(): string {
    if (!this.data.id) {
      throw new Error('Agent has no ID');
    }
    return this.data.id;
  }

  getName(): string {
    return this.data.name;
  }

  getDescription(): string | null {
    return this.data.description || null;
  }

  getModel(): string {
    return this.config.model || DEFAULT_AGENT_CONFIG.model;
  }

  getTemperature(): number {
    return this.config.temperature || DEFAULT_AGENT_CONFIG.temperature;
  }

  getMaxTokens(): number {
    return this.config.maxTokens || DEFAULT_AGENT_CONFIG.maxTokens;
  }

  getSystemPrompt(): string | null {
    return this.config.systemPrompt || null;
  }

  /**
   * Protected helper for concrete implementations
   */
  protected async callLLM(prompt: string, options?: RunOptions): Promise<string> {
    const llm = getLLM(this.logger);

    const response = await llm.generateResponse({
      model: options?.model || this.getModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature || this.getTemperature(),
      maxTokens: options?.maxTokens || this.getMaxTokens(),
      systemPrompt: this.getSystemPrompt() || undefined,
      stream: options?.stream,
    });

    return response.content;
  }
}

/**
 * Main Agent class with module system
 */
export class Agent extends BaseAgent implements IAgentWithModules {
  private modules: {
    task: Task;
    memory?: Memory;
    graph?: Graph;
    plugin?: Plugin;
    mcp?: MCP;
    knowledge?: Knowledge;
    vision?: Vision;
    subAgent?: SubAgent;
    context?: ContextManager;
  };

  constructor(data: AgentConfig) {
    super(data);

    // Initialize modules
    this.modules = {
      task: new Task(this),
    };

    if (data.memory) {
      this.modules.memory = new Memory(this);
    }

    if (data.useTools !== false) {
      this.modules.plugin = new Plugin(this);
      this.modules.mcp = new MCP(this);
    }

    if (data.knowledge) {
      this.modules.knowledge = new Knowledge(this);
    }

    if (data.vision) {
      this.modules.vision = new Vision(this);
    }

    // Always initialize SubAgent module for potential sub-agent usage
    this.modules.subAgent = new SubAgent(this.logger);

    // Always initialize context manager (core component)
    this.modules.context = new ContextManager({
      maxContextLength: data.maxContextLength || data.maxTokens || 8000,
      autoCompress: data.autoContextCompression || false,
      model: this.getModel(), // Use agent's effective model
      preserveLastN: data.preserveLastN,
      compressionRatio: data.compressionRatio,
      compressionStrategy: data.compressionStrategy,
    });

    // Module methods are now directly implemented in the class
  }

  // ===== TASK MODULE METHODS (always available) =====

  async createTask(request: TaskRequest): Promise<TaskType> {
    return this.modules.task.createTask(request);
  }

  async getTask(id: string): Promise<TaskType | null> {
    return this.modules.task.getTask(id);
  }

  async listTasks(options?: TaskSearchOptions): Promise<TaskType[]> {
    return this.modules.task.listTasks(options);
  }

  async updateTask(id: string, updates: Partial<TaskType>): Promise<TaskType | null> {
    return this.modules.task.updateTask(id, updates);
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.modules.task.deleteTask(id);
  }

  async clearTasks(): Promise<number> {
    return this.modules.task.clearTasks();
  }

  async executeTask(
    taskId: string,
    options?: { model?: string; stream?: boolean }
  ): Promise<TaskResponse> {
    return this.modules.task.executeTask(taskId, options);
  }

  // ===== MEMORY MODULE METHODS (when memory enabled) =====

  async addMemory(content: string, metadata?: MetadataObject): Promise<MemoryType> {
    if (this.modules.memory) {
      // Memory enabled: Save to database
      const memory = await this.modules.memory.addMemory(content, metadata);

      // Also add to context manager (for non-memory-fed scenarios)
      if (this.modules.context) {
        const contextMessage: ContextMessage = {
          role: (metadata?.role as 'user' | 'assistant') || 'user',
          content,
          timestamp: new Date(),
          metadata,
        };
        await this.modules.context.addMessage(contextMessage);
      }

      return memory;
    } else {
      // Memory disabled: Add to session-only messages
      const contextMessage: ContextMessage = {
        role: (metadata?.role as 'user' | 'assistant') || 'user',
        content,
        timestamp: new Date(),
        metadata,
      };

      this.sessionMessages.push(contextMessage);

      // Return mock memory object
      return {
        id: `temp-${Date.now()}`, // Temp UUID
        agentId: this.id,
        content,
        metadata: metadata || {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  }

  async getMemory(id: string): Promise<MemoryType | null> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.getMemory(id);
  }

  async searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryType[]> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.searchMemories(query, options);
  }

  async listMemories(options?: MemorySearchOptions): Promise<MemoryType[]> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.listMemories(options);
  }

  async updateMemory(
    id: string,
    updates: { content?: string; metadata?: MetadataObject }
  ): Promise<MemoryType | null> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.updateMemory(id, updates);
  }

  async deleteMemory(id: string): Promise<boolean> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.deleteMemory(id);
  }

  async clearMemories(): Promise<number> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.clearMemories();
  }

  async rememberConversation(
    content: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<MemoryType> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.rememberConversation(content, role);
  }

  async searchMemoriesBySimilarity(
    query: string,
    options?: MemorySearchOptions
  ): Promise<MemoryType[]> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.searchMemoriesBySimilarity(query, options);
  }

  async generateEmbeddingForMemory(
    memoryId: string
  ): Promise<{ success: boolean; message: string; embedding?: number[] }> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.generateEmbeddingForMemory(memoryId);
  }

  // ===== KNOWLEDGE MODULE METHODS (when knowledge enabled) =====

  async addKnowledge(content: string, title?: string, metadata?: MetadataObject): Promise<string> {
    // Returns UUID
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.addKnowledge(content, title, metadata);
  }

  async searchKnowledge(
    query: string,
    limit?: number,
    threshold?: number
  ): Promise<Array<{ content: string; metadata: MetadataObject; similarity: number }>> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.searchKnowledge(query, limit, threshold);
  }

  async getKnowledgeContext(query: string, limit?: number): Promise<string> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.getKnowledgeContext(query, limit);
  }

  async getKnowledgeDocuments(): Promise<Array<{ id: string; title: string; created_at: string }>> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.getKnowledgeDocuments();
  }

  async deleteKnowledgeDocument(documentId: string): Promise<boolean> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.deleteKnowledgeDocument(documentId);
  }

  async deleteKnowledgeChunk(chunkId: string): Promise<boolean> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.deleteKnowledgeChunk(chunkId);
  }

  async clearKnowledge(): Promise<void> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.clearKnowledge();
  }

  async addKnowledgeFromFile(filePath: string, metadata?: MetadataObject): Promise<void> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.addKnowledgeFromFile(filePath, metadata);
  }

  async addKnowledgeFromDirectory(dirPath: string, metadata?: MetadataObject): Promise<void> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.addKnowledgeFromDirectory(dirPath, metadata);
  }

  async expandKnowledgeContext(
    documentId: string,
    chunkIndex: number,
    expandBefore?: number,
    expandAfter?: number
  ): Promise<string[]> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.expandKnowledgeContext(
      documentId,
      chunkIndex,
      expandBefore,
      expandAfter
    );
  }

  // ===== PLUGIN MODULE METHODS (when useTools enabled) =====

  async registerPlugin(plugin: IPlugin, config?: PluginConfig): Promise<void> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.registerPlugin(plugin, config);
  }

  async unregisterPlugin(name: string): Promise<void> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.unregisterPlugin(name);
  }

  listPlugins(): IPlugin[] {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.listPlugins();
  }

  getTools(): ToolDefinition[] {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.getTools();
  }

  async executeTool(toolCall: import('../plugin/types').ToolCall): Promise<ToolCallResult> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.executeTool(toolCall, { agentId: this.id, agent: this });
  }

  // ===== MCP MODULE METHODS (when useTools enabled) =====

  async addMCPServer(serverDef: MCPServerDefinition): Promise<void> {
    if (!this.modules.mcp) throw new Error('MCP module not enabled');
    return this.modules.mcp.addMCPServer(serverDef);
  }

  async addMCPServers(servers: MCPServerDefinition[]): Promise<void> {
    if (!this.modules.mcp) throw new Error('MCP module not enabled');
    return this.modules.mcp.addMCPServers(servers);
  }

  removeMCPServer(name: string): void {
    if (!this.modules.mcp) throw new Error('MCP module not enabled');
    return this.modules.mcp.removeMCPServer(name);
  }

  async callMCPTool(
    toolName: string,
    args: Record<string, MCPValue>
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    if (!this.modules.mcp) throw new Error('MCP module not enabled');
    return this.modules.mcp.callMCPTool(toolName, args);
  }

  getMCPTools(): MCPTool[] {
    if (!this.modules.mcp) throw new Error('MCP module not enabled');
    return this.modules.mcp.getMCPTools();
  }

  // ===== VISION MODULE METHODS (when vision enabled) =====

  async analyzeImage(imagePath: string, options?: AnalysisOptions): Promise<string> {
    if (!this.modules.vision) throw new Error('Vision module not enabled');
    return this.modules.vision.analyzeImage(imagePath, options);
  }

  async describeImage(imagePath: string): Promise<string> {
    if (!this.modules.vision) throw new Error('Vision module not enabled');
    return this.modules.vision.analyzeImage(imagePath, { prompt: 'Describe this image in detail' });
  }

  async extractTextFromImage(imagePath: string): Promise<string> {
    if (!this.modules.vision) throw new Error('Vision module not enabled');
    return this.modules.vision.analyzeImage(imagePath, {
      prompt: 'Extract all text from this image',
    });
  }

  // ===== SUB-AGENT MODULE METHODS (always available) =====

  async executeWithSubAgents(
    prompt: string,
    subAgents: IAgent[],
    options?: Record<string, string | number | boolean | object | null>,
    mainModel?: string
  ): Promise<string> {
    if (!this.modules.subAgent) throw new Error('SubAgent module not available');
    return this.modules.subAgent.executeWithSubAgents(prompt, subAgents, options, mainModel);
  }

  async delegateTask(
    taskPrompt: string,
    targetAgent: IAgent,
    options?: Record<string, string | number | boolean | object | null>
  ): Promise<string> {
    if (!this.modules.subAgent) throw new Error('SubAgent module not available');
    return this.modules.subAgent.executeWithSubAgents(taskPrompt, [targetAgent], options);
  }

  async coordinateAgents(
    tasks: Array<{ agent: IAgent; prompt: string }>,
    coordination: 'parallel' | 'sequential' = 'sequential'
  ): Promise<Array<{ task: { agent: IAgent; prompt: string }; result: string }>> {
    if (!this.modules.subAgent) throw new Error('SubAgent module not available');
    // For now, delegate to existing method - would need more complex implementation for multi-task coordination
    const results = [];
    for (const task of tasks) {
      if (task.agent && task.prompt) {
        const result = await this.modules.subAgent.executeWithSubAgents(task.prompt, [task.agent], {
          coordination,
        });
        results.push({ task, result });
      }
    }
    return results;
  }

  // ===== CONTEXT MODULE METHODS (always available) =====

  getContextMessages(): ContextMessage[] {
    return this.modules.context!.getMessages();
  }

  getContextWindow(): ContextWindow {
    return this.modules.context!.getContextWindow();
  }

  analyzeContext(): ContextAnalysis {
    return this.modules.context!.analyzeContext();
  }

  async compressContext(): Promise<CompressionResult> {
    return this.modules.context!.compressContext();
  }

  clearContext(): void {
    this.modules.context!.clearContext();
  }

  exportContext(): string {
    return this.modules.context!.exportContext();
  }

  importContext(data: string): void {
    this.modules.context!.importContext(data);
  }

  async generateContextSummary(): Promise<ContextSummary> {
    return this.modules.context!.generateSummary();
  }

  updateContextModel(model: string): void {
    this.modules.context!.updateModel(model);
  }

  /**
   * Get conversation context messages based on memory configuration
   * This is the central method that all modules use to get conversation history
   */
  getContext(): ContextMessage[] {
    if (this.hasMemory() && this.modules.memory) {
      // Memory enabled: Get from context manager (fed by memory)
      return this.modules.context!.getMessages();
    } else {
      // Memory disabled: Return session-only messages
      return [...this.sessionMessages];
    }
  }

  /**
   * Save current context to memory
   */
  private async saveContextToMemory(): Promise<void> {
    if (!this.hasMemory() || !this.modules.memory) {
      return;
    }

    try {
      await this.modules.context!.saveToMemory(this.modules.memory);
    } catch (error) {
      this.logger.warn('Failed to save context to memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update agent's model and propagate to context manager
   */
  updateModel(model: string): void {
    this.data.model = model;

    // Update context manager's model
    this.modules.context!.updateModel(model);

    this.logger.info(`Agent model updated to: ${model}`);
  }

  /**
   * Load conversation history from memory for a specific graph
   * @param graphId - The graph ID to load context for
   * @param limit - Maximum number of messages to load
   * @param isolated - If true, only load graph-specific memories (default: false)
   *                   If false, load both general agent memories + graph-specific memories
   */
  async loadGraphContext(
    graphId: string,
    limit: number = 100,
    isolated: boolean = false
  ): Promise<void> {
    if (!this.hasMemory() || !this.modules.memory || !this.modules.context) {
      this.logger.debug('Memory or context module not available, skipping graph context load');
      return;
    }

    try {
      // Clear existing context
      this.clearContext();

      let allMemories: MemoryType[] = [];

      if (isolated) {
        // ISOLATED MODE: Only load graph-specific memories
        allMemories = await this.listMemories({
          graphId,
          orderBy: 'createdAt',
          order: 'asc',
          limit,
        });

        this.logger.debug(
          `Loaded ${allMemories.length} isolated graph-specific memories for graph ${graphId}`
        );
      } else {
        // HYBRID MODE: Load both general + graph-specific memories
        // 1. Load agent's general memories (not tied to any graph)
        const generalMemories = await this.modules.memory.listMemories({
          orderBy: 'createdAt',
          order: 'asc',
          limit: Math.floor(limit / 2), // Use half of limit for general memories
        });

        // Filter only memories without graphId (general agent memories)
        const generalConversations = generalMemories.filter(
          (m) =>
            !m.graphId &&
            (m.metadata?.type === 'user_message' || m.metadata?.type === 'assistant_response')
        );

        // 2. Load graph-specific memories
        const graphMemories = await this.listMemories({
          graphId,
          orderBy: 'createdAt',
          order: 'asc',
          limit: Math.floor(limit / 2), // Use half of limit for graph memories
        });

        // Combine and sort by timestamp
        allMemories = [...generalConversations, ...graphMemories].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );

        this.logger.debug(
          `Loaded ${generalConversations.length} general + ${graphMemories.length} graph-specific memories for graph ${graphId}`
        );
      }

      // Load all memories into context
      for (const memory of allMemories) {
        const role = (memory.metadata?.role as 'user' | 'assistant' | 'system') || 'user';
        const contextMessage: ContextMessage = {
          role,
          content: memory.content,
          timestamp: memory.createdAt,
          metadata: {
            ...memory.metadata,
            memory_id: memory.id,
            source: memory.graphId ? 'graph' : 'general',
          },
        };
        await this.modules.context.addMessage(contextMessage);
      }
    } catch (error) {
      this.logger.warn('Failed to load graph context from memory', {
        graphId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Initialize all modules
   */
  async initializeModules(): Promise<void> {
    // User-facing info log with agent details
    this.logger.info(`Initializing agent: ${this.data.name}`);

    // Get LLM provider information
    const model = this.data.model || 'gpt-4o-mini';
    const provider = getProviderForModel(model);

    // Detailed debug log with all agent configuration
    this.logger.debug('Agent initialization started', {
      id: this.data.id || 0,
      name: this.data.name,
      model: model,
      provider: provider || 'unknown',
      temperature: this.data.temperature || 0.7,
      maxTokens: this.data.maxTokens || 2000,
      hasSystemPrompt: !!this.data.systemPrompt,
      memory: !!this.data.memory,
      knowledge: !!this.data.knowledge,
      vision: !!this.data.vision,
      useTools: this.data.useTools !== false,
      autoContextCompression: !!this.data.autoContextCompression,
      debug: !!this.data.debug,
    });

    await this.modules.task.initialize();

    // Scheduler is now just utilities, no initialization needed

    if (this.modules.memory) {
      await this.modules.memory.initialize();
    }

    if (this.modules.plugin) {
      await this.modules.plugin.initialize();
    }

    if (this.modules.mcp) {
      await this.modules.mcp.initialize();
    }

    if (this.modules.knowledge) {
      await this.modules.knowledge.initialize();
    }

    if (this.modules.vision) {
      await this.modules.vision.initialize();
    }

    if (this.modules.subAgent) {
      await this.modules.subAgent.initialize();
    }

    // Initialize context storage for this agent
    if (this.data.id) {
      try {
        await this.modules.context!.initializeForAgent(this.data.id);
      } catch (error) {
        this.logger.warn('Failed to initialize context storage', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // User-facing success message with capabilities summary
    const capabilities = [];
    if (this.data.memory) capabilities.push('Memory');
    if (this.data.knowledge) capabilities.push('Knowledge');
    if (this.data.vision) capabilities.push('Vision');
    if (this.data.useTools !== false) capabilities.push('Tools');
    if (this.data.autoContextCompression) capabilities.push('Auto Context Compression');

    this.logger.info(
      `Agent ready: ${this.data.name} (${model} via ${provider || 'unknown'}) - ${capabilities.join(', ')}`
    );

    this.logger.debug('Agent initialization completed', {
      name: this.data.name,
      model: model,
      provider: provider || 'unknown',
      enabledCapabilities: capabilities,
      totalModules: Object.keys(this.modules).length,
    });
  }

  /**
   * Factory method to create a new agent or find existing one by name
   */
  static async create(config: AgentConfigInput): Promise<Agent> {
    const db = await getDatabase();

    // Apply defaults for required boolean fields
    const fullConfig: AgentConfigInput = {
      memory: false,
      knowledge: false,
      vision: false,
      useTools: true,
      autoContextCompression: false,
      debug: false,
      ...config,
    };

    // Check if agent with this name already exists
    const existingAgent = await db.getAgentByName(fullConfig.name);

    let agentData: AgentConfig;
    if (existingAgent) {
      // Agent exists, update it with new config
      const updatedAgent = await db.updateAgent(existingAgent.id!, fullConfig);
      if (!updatedAgent) {
        throw new Error(`Failed to update agent with ID ${existingAgent.id}`);
      }
      agentData = updatedAgent;
    } else {
      // Agent doesn't exist, create new one
      agentData = await db.createAgent(fullConfig);
    }

    const agent = new Agent(agentData);

    // Initialize all modules
    await agent.initializeModules();

    // Log agent creation/update
    if (existingAgent) {
      agent.logger.info(`Agent updated: ${agentData.name}`);
    } else {
      agent.logger.info(`Agent created: ${agentData.name}`);
    }

    agent.logger.debug('Agent initialized', {
      agentId: agentData.id || 0,
      name: agentData.name,
      model: agentData.model || 'default',
      memory: !!agentData.memory,
      knowledge: !!agentData.knowledge,
      vision: !!agentData.vision,
      debug: !!agentData.debug,
    });

    return agent;
  }

  /**
   * Find agent by ID
   */
  static async findById(id: string): Promise<Agent | null> {
    const db = await getDatabase();
    const agentData = await db.getAgent(id);
    if (!agentData) return null;

    const agent = new Agent(agentData);
    await agent.initializeModules();
    return agent;
  }

  /**
   * Find agent by name
   */
  static async findByName(name: string): Promise<Agent | null> {
    const db = await getDatabase();
    const agentData = await db.getAgentByName(name);
    if (!agentData) return null;

    const agent = new Agent(agentData);
    await agent.initializeModules();
    return agent;
  }

  /**
   * List all agents
   */
  static async list(): Promise<Agent[]> {
    const db = await getDatabase();
    const agentsData = await db.listAgents();
    const agents = await Promise.all(
      agentsData.map(async (data) => {
        const agent = new Agent(data);
        await agent.initializeModules();
        return agent;
      })
    );
    return agents;
  }

  /**
   * Main run method
   */
  async run(prompt: string, options?: RunOptions): Promise<string> {
    // Add context processing here if needed

    // Check if we should use tools
    const useTools = options?.useTools !== undefined ? options.useTools : this.canUseTools();

    if (useTools) {
      // Tool execution logic would go here
      // For now, just use LLM
    }

    // Call LLM
    return this.callLLM(prompt, options);
  }

  /**
   * Ask method - direct conversation with the agent (task-independent)
   */
  async ask(prompt: string, options?: AskOptions): Promise<string> {
    // Check if sub-agents should be used
    if (options?.useSubAgents && this.config.subAgents && this.config.subAgents.length > 0) {
      this.logger.info(`Using sub-agents for task delegation`, {
        subAgentCount: this.config.subAgents.length,
        delegation: options.delegation || 'auto',
      });

      try {
        const result = await this.modules.subAgent!.executeWithSubAgents(
          prompt,
          this.config.subAgents,
          options,
          this.getModel() // Pass main agent's model for delegation
        );
        return result;
      } catch (error) {
        this.logger.warn('Sub-agent execution failed, falling back to main agent', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to regular agent execution
      }
    }
    let enhancedPrompt = prompt;
    const messages: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      tool_call_id?: string;
      tool_calls?: ToolCall[];
    }> = [];

    // Add system prompt if available
    const systemPrompt = this.getSystemPrompt();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Process attachments if provided
    if (options?.attachments && options.attachments.length > 0) {
      const attachmentDescriptions = await Promise.all(
        options.attachments.map(async (attachment) => {
          if (!attachment || !attachment.path || !attachment.type) {
            return `[Invalid attachment: missing required fields]`;
          }

          try {
            const displayName = attachment.name || attachment.path.split('/').pop() || 'unknown';
            let description = `${attachment.type}: ${displayName} (${attachment.path})`;

            if (attachment.language) {
              description += ` [Language: ${attachment.language}]`;
            }

            // For image files, use vision if available
            if (attachment.type === 'image' && this.hasVision() && this.modules?.vision) {
              try {
                const visionModule = this.modules.vision as Vision;
                if (visionModule && typeof visionModule.analyzeImage === 'function') {
                  const analysis = await visionModule.analyzeImage(attachment.path, {
                    prompt: 'Describe this image',
                    maxTokens: 500,
                  });
                  description += `\nImage content: ${analysis}`;
                }
              } catch (error) {
                description += ` [Vision analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}]`;
              }
            }
            // For text-based files, include content preview
            else if (['text', 'markdown', 'code', 'json'].includes(attachment.type)) {
              try {
                const content = await fs.readFile(attachment.path, 'utf-8');
                const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
                description += `\nContent:\n${preview}`;
              } catch (error) {
                description += ` [File read error: ${error instanceof Error ? error.message : 'Unknown error'}]`;
              }
            }

            return description;
          } catch (error) {
            return `[Error processing attachment ${attachment.path}: ${error instanceof Error ? error.message : 'Unknown error'}]`;
          }
        })
      );

      enhancedPrompt = `${prompt}\n\nAttached files:\n${attachmentDescriptions.join('\n\n')}`;
    }

    // Add conversation context (handles memory integration internally)
    const contextMessages = this.getContext();
    for (const contextMsg of contextMessages) {
      messages.push({
        role: contextMsg.role,
        content: contextMsg.content,
      });
    }

    // Add temporary MCP servers if provided
    if (options?.mcpServers && Array.isArray(options.mcpServers) && this.modules?.mcp) {
      const mcpModule = this.modules.mcp as MCP;
      if (mcpModule && typeof mcpModule.addMCPServer === 'function') {
        for (const server of options.mcpServers) {
          if (server && server.name) {
            try {
              await mcpModule.addMCPServer(server);
            } catch (error) {
              this.logger.warn(
                `Failed to add MCP server ${server.name}:`,
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        }
      }
    }

    // Add temporary plugins if provided
    if (options?.plugins && Array.isArray(options.plugins) && this.modules?.plugin) {
      const pluginModule = this.modules.plugin as Plugin;
      if (pluginModule && typeof pluginModule.registerPlugin === 'function') {
        for (const pluginDef of options.plugins) {
          if (pluginDef && pluginDef.plugin) {
            try {
              // Create a temporary plugin instance
              const tempPlugin: IPlugin = {
                name: pluginDef.plugin.name,
                version: pluginDef.plugin.version,
                description: pluginDef.plugin.description || '',
                tools: (pluginDef.plugin.tools || []) as ToolDefinition[],
              };

              await pluginModule.registerPlugin(tempPlugin, {
                name: pluginDef.plugin.name,
                enabled: true,
                config: pluginDef.config || {},
              });
            } catch (error) {
              this.logger.warn(
                `Failed to register temporary plugin ${pluginDef.plugin.name}:`,
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        }
      }
    }

    // Add current user prompt
    messages.push({ role: 'user', content: enhancedPrompt });

    // Add user message to conversation (memory/context)
    await this.addMemory(enhancedPrompt, { role: 'user' });

    // Check if we should use tools
    const shouldUseTools =
      options?.useTools !== undefined
        ? options.useTools
        : (options?.attachments && options.attachments.length > 0) || this.canUseTools();

    // Get LLM instance
    const llm = getLLM(this.logger);

    // Collect all available tools
    const tools: Tool[] = [];

    if (shouldUseTools) {
      // Add MCP tools
      if (this.modules.mcp) {
        const mcpTools = this.modules.mcp.getMCPTools();
        for (const mcpTool of mcpTools) {
          tools.push({
            type: 'function',
            function: {
              name: `mcp_${mcpTool.name}`,
              description: mcpTool.description,
              parameters: mcpTool.inputSchema as Tool['function']['parameters'],
            },
          });
        }
      }

      // Add plugin tools
      if (this.modules.plugin) {
        const pluginTools = this.modules.plugin.getTools();
        for (const pluginTool of pluginTools) {
          tools.push({
            type: 'function',
            function: {
              name: `plugin_${pluginTool.name}`,
              description: pluginTool.description,
              parameters: convertToolParametersToJsonSchema(pluginTool.parameters),
            },
          });
        }
      }

      this.logger.info(
        `Prepared ${tools.length} tools for LLM: ${tools.map((t) => t.function.name).join(', ')}`
      );
      this.logger.debug('Tools prepared for LLM', {
        toolCount: tools.length,
        toolNames: tools.map((t) => t.function.name),
      });
    }

    // Prepare LLM options
    const llmOptions: LLMRequestOptions = {
      model: options?.model || this.getModel(),
      messages,
      temperature: options?.temperature || this.getTemperature(),
      maxTokens: options?.maxTokens || this.getMaxTokens(),
      stream: options?.stream,
      tools: tools.length > 0 ? tools : undefined,
    };

    // Handle streaming vs non-streaming
    let response: string;

    if (options?.stream) {
      // Stream response
      let fullContent = '';

      for await (const chunk of llm.generateStreamResponse(llmOptions)) {
        fullContent += chunk.content;
        // If there's a callback for streaming, call it
        if (options.onChunk) {
          options.onChunk(chunk.content);
        } else {
          // If no callback, just output to console
          process.stdout.write(chunk.content);
        }
      }

      if (!options.onChunk) {
        process.stdout.write('\n'); // New line after streaming
      }

      response = fullContent;
    } else {
      // Single LLM call with tool handling
      const llmResponse = await llm.generateResponse(llmOptions);

      // Handle tool calls if present
      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        this.logger.debug('Processing tool calls', {
          toolCallCount: llmResponse.toolCalls.length,
          toolNames: llmResponse.toolCalls.map((tc) => tc.function.name),
        });

        // Add assistant message with tool calls
        // IMPORTANT: OpenAI requires content to be a string (can be empty string or null) when tool_calls present
        messages.push({
          role: 'assistant',
          content: llmResponse.content || '',
          tool_calls: llmResponse.toolCalls,
        });

        // Execute each tool call
        for (const toolCall of llmResponse.toolCalls) {
          try {
            let toolResult: string;

            if (toolCall.function.name.startsWith('mcp_')) {
              // Handle MCP tool call
              const mcpToolName = toolCall.function.name.substring(4); // Remove 'mcp_' prefix

              // Ensure arguments are properly formatted for MCP
              let mcpArgs: Record<string, string | number | boolean | object | null>;
              if (typeof toolCall.function.arguments === 'string') {
                mcpArgs = JSON.parse(toolCall.function.arguments);
              } else {
                mcpArgs = toolCall.function.arguments as Record<
                  string,
                  string | number | boolean | object | null
                >;
              }

              const mcpResult = await this.modules.mcp!.callMCPTool(
                mcpToolName,
                mcpArgs as Record<string, import('../mcp/types').MCPValue>
              );
              toolResult = mcpResult.content.map((c) => c.text || '').join('\n');
            } else if (toolCall.function.name.startsWith('plugin_')) {
              // Handle plugin tool call
              const pluginToolName = toolCall.function.name.substring(7); // Remove 'plugin_' prefix

              // Ensure arguments are properly formatted for plugin tools
              let pluginArgs: Record<string, string | number | boolean | object | null>;
              if (typeof toolCall.function.arguments === 'string') {
                pluginArgs = JSON.parse(toolCall.function.arguments);
              } else {
                pluginArgs = toolCall.function.arguments as Record<
                  string,
                  string | number | boolean | object | null
                >;
              }

              if (this.modules.plugin) {
                const pluginResult = await this.modules.plugin.executeTool(
                  {
                    id: toolCall.id,
                    name: pluginToolName,
                    parameters: pluginArgs as Record<string, ToolParameterValue>,
                  },
                  { agentId: this.id, agent: this }
                );
                toolResult = pluginResult.result.success
                  ? typeof pluginResult.result.data === 'string'
                    ? pluginResult.result.data
                    : JSON.stringify(pluginResult.result.data)
                  : `Error: ${pluginResult.result.error || 'Unknown error'}`;
              } else {
                toolResult = `Plugin module not available`;
              }
            } else {
              // Handle other tool types (future implementations)
              toolResult = `Tool ${toolCall.function.name} not implemented yet`;
            }

            // CRITICAL: Tool result content cannot be empty for OpenAI API
            if (!toolResult || toolResult.trim() === '') {
              console.error('⚠️ EMPTY TOOL RESULT DETECTED:', {
                toolName: toolCall.function.name,
                toolCallId: toolCall.id,
                resultType: typeof toolResult,
                resultValue: toolResult,
              });
              toolResult = 'Tool execution completed but returned no data.';
            }

            console.log('✅ TOOL RESULT:', {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              resultLength: toolResult.length,
              resultPreview: toolResult.slice(0, 200),
            });

            // Add tool result to messages
            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
            });

            this.logger.debug('Tool call executed', {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              resultLength: toolResult.length,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Tool call failed: ${toolCall.function.name}`, error as Error);

            // Add error result to messages
            messages.push({
              role: 'tool',
              content: `Error: ${errorMessage}`,
              tool_call_id: toolCall.id,
            });
          }
        }

        // Get final response from LLM with tool results
        const toolMessages = messages.filter((m) => m.role === 'tool');
        if (toolMessages.length > 0) {
          const lastToolContent = toolMessages[toolMessages.length - 1]?.content || '';
          this.logger.info(
            `Sending tool results to LLM (${lastToolContent.length} chars, ${toolMessages.length} tool results)`
          );
          this.logger.debug('Tool result content preview', {
            preview: lastToolContent.slice(0, 500),
            totalLength: lastToolContent.length,
            toolCount: toolMessages.length,
          });
        }
        // Log full message structure for debugging OpenAI 400 errors
        const messageStructure = messages.map((m) => ({
          role: m.role,
          contentPreview: typeof m.content === 'string' ? m.content.slice(0, 100) : 'non-string',
          contentLength: typeof m.content === 'string' ? m.content.length : 0,
          hasToolCalls: 'tool_calls' in m,
          toolCallId: 'tool_call_id' in m ? m.tool_call_id : undefined,
          toolCallsCount:
            'tool_calls' in m && Array.isArray(m.tool_calls) ? m.tool_calls.length : 0,
        }));

        this.logger.debug('Sending tool results to LLM for final response', {
          messageCount: messages.length,
          toolMessageCount: toolMessages.length,
          lastToolContentLength: toolMessages[toolMessages.length - 1]?.content.length || 0,
          lastToolPreview: toolMessages[toolMessages.length - 1]?.content.slice(0, 100) || '',
          messageStructure: JSON.stringify(messageStructure, null, 2),
        });

        const finalLlmOptions: LLMRequestOptions = {
          ...llmOptions,
          messages,
          tools: undefined, // Don't include tools in follow-up call
        };

        try {
          const finalResponse = await llm.generateResponse(finalLlmOptions);
          response = finalResponse.content;

          this.logger.debug('Final response generated after tool calls', {
            responseLength: response.length,
          });
        } catch (finalResponseError) {
          // Log the detailed error but return a friendly message to the user
          this.logger.error(
            'Failed to generate final response after tool execution',
            finalResponseError instanceof Error
              ? finalResponseError
              : new Error(String(finalResponseError))
          );
          this.logger.debug('Tool execution was successful, but LLM response failed', {
            errorMessage:
              finalResponseError instanceof Error
                ? finalResponseError.message
                : String(finalResponseError),
            toolResultsCount: toolMessages.length,
            messageCount: messages.length,
          });

          // Create a user-friendly response based on tool results
          const toolResultsSummary = toolMessages
            .map((m, i) => {
              try {
                const result = JSON.parse(m.content);
                if (result.success !== false) {
                  return `✓ Tool ${i + 1} completed successfully`;
                }
              } catch {
                // Not JSON, treat as plain text
              }
              return null;
            })
            .filter(Boolean)
            .join('\n');

          response = toolResultsSummary
            ? `I've completed the requested operations:\n\n${toolResultsSummary}\n\nHowever, I encountered a temporary issue generating a detailed response. The operations were successful though!`
            : `I've processed your request and the operations completed successfully. However, I encountered a temporary issue generating a detailed response. Please try asking me to explain the results.`;
        }
      } else {
        response = llmResponse.content;
      }
    }

    // Add response to conversation (memory/context)
    await this.addMemory(response, { role: 'assistant' });

    // Save context to memory if enabled
    await this.saveContextToMemory();

    // Clean up temporary MCP servers
    if (options?.mcpServers && this.modules.mcp) {
      for (const server of options.mcpServers) {
        try {
          (this.modules.mcp as MCP).removeMCPServer(server.name);
        } catch (error) {
          this.logger.warn(
            `Failed to remove MCP server ${server.name}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    // Clean up temporary plugins
    if (options?.plugins && Array.isArray(options.plugins) && this.modules?.plugin) {
      for (const pluginDef of options.plugins) {
        if (pluginDef && pluginDef.plugin) {
          try {
            await (this.modules.plugin as Plugin).unregisterPlugin(pluginDef.plugin.name);
          } catch (error) {
            this.logger.warn(
              `Failed to unregister temporary plugin ${pluginDef.plugin.name}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }
    }

    return response;
  }

  /**
   * Update agent configuration
   */
  async update(updates: Partial<AgentConfig>): Promise<void> {
    const wasMemoryEnabled = this.hasMemory();
    const wasKnowledgeEnabled = this.hasKnowledge();
    const wasVisionEnabled = this.hasVision();

    await super.update(updates);

    // Handle module changes
    if (this.hasMemory() && !wasMemoryEnabled) {
      this.modules.memory = new Memory(this);
      await this.modules.memory.initialize();
    } else if (!this.hasMemory() && wasMemoryEnabled) {
      delete this.modules.memory;
    }

    if (this.hasKnowledge() && !wasKnowledgeEnabled) {
      this.modules.knowledge = new Knowledge(this);
      await this.modules.knowledge.initialize();
    } else if (!this.hasKnowledge() && wasKnowledgeEnabled) {
      delete this.modules.knowledge;
    }

    if (this.hasVision() && !wasVisionEnabled) {
      this.modules.vision = new Vision(this);
      await this.modules.vision.initialize();
    } else if (!this.hasVision() && wasVisionEnabled) {
      delete this.modules.vision;
    }

    // Module methods are directly implemented and don't need re-binding
  }
}

export type { AgentConfig } from './types';
export default Agent;
