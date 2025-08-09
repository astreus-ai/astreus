import { AgentConfig, IAgent, IAgentWithModules, RunOptions, AskOptions } from './types';
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
  ToolCall as PluginToolCall,
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

  // Getters for IAgent interface
  get id(): number {
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
  getId(): number {
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

    // Module methods are now directly implemented in the class
  }

  // ===== TASK MODULE METHODS (always available) =====

  async createTask(request: TaskRequest): Promise<TaskType> {
    return this.modules.task.createTask(request);
  }

  async getTask(id: number): Promise<TaskType | null> {
    return this.modules.task.getTask(id);
  }

  async listTasks(options?: TaskSearchOptions): Promise<TaskType[]> {
    return this.modules.task.listTasks(options);
  }

  async updateTask(id: number, updates: Partial<TaskType>): Promise<TaskType | null> {
    return this.modules.task.updateTask(id, updates);
  }

  async deleteTask(id: number): Promise<boolean> {
    return this.modules.task.deleteTask(id);
  }

  async clearTasks(): Promise<number> {
    return this.modules.task.clearTasks();
  }

  async executeTask(
    taskId: number,
    options?: { model?: string; stream?: boolean }
  ): Promise<TaskResponse> {
    return this.modules.task.executeTask(taskId, options);
  }

  // ===== MEMORY MODULE METHODS (when memory enabled) =====

  async addMemory(content: string, metadata?: MetadataObject): Promise<MemoryType> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.addMemory(content, metadata);
  }

  async getMemory(id: number): Promise<MemoryType | null> {
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
    id: number,
    updates: { content?: string; metadata?: MetadataObject }
  ): Promise<MemoryType | null> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.updateMemory(id, updates);
  }

  async deleteMemory(id: number): Promise<boolean> {
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
    memoryId: number
  ): Promise<{ success: boolean; message: string; embedding?: number[] }> {
    if (!this.modules.memory) throw new Error('Memory module not enabled');
    return this.modules.memory.generateEmbeddingForMemory(memoryId);
  }

  // ===== KNOWLEDGE MODULE METHODS (when knowledge enabled) =====

  async addKnowledge(content: string, title?: string, metadata?: MetadataObject): Promise<number> {
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

  async getKnowledgeDocuments(): Promise<
    Array<{ id: number; title: string; file_path: string; created_at: string }>
  > {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.getKnowledgeDocuments();
  }

  async deleteKnowledgeDocument(documentId: number): Promise<boolean> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    return this.modules.knowledge.deleteKnowledgeDocument(documentId);
  }

  async deleteKnowledgeChunk(chunkId: number): Promise<boolean> {
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

  // ===== PLUGIN MODULE METHODS (when useTools enabled) =====

  async registerPlugin(plugin: IPlugin, config?: PluginConfig): Promise<void> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.registerPlugin(plugin, config);
  }

  async unregisterPlugin(name: string): Promise<void> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.unregisterPlugin(name);
  }

  getPlugins(): IPlugin[] {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.listPlugins();
  }

  getTools(): ToolDefinition[] {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.getTools();
  }

  async executeTool(toolCall: PluginToolCall): Promise<ToolCallResult> {
    if (!this.modules.plugin) throw new Error('Plugin module not enabled');
    return this.modules.plugin.executeTool(toolCall);
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
    options?: Record<string, unknown>,
    mainModel?: string
  ): Promise<string> {
    if (!this.modules.subAgent) throw new Error('SubAgent module not available');
    return this.modules.subAgent.executeWithSubAgents(prompt, subAgents, options, mainModel);
  }

  async delegateTask(
    taskPrompt: string,
    targetAgent: IAgent,
    options?: Record<string, unknown>
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
      contextCompression: !!this.data.contextCompression,
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

    // Methods are now directly implemented in the class

    // User-facing success message with capabilities summary
    const capabilities = [];
    if (this.data.memory) capabilities.push('Memory');
    if (this.data.knowledge) capabilities.push('Knowledge');
    if (this.data.vision) capabilities.push('Vision');
    if (this.data.useTools !== false) capabilities.push('Tools');
    if (this.data.contextCompression) capabilities.push('Context Compression');

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
  static async create(config: AgentConfig): Promise<Agent> {
    const db = await getDatabase();

    // Ensure all optional fields have defaults to prevent undefined behavior
    const fullConfig: AgentConfig = {
      memory: false,
      knowledge: false,
      vision: false,
      useTools: true,
      contextCompression: false,
      debug: false,
      ...config, // Override with provided config
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
  static async findById(id: number): Promise<Agent | null> {
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

    // Add memory context if available
    if (this.hasMemory() && this.modules?.memory) {
      try {
        const memoryModule = this.modules.memory as Memory;
        if (memoryModule && typeof memoryModule.listMemories === 'function') {
          const recentMemories = await memoryModule.listMemories({
            limit: 10,
            orderBy: 'createdAt',
            order: 'asc',
          });

          // Add memories as conversation history
          if (Array.isArray(recentMemories)) {
            for (const mem of recentMemories) {
              if (mem && typeof mem === 'object') {
                const memTyped = mem as MemoryType;
                if (memTyped.content && memTyped.metadata?.type === 'user_message') {
                  messages.push({ role: 'user', content: memTyped.content });
                } else if (memTyped.content && memTyped.metadata?.type === 'assistant_response') {
                  messages.push({ role: 'assistant', content: memTyped.content });
                }
              }
            }
          }
        }
      } catch (error) {
        this.logger.warn(
          'Failed to load memories:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Add knowledge context if query seems to need it
    if (this.hasKnowledge() && this.modules?.knowledge) {
      try {
        const knowledgeModule = this.modules.knowledge as Knowledge;
        if (knowledgeModule && typeof knowledgeModule.searchKnowledge === 'function') {
          const relevantKnowledge = await knowledgeModule.searchKnowledge(prompt, 3, 0.7);
          if (Array.isArray(relevantKnowledge) && relevantKnowledge.length > 0) {
            const knowledgeContext = relevantKnowledge
              .filter((k) => k && k.content)
              .map((k) => k.content)
              .join('\n\n---\n\n');
            if (knowledgeContext.trim()) {
              enhancedPrompt = `Relevant context from knowledge base:\n${knowledgeContext}\n\nUser question: ${enhancedPrompt}`;
            }
          }
        }
      } catch (error) {
        this.logger.warn(
          'Failed to search knowledge:',
          error instanceof Error ? error.message : String(error)
        );
      }
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

    // Add current prompt
    messages.push({ role: 'user', content: enhancedPrompt });

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
              let mcpArgs: Record<string, unknown>;
              if (typeof toolCall.function.arguments === 'string') {
                mcpArgs = JSON.parse(toolCall.function.arguments);
              } else {
                mcpArgs = toolCall.function.arguments as Record<string, unknown>;
              }

              const mcpResult = await this.modules.mcp!.callMCPTool(
                mcpToolName,
                mcpArgs as Record<string, import('../mcp/types').MCPValue>
              );
              toolResult = mcpResult.content.map((c) => c.text || '').join('\n');
            } else if (toolCall.function.name.startsWith('plugin_')) {
              // Handle plugin tool call
              const pluginToolName = toolCall.function.name.substring(8); // Remove 'plugin_' prefix

              // Ensure arguments are properly formatted for plugin tools
              let pluginArgs: Record<string, unknown>;
              if (typeof toolCall.function.arguments === 'string') {
                pluginArgs = JSON.parse(toolCall.function.arguments);
              } else {
                pluginArgs = toolCall.function.arguments as Record<string, unknown>;
              }

              if (this.modules.plugin) {
                const pluginResult = await this.modules.plugin.executeTool({
                  id: toolCall.id,
                  name: pluginToolName,
                  parameters: pluginArgs as Record<string, ToolParameterValue>,
                });
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
        const finalLlmOptions: LLMRequestOptions = {
          ...llmOptions,
          messages,
          tools: undefined, // Don't include tools in follow-up call
        };

        const finalResponse = await llm.generateResponse(finalLlmOptions);
        response = finalResponse.content;

        this.logger.debug('Final response generated after tool calls', {
          responseLength: response.length,
        });
      } else {
        response = llmResponse.content;
      }
    }

    // Store in memory if enabled
    if (this.hasMemory() && this.modules.memory) {
      try {
        await (this.modules.memory as Memory).addMemory(prompt, {
          type: 'user_message',
          attachments: options?.attachments ? options.attachments.length : 0,
        });

        await (this.modules.memory as Memory).addMemory(response, {
          type: 'assistant_response',
          model: options?.model || this.getModel(),
        });
      } catch (error) {
        this.logger.warn(
          'Failed to store memory:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

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
