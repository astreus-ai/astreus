import { AgentConfig, IAgent, RunOptions } from './types';
import { ToolDefinition } from '../plugin/types';

// Interface for dynamic method binding - use intersection types
type DynamicModule = Record<string, (...args: never[]) => unknown>;
import { Task } from '../task';
import { Memory } from '../memory';
import { Memory as MemoryType } from '../memory/types';
import { Graph } from '../graph';
import { Plugin } from '../plugin';
import { MCP } from '../mcp';
import { Knowledge } from '../knowledge';
import { Vision } from '../vision';
import { getDatabase } from '../database';
import { getProviderForModel } from '../llm/models';
import { getLLM } from '../llm';
import { LLMRequestOptions } from '../llm/types';
import { Logger } from '../logger';

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
      agentName: data.name
    });
  }

  /**
   * Abstract method that must be implemented by concrete agent classes
   */
  abstract run(prompt: string, options?: RunOptions): Promise<string>;

  // Getters for IAgent interface
  get id(): number {
    return this.data.id!;
  }

  get name(): string {
    return this.data.name;
  }

  get config(): AgentConfig {
    return this.data;
  }

  // Feature checks
  canUseTools(): boolean {
    return this.data.useTools !== false;
  }

  hasMemory(): boolean {
    return this.data.memory === true;
  }

  hasKnowledge(): boolean {
    return this.data.knowledge === true;
  }

  hasVision(): boolean {
    return this.data.vision === true;
  }


  // Instance methods
  async update(updates: Partial<AgentConfig>): Promise<void> {
    const db = await getDatabase();
    const updatedData = await db.updateAgent(this.data.id!, updates);
    if (updatedData) {
      this.data = updatedData;
      
      // Update logger debug mode if changed
      if (updates.debug !== undefined) {
        const debugMode = updates.debug === true;
        this.logger = new Logger({
          level: debugMode ? 'debug' : 'info',
          debug: debugMode,
          enableConsole: true,
          enableFile: false,
          agentName: this.data.name
        });
      }
    }
  }

  async delete(): Promise<boolean> {
    const db = await getDatabase();
    return db.deleteAgent(this.data.id!);
  }

  // Utility methods from original
  getId(): number {
    return this.data.id!;
  }

  getName(): string {
    return this.data.name;
  }

  getDescription(): string | null {
    return this.data.description || null;
  }

  getModel(): string {
    return this.data.model || 'gpt-4';
  }

  getTemperature(): number {
    return this.data.temperature || 0.7;
  }

  getMaxTokens(): number {
    return this.data.maxTokens || 2000;
  }

  getSystemPrompt(): string | null {
    return this.data.systemPrompt || null;
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
      stream: options?.stream
    });

    return response.content;
  }
}

/**
 * Main Agent class with module system
 */
export class Agent extends BaseAgent {
  // Allow dynamic method binding from modules
  [key: string]: unknown;

  private modules: {
    task: Task;
    memory?: Memory;
    graph?: Graph;
    plugin?: Plugin;
    mcp?: MCP;
    knowledge?: Knowledge;
    vision?: Vision;
  };

  constructor(data: AgentConfig) {
    super(data);
    
    // Initialize modules
    this.modules = {
      task: new Task(this)
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
    
    // Auto-bind module methods to agent instance
    this.bindModuleMethods();
  }

  /**
   * Bind module methods directly to agent instance for clean API
   */
  private bindModuleMethods(): void {
    // Task methods (always available)
    this.bindAllMethods(this.modules.task);
    
    // Conditional bindings
    if (this.modules.memory) {
      this.bindAllMethods(this.modules.memory);
    }
    
    if (this.modules.plugin) {
      this.bindAllMethods(this.modules.plugin);
    }
    
    if (this.modules.mcp) {
      this.bindAllMethods(this.modules.mcp);
    }
    
    
    if (this.modules.knowledge) {
      this.bindAllMethods(this.modules.knowledge);
    }
    
    if (this.modules.vision) {
      this.bindAllMethods(this.modules.vision);
    }
  }

  /**
   * Automatically bind all public methods from a module to the agent instance
   */
  private bindAllMethods(module: object): void {
    const prototype = Object.getPrototypeOf(module);
    const methodNames = Object.getOwnPropertyNames(prototype)
      .filter(name => name !== 'constructor' && name !== 'name' && name !== 'initialize')
      .filter(name => typeof (module as DynamicModule)[name] === 'function')
      .filter(name => !name.startsWith('_')); // Skip private methods
      
    methodNames.forEach(methodName => {
      // Dynamically bind module methods to agent instance
      this[methodName] = (module as DynamicModule)[methodName].bind(module);
    });
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
      debug: !!this.data.debug
    });
    
    await this.modules.task.initialize();
    
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
    
    // Re-bind methods after initialization
    this.bindModuleMethods();
    
    // User-facing success message with capabilities summary
    const capabilities = [];
    if (this.data.memory) capabilities.push('Memory');
    if (this.data.knowledge) capabilities.push('Knowledge');
    if (this.data.vision) capabilities.push('Vision');
    if (this.data.useTools !== false) capabilities.push('Tools');
    if (this.data.contextCompression) capabilities.push('Context Compression');
    
    this.logger.info(`Agent ready: ${this.data.name} (${model} via ${provider || 'unknown'}) - ${capabilities.join(', ')}`);
    
    this.logger.debug('Agent initialization completed', {
      name: this.data.name,
      model: model,
      provider: provider || 'unknown',
      enabledCapabilities: capabilities,
      totalModules: Object.keys(this.modules).length
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
      ...config // Override with provided config
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
      debug: !!agentData.debug
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
  async ask(prompt: string, options?: RunOptions & {
    attachments?: Array<{
      type: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'json' | 'file';
      path: string;
      name?: string;
      language?: string;
    }>;
    mcpServers?: Array<{
      name: string;
      command?: string;
      args?: string[];
      url?: string;
      cwd?: string;
    }>;
    plugins?: Array<{
      plugin: {
        name: string;
        version: string;
        description?: string;
        tools?: ToolDefinition[];
      };
      config?: Record<string, string | number | boolean | null>;
    }>;
  }): Promise<string> {
    let enhancedPrompt = prompt;
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    
    // Add system prompt if available
    if (this.getSystemPrompt()) {
      messages.push({ role: 'system', content: this.getSystemPrompt()! });
    }
    
    // Process attachments if provided
    if (options?.attachments && options.attachments.length > 0) {
      const attachmentDescriptions = await Promise.all(
        options.attachments.map(async (attachment) => {
          const displayName = attachment.name || attachment.path.split('/').pop();
          let description = `${attachment.type}: ${displayName} (${attachment.path})`;
          
          if (attachment.language) {
            description += ` [Language: ${attachment.language}]`;
          }
          
          // For image files, use vision if available
          if (attachment.type === 'image' && this.hasVision() && this.modules.vision) {
            try {
              const analysis = await (this.modules.vision as Vision).analyzeImage(attachment.path, {
                prompt: 'Describe this image',
                maxTokens: 500
              });
              description += `\nImage content: ${analysis}`;
            } catch (error) {
              description += ` [Vision analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}]`;
            }
          }
          // For text-based files, include content preview
          else if (['text', 'markdown', 'code', 'json'].includes(attachment.type)) {
            try {
              const fs = await import('fs/promises');
              const content = await fs.readFile(attachment.path, 'utf-8');
              const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
              description += `\nContent:\n${preview}`;
            } catch (error) {
              description += ` [File read error: ${error instanceof Error ? error.message : 'Unknown error'}]`;
            }
          }
          
          return description;
        })
      );
      
      enhancedPrompt = `${prompt}\n\nAttached files:\n${attachmentDescriptions.join('\n\n')}`;
    }
    

    // Add memory context if available
    if (this.hasMemory() && this.modules.memory) {
      try {
        const recentMemories = await (this.modules.memory as Memory).listMemories({
          limit: 10,
          orderBy: 'createdAt',
          order: 'asc'
        });
        
        // Add memories as conversation history
        for (const mem of recentMemories) {
          const memTyped = mem as MemoryType;
          if (memTyped.metadata?.type === 'user_message') {
            messages.push({ role: 'user', content: memTyped.content });
          } else if (memTyped.metadata?.type === 'assistant_response') {
            messages.push({ role: 'assistant', content: memTyped.content });
          }
        }
      } catch (error) {
        this.logger.warn('Failed to load memories:', error instanceof Error ? error.message : String(error));
      }
    }
    
    // Add knowledge context if query seems to need it
    if (this.hasKnowledge() && this.modules.knowledge) {
      try {
        const relevantKnowledge = await (this.modules.knowledge as Knowledge).searchKnowledge(prompt, 3, 0.7);
        if (relevantKnowledge.length > 0) {
          const knowledgeContext = relevantKnowledge
            .map((k) => k.content)
            .join('\n\n---\n\n');
          enhancedPrompt = `Relevant context from knowledge base:\n${knowledgeContext}\n\nUser question: ${enhancedPrompt}`;
        }
      } catch (error) {
        this.logger.warn('Failed to search knowledge:', error instanceof Error ? error.message : String(error));
      }
    }
    
    // Add temporary MCP servers if provided
    if (options?.mcpServers && this.modules.mcp) {
      for (const server of options.mcpServers) {
        try {
          await (this.modules.mcp as MCP).addMCPServer(server);
        } catch (error) {
          this.logger.warn(`Failed to add MCP server ${server.name}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
    
    // Add temporary plugins if provided
    // Plugin registration will be implemented in future updates
    
    // Add current prompt
    messages.push({ role: 'user', content: enhancedPrompt });
    
    // Tool usage will be implemented in future updates
    // const shouldUseTools = options?.useTools !== undefined ? 
    //   options.useTools : 
    //   (options?.attachments && options.attachments.length > 0) || this.canUseTools();
    
    // Get LLM instance
    const llm = getLLM(this.logger);
    
    // Prepare LLM options
    const llmOptions: LLMRequestOptions = {
      model: options?.model || this.getModel(),
      messages,
      temperature: options?.temperature || this.getTemperature(),
      maxTokens: options?.maxTokens || this.getMaxTokens(),
      stream: options?.stream
    };
    
    // Add tools if needed - tool integration will be handled by individual modules
    // For now, let LLM provider handle tool execution internally
    
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
      // Single LLM call - tool execution is handled by LLM provider
      const llmResponse = await llm.generateResponse(llmOptions);
      response = llmResponse.content;
    }
    

    // Store in memory if enabled
    if (this.hasMemory() && this.modules.memory) {
      try {
        await (this.modules.memory as Memory).addMemory(prompt, {
          type: 'user_message',
          attachments: options?.attachments ? options.attachments.length : 0
        });
        
        await (this.modules.memory as Memory).addMemory(response, {
          type: 'assistant_response',
          model: options?.model || this.getModel()
        });
      } catch (error) {
        this.logger.warn('Failed to store memory:', error instanceof Error ? error.message : String(error));
      }
    }
    
    // Clean up temporary MCP servers
    if (options?.mcpServers && this.modules.mcp) {
      for (const server of options.mcpServers) {
        try {
          await (this.modules.mcp as MCP).removeMCPServer(server.name);
        } catch (error) {
          this.logger.warn(`Failed to remove MCP server ${server.name}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
    
    // Clean up temporary plugins
    // Cleanup will be implemented in future updates
    
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
    
    // Re-bind methods after module changes
    this.bindModuleMethods();
  }
}


export type { AgentConfig } from './types';
export default Agent;