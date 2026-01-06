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
import { convertToolParametersToJsonSchema, cleanupPlugin } from '../plugin';
import { ToolError } from '../errors';

import { Task } from '../task';
import { Memory } from '../memory';
import { Graph } from '../graph';
import { Plugin } from '../plugin';
import { MCP } from '../mcp';
import { Knowledge } from '../knowledge';
import { Vision } from '../vision';
import { cleanupVision } from '../vision/tools';
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
import { Logger, getLogger } from '../logger';
import * as fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

// Maximum file size for attachments (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Cached base directory for path safety checks - computed once at module load
// This prevents TOCTOU issues where cwd could change between checks
const SAFE_BASE_DIR = path.resolve(process.cwd());

/**
 * Validate that a file path is safe and doesn't traverse outside allowed directories.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * @param filePath - The file path to validate
 * @param allowedBase - Optional base directory to restrict paths to (defaults to cached cwd)
 * @returns true if path is safe, false otherwise
 */
function isPathSafe(filePath: string, allowedBase?: string): boolean {
  // Validate input
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  // Reject paths with null bytes (common attack vector)
  if (filePath.includes('\0')) {
    return false;
  }

  // Normalize and resolve the path
  const normalizedPath = path.normalize(filePath);
  const resolved = path.resolve(normalizedPath);

  // Use provided base or cached base directory (not live cwd)
  const base = allowedBase ? path.resolve(allowedBase) : SAFE_BASE_DIR;
  const normalizedBase = path.normalize(base);

  // Check if resolved path starts with base directory
  // Use normalizedBase + path.sep to prevent prefix attacks (e.g., /base-other matching /base)
  const isWithinBase =
    resolved === normalizedBase || resolved.startsWith(normalizedBase + path.sep);

  // Additional check: reject symbolic link attempts in path components
  // (actual symlink following would require async fs.realpath which is beyond this sync check)
  const pathParts = normalizedPath.split(path.sep);
  const hasTraversal = pathParts.some((part) => part === '..' || part === '.');

  // If there are explicit traversal components, verify the final path is still safe
  if (hasTraversal && !isWithinBase) {
    return false;
  }

  return isWithinBase;
}

/**
 * Type guard for validating role values.
 * Ensures type safety when casting unknown values to role types.
 */
function isValidRole(role: unknown): role is 'user' | 'assistant' | 'system' {
  return role === 'user' || role === 'assistant' || role === 'system';
}

// Maximum session messages to prevent unbounded memory growth
const MAX_SESSION_MESSAGES = 1000;

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
  abstract clearContext(options?: { syncWithMemory?: boolean }): Promise<void>;
  abstract exportContext(): string;
  abstract importContext(data: string): void;

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
      // Dispose old logger if exists (Logger class has dispose method)
      const loggerWithDispose = this.logger as Logger & { dispose?: () => void };
      if (loggerWithDispose.dispose) {
        loggerWithDispose.dispose();
      }
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
    return this.config.temperature ?? DEFAULT_AGENT_CONFIG.temperature ?? 0.7;
  }

  getMaxTokens(): number {
    return this.config.maxTokens ?? DEFAULT_AGENT_CONFIG.maxTokens ?? 2000;
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
      model: options?.model ?? this.getModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? this.getTemperature(),
      maxTokens: options?.maxTokens ?? this.getMaxTokens(),
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
  // Static lock map to prevent race conditions during agent creation
  private static creationLock = new Map<string, Promise<Agent>>();

  // Instance-level operation lock to prevent concurrent chat/run operations
  // This prevents state corruption when multiple calls happen simultaneously
  private operationLock: Promise<void> | null = null;
  private operationQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

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
    // Use nullish coalescing (??) to properly handle 0 values for numeric fields
    this.modules.context = new ContextManager({
      maxContextLength: data.maxContextLength ?? data.maxTokens ?? 8000,
      autoCompress: data.autoContextCompression ?? false,
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
      // Extract context fields from metadata for proper DB storage
      const context: { graphId?: string; taskId?: string; sessionId?: string } = {};
      if (metadata?.graphId) {
        context.graphId = String(metadata.graphId);
      }
      if (metadata?.taskId) {
        context.taskId = String(metadata.taskId);
      }
      if (metadata?.sessionId) {
        context.sessionId = String(metadata.sessionId);
      }

      // Memory enabled: Save to database with context
      const memory = await this.modules.memory.addMemory(
        content,
        metadata,
        Object.keys(context).length > 0 ? context : undefined
      );

      // Also add to context manager (for non-memory-fed scenarios)
      // Mark as 'memory' source so saveContextToMemory won't re-save it
      if (this.modules.context) {
        const contextMessage: ContextMessage = {
          role: isValidRole(metadata?.role) ? metadata.role : 'user',
          content,
          timestamp: new Date(),
          metadata: {
            ...metadata,
            source: 'memory', // Mark as already saved to memory to prevent duplicate saves
            memory_id: memory.id,
          },
        };
        await this.modules.context.addMessage(contextMessage);
      }

      return memory;
    } else {
      // Memory disabled: Add to session-only messages
      const contextMessage: ContextMessage = {
        role: isValidRole(metadata?.role) ? metadata.role : 'user',
        content,
        timestamp: new Date(),
        metadata,
      };

      // Enforce session messages size limit to prevent unbounded memory growth
      if (this.sessionMessages.length >= MAX_SESSION_MESSAGES) {
        // Remove oldest messages from the beginning (not from the middle)
        const removeCount = Math.floor(MAX_SESSION_MESSAGES / 2);
        this.sessionMessages = this.sessionMessages.slice(removeCount);
        this.logger.debug('Truncated session messages', {
          removed: removeCount,
          remaining: this.sessionMessages.length,
        });
      }
      this.sessionMessages.push(contextMessage);

      // Return mock memory object with proper UUID
      return {
        id: randomUUID(),
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

  /**
   * Clear all data: both memory and context
   * This ensures Memory and Context are always synchronized
   */
  async clearAll(): Promise<{ memoriesCleared: number; contextCleared: boolean }> {
    let memoriesCleared = 0;
    let contextCleared = false;

    // Clear memory if enabled
    if (this.modules.memory) {
      memoriesCleared = await this.modules.memory.clearMemories();
      // Note: Memory callback will automatically clear context
    }

    // Clear context (in case memory is not enabled or callback didn't fire)
    if (this.modules.context) {
      await this.modules.context.clearContext();
      contextCleared = true;
    }

    // Clear session messages
    this.sessionMessages = [];

    this.logger.info(
      `Cleared all data: ${memoriesCleared} memories, context cleared: ${contextCleared}`
    );

    return { memoriesCleared, contextCleared };
  }

  /**
   * Clear session messages to free memory.
   * Call this when conversation context is no longer needed.
   */
  clearSessionMessages(): void {
    this.sessionMessages = [];
  }

  /**
   * Destroy agent resources and free memory.
   * Call this when the agent is no longer needed.
   * All cleanup operations are performed even if some fail.
   */
  async destroy(): Promise<void> {
    const cleanupErrors: Array<{ module: string; error: string }> = [];

    // Clear session messages
    this.sessionMessages = [];

    // Clear operation queue - reject pending operations
    while (this.operationQueue.length > 0) {
      const pending = this.operationQueue.shift();
      if (pending) {
        pending.reject(new Error('Agent destroyed while operation was pending'));
      }
    }

    // Clear operation lock
    this.operationLock = null;

    // Clear context if available
    if (this.modules.context) {
      try {
        await this.clearContext();
      } catch (error) {
        cleanupErrors.push({
          module: 'context',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Always delete reference even if cleanup fails
      delete this.modules.context;
    }

    // Memory module cleanup
    if (this.modules.memory) {
      try {
        // Call Memory.destroy() for proper cleanup
        this.modules.memory.destroy();
      } catch (error) {
        cleanupErrors.push({
          module: 'memory',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.memory;
    }

    // Knowledge module cleanup
    if (this.modules.knowledge) {
      try {
        // Knowledge module cleanup - clear internal references
        const knowledgeModule = this.modules.knowledge as Knowledge & {
          knex?: unknown;
          vectorStore?: unknown;
        };
        knowledgeModule.knex = null;
        knowledgeModule.vectorStore = null;
      } catch (error) {
        cleanupErrors.push({
          module: 'knowledge',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.knowledge;
    }

    // Vision module cleanup
    if (this.modules.vision) {
      try {
        // Vision module cleanup - call cleanupVision to remove from instance cache
        cleanupVision(this.data.id);
      } catch (error) {
        cleanupErrors.push({
          module: 'vision',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.vision;
    }

    // SubAgent module cleanup
    if (this.modules.subAgent) {
      try {
        // SubAgent has async destroy method
        await this.modules.subAgent.destroy();
      } catch (error) {
        cleanupErrors.push({
          module: 'subAgent',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.subAgent;
    }

    // Task module cleanup
    if (this.modules.task) {
      try {
        // Task module cleanup - clear agent reference
        // Use type-safe approach with unknown cast to avoid intersection type issues
        const taskModule = this.modules.task as unknown as {
          agent?: unknown;
          knex?: unknown;
        };
        taskModule.agent = null;
        taskModule.knex = null;
        // Note: We don't delete task module as it's required by interface
      } catch (error) {
        cleanupErrors.push({
          module: 'task',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // MCP cleanup
    if (this.modules.mcp) {
      try {
        // MCP module cleanup - remove all servers and wait for processes to exit
        await this.modules.mcp.cleanup();
      } catch (error) {
        cleanupErrors.push({
          module: 'mcp',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.mcp;
    }

    // Plugin cleanup
    if (this.modules.plugin) {
      try {
        if (this.data.id) {
          await cleanupPlugin(this.data.id);
        }
      } catch (error) {
        cleanupErrors.push({
          module: 'plugin',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.plugin;
    }

    // Graph module cleanup (if exists)
    if (this.modules.graph) {
      try {
        await this.modules.graph.destroy();
      } catch (error) {
        cleanupErrors.push({
          module: 'graph',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.graph;
    }

    // Log cleanup errors if any occurred
    if (cleanupErrors.length > 0) {
      this.logger.warn('Agent destroy completed with errors', {
        agentName: this.data.name,
        errorCount: cleanupErrors.length,
        // Serialize errors array to string for LogData compatibility
        errors: JSON.stringify(cleanupErrors),
      });
    }

    this.logger.info(`Agent ${this.data.name} destroyed`);

    // Logger dispose - must be last to allow logging above
    try {
      this.logger.dispose();
    } catch (error) {
      // Can't log here since logger is being disposed
      console.warn(
        'Logger dispose failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
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
    // Security: Validate file path to prevent path traversal attacks
    if (!isPathSafe(filePath)) {
      this.logger.error('Invalid file path: path traversal detected', undefined, { filePath });
      throw new Error('Invalid file path: path traversal detected');
    }
    return this.modules.knowledge.addKnowledgeFromFile(filePath, metadata);
  }

  async addKnowledgeFromDirectory(dirPath: string, metadata?: MetadataObject): Promise<void> {
    if (!this.modules.knowledge) throw new Error('Knowledge module not enabled');
    // Security: Validate directory path to prevent path traversal attacks
    if (!isPathSafe(dirPath)) {
      this.logger.error('Invalid directory path: path traversal detected', undefined, { dirPath });
      throw new Error('Invalid directory path: path traversal detected');
    }
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
    if (!this.modules.subAgent) {
      throw new Error('SubAgent module not initialized');
    }

    // Capture reference to avoid repeated null checks in callbacks
    const subAgentModule = this.modules.subAgent;

    if (coordination === 'parallel') {
      // Use Promise.allSettled to handle partial failures gracefully
      // This ensures successful tasks are not lost when some tasks fail
      const settledResults = await Promise.allSettled(
        tasks.map(async (task) => {
          if (task.agent && task.prompt) {
            const result = await subAgentModule.executeWithSubAgents(task.prompt, [task.agent], {});
            return { task, result };
          }
          return null;
        })
      );

      const results: Array<{ task: { agent: IAgent; prompt: string }; result: string }> = [];
      for (const settled of settledResults) {
        if (settled.status === 'fulfilled' && settled.value !== null) {
          results.push(settled.value);
        } else if (settled.status === 'rejected') {
          // Log failed tasks but don't throw - allow other tasks to complete
          this.logger.warn('Parallel task execution failed', {
            error:
              settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
          });
        }
      }
      return results;
    }

    // Sequential mode - use the captured reference for consistency
    const results: Array<{ task: { agent: IAgent; prompt: string }; result: string }> = [];
    for (const task of tasks) {
      if (task.agent && task.prompt) {
        const result = await subAgentModule.executeWithSubAgents(task.prompt, [task.agent], {
          coordination,
        });
        results.push({ task, result });
      }
    }
    return results;
  }

  // ===== CONTEXT MODULE METHODS (always available) =====

  private getContextModule(): ContextManager {
    if (!this.modules.context) {
      throw new Error('Context module not initialized');
    }
    return this.modules.context;
  }

  getContextMessages(): ContextMessage[] {
    return this.getContextModule().getMessages();
  }

  getContextWindow(): ContextWindow {
    return this.getContextModule().getContextWindow();
  }

  analyzeContext(): ContextAnalysis {
    return this.getContextModule().analyzeContext();
  }

  async compressContext(): Promise<CompressionResult> {
    return this.getContextModule().compressContext();
  }

  async clearContext(options?: { syncWithMemory?: boolean }): Promise<void> {
    await this.getContextModule().clearContext(options);
  }

  exportContext(): string {
    return this.getContextModule().exportContext();
  }

  importContext(data: string): void {
    this.getContextModule().importContext(data);
  }

  async generateContextSummary(): Promise<ContextSummary> {
    return this.getContextModule().generateSummary();
  }

  updateContextModel(model: string): void {
    this.getContextModule().updateModel(model);
  }

  /**
   * Search context messages with filtering support
   * Supports graphId, taskId, sessionId, role, and text query filters
   */
  searchContext(options: {
    query?: string;
    graphId?: string;
    taskId?: string;
    sessionId?: string;
    role?: 'user' | 'assistant' | 'system';
    limit?: number;
  }): ContextMessage[] {
    return this.getContextModule().searchContext(options);
  }

  /**
   * Get conversation context messages based on memory configuration
   * This is the central method that all modules use to get conversation history
   */
  getContext(): ContextMessage[] {
    if (this.hasMemory() && this.modules.memory) {
      // Memory enabled: Get from context manager (fed by memory)
      return this.getContextModule().getMessages();
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

    if (!this.modules.context) {
      this.logger.warn('Context module not available for saving to memory');
      return;
    }

    try {
      await this.modules.context.saveToMemory(this.modules.memory);
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
    if (this.modules.context) {
      this.modules.context.updateModel(model);
    }

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
      await this.clearContext();

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

        // Combine, deduplicate by memory ID, and sort by timestamp
        const seenIds = new Set<string>();
        const combinedMemories = [...generalConversations, ...graphMemories];
        allMemories = combinedMemories
          .filter((m) => {
            if (seenIds.has(m.id)) {
              return false; // Skip duplicate
            }
            seenIds.add(m.id);
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        this.logger.debug(
          `Loaded ${generalConversations.length} general + ${graphMemories.length} graph-specific memories for graph ${graphId}`
        );
      }

      // Load all memories into context
      for (const memory of allMemories) {
        const role = isValidRole(memory.metadata?.role) ? memory.metadata.role : 'user';
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

    // Get LLM provider information - handle empty string as well as undefined/null
    const model =
      this.data.model && this.data.model.trim() !== '' ? this.data.model : 'gpt-4o-mini';
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

      // Register callback for Memory-Context synchronization (Memory -> Context)
      // Note: Callback is async and must await all async operations to prevent race conditions
      this.modules.memory.onMemoryChange(async (event, data) => {
        if (!this.modules.context) return;

        try {
          switch (event) {
            case 'update':
              if (data.memoryId) {
                // updateMessageByMemoryId may be async - await it
                await Promise.resolve(
                  this.modules.context.updateMessageByMemoryId(data.memoryId, {
                    content: data.content,
                    metadata: data.metadata,
                  })
                );
              }
              break;
            case 'delete':
              if (data.memoryId) {
                // removeMessageByMemoryId may be async - await it
                await Promise.resolve(this.modules.context.removeMessageByMemoryId(data.memoryId));
              }
              break;
            case 'clear':
              // Memory cleared, also clear context (use syncWithMemory: false to prevent infinite loop)
              await this.modules.context.clearContext({ syncWithMemory: false });
              break;
          }
        } catch (error) {
          this.logger.warn('Memory-Context synchronization failed', {
            event,
            memoryId: data.memoryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // Register callback for Context-Memory synchronization (Context -> Memory)
    if (this.modules.context) {
      // When context is cleared, optionally clear memory too
      this.modules.context.onContextClear(async () => {
        if (this.modules.memory) {
          // Use syncWithContext: false to prevent infinite loop
          await this.modules.memory.clearMemories({ syncWithContext: false });
          this.logger.debug('Memory cleared due to context clear sync');
        }
      });

      // When context is compressed, notify memory for potential archiving
      this.modules.context.onCompression(async (info) => {
        this.logger.info('Context compression completed', {
          originalMessages: info.originalMessageCount,
          compressedMessages: info.compressedMessageCount,
          messagesRemoved: info.messagesRemoved,
          tokensReduced: info.tokensReduced,
          strategy: info.strategy,
        });

        // Note: Memory archiving could be implemented here if needed
        // For now, we just log the compression event
        // Future enhancement: Mark old memories as archived or move to cold storage
      });
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
    if (this.data.id && this.modules.context) {
      try {
        await this.modules.context.initializeForAgent(this.data.id);
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
   * Factory method to create a new agent or find existing one by name.
   * Uses a lock mechanism to prevent race conditions when creating agents
   * with the same name concurrently.
   *
   * Note: If the first creation attempt fails, subsequent callers will NOT
   * receive the rejected promise - instead they will start a fresh creation attempt.
   */
  static async create(config: AgentConfigInput): Promise<Agent> {
    const lockKey = config.name;

    // Check if there's already a creation in progress for this name
    const existingLock = Agent.creationLock.get(lockKey);
    if (existingLock) {
      try {
        // Wait for the existing creation to complete and return that agent
        return await existingLock;
      } catch {
        // The existing creation failed - check if it's still the same promise
        // If so, we can try a fresh creation (the original caller would have cleaned up)
        const currentLock = Agent.creationLock.get(lockKey);
        if (currentLock === existingLock) {
          // Same failed promise is still there - this shouldn't happen normally
          // because the original caller's finally block should have cleaned it up
          // But handle it defensively by continuing to try fresh creation
          Agent.creationLock.delete(lockKey);
        } else if (currentLock) {
          // A new creation attempt is in progress, wait for it
          return await currentLock;
        }
        // Fall through to start fresh creation
      }
    }

    // Create the agent with lock protection
    // Wrap in a new promise to handle errors and cleanup properly
    const createPromise = Agent._doCreate(config).catch((error) => {
      // On error, immediately clean up the lock so other callers can retry
      // This must happen before the error propagates to prevent others from waiting on a failed promise
      Agent.creationLock.delete(lockKey);
      throw error;
    });

    Agent.creationLock.set(lockKey, createPromise);

    try {
      const agent = await createPromise;
      return agent;
    } finally {
      // Clean up on success as well
      // Use a check to avoid deleting a different promise (in case of rapid recreation)
      if (Agent.creationLock.get(lockKey) === createPromise) {
        Agent.creationLock.delete(lockKey);
      }
    }
  }

  /**
   * Internal method that performs the actual agent creation.
   * Should not be called directly - use create() instead.
   */
  private static async _doCreate(config: AgentConfigInput): Promise<Agent> {
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
    if (existingAgent && existingAgent.id) {
      // Agent exists, update it with new config
      const updatedAgent = await db.updateAgent(existingAgent.id, fullConfig);
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
   * List all agents (returns only agent data without initializing modules).
   * Use this for listing/browsing agents without full initialization.
   * @param options - Optional settings
   * @param options.initialize - If true, fully initialize all agents (default: false for performance)
   * @param options.limit - Maximum number of agents to return (default: 100, max: 1000)
   * @param options.offset - Number of agents to skip for pagination (default: 0)
   */
  static async list(options?: {
    initialize?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Agent[]> {
    const db = await getDatabase();
    const agentsData = await db.listAgents();

    // Apply pagination with sensible defaults to prevent memory issues
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
    const offset = Math.max(options?.offset ?? 0, 0);
    const paginatedData = agentsData.slice(offset, offset + limit);

    // Lazy loading: Don't initialize modules unless explicitly requested
    // This prevents memory issues when listing many agents
    if (options?.initialize) {
      // Use Promise.allSettled to handle partial failures gracefully
      const settledResults = await Promise.allSettled(
        paginatedData.map(async (data) => {
          const agent = new Agent(data);
          await agent.initializeModules();
          return agent;
        })
      );

      // Collect successful agents and log failures
      const agents: Agent[] = [];
      for (let i = 0; i < settledResults.length; i++) {
        const result = settledResults[i];
        if (result.status === 'fulfilled') {
          agents.push(result.value);
        } else {
          // Log initialization failure but continue with other agents
          const agentName = paginatedData[i]?.name ?? 'unknown';
          const logger = getLogger();
          logger.warn(`Failed to initialize agent '${agentName}'`, {
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
      return agents;
    }

    // Return agents without full module initialization (lazy loading)
    return paginatedData.map((data) => new Agent(data));
  }

  /**
   * Acquire operation lock to prevent concurrent chat/run operations
   * Operations are queued and executed sequentially to prevent state corruption
   * Uses a proper async queue instead of busy-wait loop for efficiency
   * @param timeout - Maximum time to wait for lock acquisition (default: 60000ms)
   * @returns A release function to be called when operation completes
   */
  private async acquireOperationLock(timeout = 60000): Promise<() => void> {
    // If there's an existing operation, queue this one
    if (this.operationLock) {
      // Create a promise that will resolve when it's our turn
      const waitPromise = new Promise<void>((resolve, reject) => {
        // Set up timeout
        const timeoutId = setTimeout(() => {
          // Remove ourselves from queue on timeout
          const index = this.operationQueue.findIndex((item) => item.resolve === resolve);
          if (index !== -1) {
            this.operationQueue.splice(index, 1);
          }
          reject(new Error(`Operation lock acquisition timeout after ${timeout}ms`));
        }, timeout);

        // Add to queue with timeout cleanup
        this.operationQueue.push({
          resolve: () => {
            clearTimeout(timeoutId);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(timeoutId);
            reject(error);
          },
        });
      });

      // Wait for our turn
      await waitPromise;
    }

    // Create new lock - we now own the lock
    let releaseFunction: (() => void) | null = null;
    this.operationLock = new Promise<void>((resolve) => {
      releaseFunction = () => {
        // Release our lock first
        this.operationLock = null;
        resolve();

        // Then notify next in queue (if any) that it's their turn
        const next = this.operationQueue.shift();
        if (next) {
          // Use setImmediate/nextTick pattern to avoid stack overflow on long queues
          Promise.resolve().then(() => next.resolve());
        }
      };
    });

    if (!releaseFunction) {
      throw new Error('Failed to initialize operation lock release function');
    }

    return releaseFunction;
  }

  /**
   * Main run method - protected by operation lock to prevent concurrent state corruption
   */
  async run(prompt: string, options?: RunOptions): Promise<string> {
    const release = await this.acquireOperationLock();

    try {
      // Add context processing here if needed

      // Check if we should use tools
      const useTools = options?.useTools !== undefined ? options.useTools : this.canUseTools();

      if (useTools) {
        // Tool execution logic would go here
        // For now, just use LLM
      }

      // Call LLM
      return await this.callLLM(prompt, options);
    } finally {
      release();
    }
  }

  /**
   * Ask method - direct conversation with the agent (task-independent)
   * Protected by operation lock to prevent concurrent state corruption
   */
  async ask(prompt: string, options?: AskOptions): Promise<string> {
    const release = await this.acquireOperationLock();

    try {
      return await this._askInternal(prompt, options);
    } finally {
      release();
    }
  }

  /**
   * Internal ask implementation - do not call directly, use ask() instead
   */
  private async _askInternal(prompt: string, options?: AskOptions): Promise<string> {
    // Check if sub-agents should be used
    if (options?.useSubAgents && this.config.subAgents && this.config.subAgents.length > 0) {
      if (!this.modules.subAgent) {
        this.logger.warn('SubAgent module not available, falling back to main agent');
      } else {
        this.logger.info(`Using sub-agents for task delegation`, {
          subAgentCount: this.config.subAgents.length,
          delegation: options.delegation || 'auto',
        });

        try {
          const result = await this.modules.subAgent.executeWithSubAgents(
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
                // Security: Validate image path to prevent path traversal attacks
                if (!isPathSafe(attachment.path)) {
                  this.logger.error('Invalid image path: path traversal detected', undefined, {
                    imagePath: attachment.path,
                  });
                  throw new Error('Invalid image path: path traversal detected');
                }

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
                // Security: Validate path to prevent path traversal attacks
                if (!isPathSafe(attachment.path)) {
                  throw new Error('Invalid file path: path traversal detected');
                }

                // Fix TOCTOU vulnerability: Read file first, then check size
                // This prevents race conditions where file changes between stat and read
                // Use a file handle for atomic operation
                let fileHandle: import('fs/promises').FileHandle | null = null;
                try {
                  fileHandle = await fs.open(attachment.path, 'r');
                  const stats = await fileHandle.stat();

                  // Security: Check file size to prevent DoS attacks
                  if (stats.size > MAX_FILE_SIZE) {
                    throw new Error(`File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE})`);
                  }

                  // Read content using the same file handle to prevent TOCTOU
                  const buffer = await fileHandle.readFile({ encoding: 'utf-8' });
                  const content = buffer.toString();

                  // Double-check the actual content size (in case file grew)
                  if (content.length > MAX_FILE_SIZE) {
                    throw new Error(
                      `File content too large: ${content.length} chars (max: ${MAX_FILE_SIZE})`
                    );
                  }

                  const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
                  description += `\nContent:\n${preview}`;
                } finally {
                  // Always close the file handle
                  if (fileHandle) {
                    await fileHandle.close();
                  }
                }
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

    // Track added servers and plugins for cleanup on error
    const addedMcpServers: string[] = [];
    const addedPlugins: string[] = [];

    try {
      // Add temporary MCP servers if provided
      if (options?.mcpServers && Array.isArray(options.mcpServers) && this.modules?.mcp) {
        const mcpModule = this.modules.mcp as MCP;
        if (mcpModule && typeof mcpModule.addMCPServer === 'function') {
          for (const server of options.mcpServers) {
            if (server && server.name) {
              try {
                await mcpModule.addMCPServer(server);
                addedMcpServers.push(server.name);
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
                addedPlugins.push(pluginDef.plugin.name);
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
    } catch (error) {
      // Cleanup on error: remove any successfully added servers and plugins
      // Log cleanup errors for debugging instead of silently ignoring
      for (const serverName of addedMcpServers) {
        try {
          (this.modules.mcp as MCP)?.removeMCPServer(serverName);
        } catch (cleanupError) {
          this.logger.debug('Failed to cleanup MCP server on error', {
            serverName,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      for (const pluginName of addedPlugins) {
        try {
          await (this.modules.plugin as Plugin)?.unregisterPlugin(pluginName);
        } catch (cleanupError) {
          this.logger.debug('Failed to cleanup plugin on error', {
            pluginName,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
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
      model: options?.model ?? this.getModel(),
      messages,
      temperature: options?.temperature ?? this.getTemperature(),
      maxTokens: options?.maxTokens ?? this.getMaxTokens(),
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
          const toolName = toolCall.function?.name;
          if (!toolName) {
            this.logger.warn('Skipping tool call with missing function name', {
              toolCallId: toolCall.id,
            });
            continue;
          }

          try {
            let toolResult: string;

            if (toolName.startsWith('mcp_')) {
              // Handle MCP tool call
              const mcpToolName = toolName.substring(4); // Remove 'mcp_' prefix

              // Ensure arguments are properly formatted for MCP with type-safe parsing
              let mcpArgs: Record<string, string | number | boolean | object | null>;
              if (typeof toolCall.function.arguments === 'string') {
                try {
                  const parsed: unknown = JSON.parse(toolCall.function.arguments);
                  // Validate parsed result is an object (not null, array, or primitive)
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('MCP tool arguments must be a JSON object');
                  }
                  mcpArgs = parsed as Record<string, string | number | boolean | object | null>;
                } catch (parseError) {
                  const parseErr =
                    parseError instanceof Error ? parseError : new Error(String(parseError));
                  this.logger.error('Failed to parse MCP tool arguments', parseErr);
                  throw new Error(`Invalid JSON in MCP tool arguments: ${parseErr.message}`);
                }
              } else if (
                toolCall.function.arguments &&
                typeof toolCall.function.arguments === 'object'
              ) {
                mcpArgs = toolCall.function.arguments as Record<
                  string,
                  string | number | boolean | object | null
                >;
              } else {
                // Default to empty object if no arguments provided
                mcpArgs = {};
              }

              if (this.modules.mcp) {
                const mcpResult = await this.modules.mcp.callMCPTool(
                  mcpToolName,
                  mcpArgs as Record<string, import('../mcp/types').MCPValue>
                );
                toolResult = mcpResult.content.map((c) => c.text || '').join('\n');
              } else {
                toolResult = 'MCP module not available';
              }
            } else if (toolName.startsWith('plugin_')) {
              // Handle plugin tool call
              const pluginToolName = toolName.substring(7); // Remove 'plugin_' prefix

              // Ensure arguments are properly formatted for plugin tools with type-safe parsing
              let pluginArgs: Record<string, string | number | boolean | object | null>;
              if (typeof toolCall.function.arguments === 'string') {
                try {
                  const parsed: unknown = JSON.parse(toolCall.function.arguments);
                  // Validate parsed result is an object (not null, array, or primitive)
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Plugin tool arguments must be a JSON object');
                  }
                  pluginArgs = parsed as Record<string, string | number | boolean | object | null>;
                } catch (parseError) {
                  const parseErr =
                    parseError instanceof Error ? parseError : new Error(String(parseError));
                  this.logger.error('Failed to parse plugin tool arguments', parseErr);
                  throw new Error(`Invalid JSON in plugin tool arguments: ${parseErr.message}`);
                }
              } else if (
                toolCall.function.arguments &&
                typeof toolCall.function.arguments === 'object'
              ) {
                pluginArgs = toolCall.function.arguments as Record<
                  string,
                  string | number | boolean | object | null
                >;
              } else {
                // Default to empty object if no arguments provided
                pluginArgs = {};
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

                // Log metadata if present (for debugging and observability)
                if (pluginResult.result.metadata) {
                  this.logger.debug('Plugin tool returned metadata', {
                    toolName: pluginToolName,
                    toolCallId: toolCall.id,
                    metadata: pluginResult.result.metadata,
                  });
                }

                // Build tool result with optional metadata inclusion
                if (pluginResult.result.success) {
                  const resultData =
                    typeof pluginResult.result.data === 'string'
                      ? pluginResult.result.data
                      : JSON.stringify(pluginResult.result.data);

                  // Include metadata in response if present (allows LLM to see relevant context)
                  if (
                    pluginResult.result.metadata &&
                    Object.keys(pluginResult.result.metadata).length > 0
                  ) {
                    toolResult = JSON.stringify({
                      result: resultData,
                      metadata: pluginResult.result.metadata,
                    });
                  } else {
                    toolResult = resultData;
                  }
                } else {
                  toolResult = `Error: ${pluginResult.result.error || 'Unknown error'}`;
                }
              } else {
                toolResult = `Plugin module not available`;
              }
            } else {
              // Handle other tool types (future implementations)
              toolResult = `Tool ${toolName} not implemented yet`;
            }

            // CRITICAL: Tool result content cannot be empty for OpenAI API
            if (!toolResult || toolResult.trim() === '') {
              this.logger.warn('Empty tool result detected', {
                toolName,
                toolCallId: toolCall.id,
                resultType: typeof toolResult,
                resultValue: toolResult,
              });
              toolResult = 'Tool execution completed but returned no data.';
            }

            this.logger.debug('Tool result received', {
              toolName,
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
              toolName,
              toolCallId: toolCall.id,
              resultLength: toolResult.length,
            });
          } catch (error) {
            // Normalize tool error using ToolError class
            const originalError = error instanceof Error ? error : new Error(String(error));
            const toolType = toolName.startsWith('mcp_')
              ? 'mcp'
              : toolName.startsWith('plugin_')
                ? 'plugin'
                : 'unknown';
            const actualToolName =
              toolType === 'mcp'
                ? toolName.substring(4)
                : toolType === 'plugin'
                  ? toolName.substring(7)
                  : toolName;

            // Determine error type based on error message
            let errorType: 'not_found' | 'validation' | 'execution' | 'timeout' | 'unknown' =
              'execution';
            if (
              originalError.message.includes('not found') ||
              originalError.message.includes('not available')
            ) {
              errorType = 'not_found';
            } else if (
              originalError.message.includes('Invalid') ||
              originalError.message.includes('validation')
            ) {
              errorType = 'validation';
            } else if (
              originalError.message.includes('timeout') ||
              originalError.message.includes('timed out')
            ) {
              errorType = 'timeout';
            }

            // Determine if error is recoverable (LLM can try alternative approach)
            const recoverable = errorType !== 'not_found';

            const toolError = new ToolError(
              `Tool '${actualToolName}' (${toolType}) failed: ${originalError.message}`,
              actualToolName,
              toolType,
              errorType,
              recoverable,
              originalError
            );

            this.logger.error(`Tool call failed: ${toolName}`, toolError, {
              toolType,
              errorType,
              recoverable,
              toolCallId: toolCall.id,
            });

            // Add normalized error result to messages (LLM can use this to decide next action)
            const errorResult = toolError.toToolResult();
            messages.push({
              role: 'tool',
              content: JSON.stringify(errorResult),
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
                if (result.success === true) {
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

    // Save context to memory if enabled - propagate errors for visibility
    try {
      await this.saveContextToMemory();
    } catch (saveError) {
      // Log but don't throw - response is already generated, we don't want to lose it
      this.logger.error(
        'Failed to save context to memory',
        saveError instanceof Error ? saveError : new Error(String(saveError)),
        {
          responseLength: response.length,
        }
      );
    }

    // Clean up temporary MCP servers and plugins in finally-like block
    // This ensures cleanup happens even if saveContextToMemory fails
    const cleanupMcpServers = async () => {
      if (options?.mcpServers && this.modules.mcp) {
        for (const server of options.mcpServers) {
          try {
            (this.modules.mcp as MCP).removeMCPServer(server.name);
          } catch (error) {
            this.logger.warn('Failed to remove temporary MCP server', {
              serverName: server.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    };

    const cleanupPlugins = async () => {
      if (options?.plugins && Array.isArray(options.plugins) && this.modules?.plugin) {
        for (const pluginDef of options.plugins) {
          if (pluginDef && pluginDef.plugin) {
            try {
              await (this.modules.plugin as Plugin).unregisterPlugin(pluginDef.plugin.name);
            } catch (error) {
              this.logger.warn('Failed to unregister temporary plugin', {
                pluginName: pluginDef.plugin.name,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    };

    // Execute cleanup - errors are logged but don't prevent response return
    await Promise.all([cleanupMcpServers(), cleanupPlugins()]);

    return response;
  }

  /**
   * Update agent configuration
   * Ensures module state consistency even if initialization or cleanup fails
   */
  async update(updates: Partial<AgentConfig>): Promise<void> {
    const wasMemoryEnabled = this.hasMemory();
    const wasKnowledgeEnabled = this.hasKnowledge();
    const wasVisionEnabled = this.hasVision();
    const wasToolsEnabled = this.canUseTools();

    await super.update(updates);

    const moduleErrors: Array<{ module: string; operation: string; error: string }> = [];

    // Handle module changes - properly cleanup before disabling
    // Memory module
    if (this.hasMemory() && !wasMemoryEnabled) {
      const newMemory = new Memory(this);
      try {
        await newMemory.initialize();
        this.modules.memory = newMemory;
      } catch (error) {
        moduleErrors.push({
          module: 'memory',
          operation: 'initialize',
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't assign the failed module
      }
    } else if (!this.hasMemory() && wasMemoryEnabled && this.modules.memory) {
      // Memory module cleanup - call destroy() for proper cleanup
      this.logger.debug('Cleaning up Memory module on disable');
      try {
        this.modules.memory.destroy();
      } catch (error) {
        moduleErrors.push({
          module: 'memory',
          operation: 'cleanup',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Always delete reference even if cleanup fails
      delete this.modules.memory;
    }

    // Knowledge module
    if (this.hasKnowledge() && !wasKnowledgeEnabled) {
      const newKnowledge = new Knowledge(this);
      try {
        await newKnowledge.initialize();
        this.modules.knowledge = newKnowledge;
      } catch (error) {
        moduleErrors.push({
          module: 'knowledge',
          operation: 'initialize',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (!this.hasKnowledge() && wasKnowledgeEnabled && this.modules.knowledge) {
      // Knowledge module cleanup - clear internal references before deleting
      this.logger.debug('Cleaning up Knowledge module on disable');
      try {
        const knowledgeModule = this.modules.knowledge as Knowledge & {
          knex?: unknown;
          vectorStore?: unknown;
        };
        knowledgeModule.knex = null;
        knowledgeModule.vectorStore = null;
      } catch (error) {
        moduleErrors.push({
          module: 'knowledge',
          operation: 'cleanup',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.knowledge;
    }

    // Vision module
    if (this.hasVision() && !wasVisionEnabled) {
      const newVision = new Vision(this);
      try {
        await newVision.initialize();
        this.modules.vision = newVision;
      } catch (error) {
        moduleErrors.push({
          module: 'vision',
          operation: 'initialize',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (!this.hasVision() && wasVisionEnabled && this.modules.vision) {
      // Vision module cleanup - call cleanupVision to remove from instance cache
      this.logger.debug('Cleaning up Vision module on disable');
      try {
        cleanupVision(this.data.id);
      } catch (error) {
        moduleErrors.push({
          module: 'vision',
          operation: 'cleanup',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      delete this.modules.vision;
    }

    // Handle useTools toggle - properly cleanup MCP and Plugin modules
    const nowToolsEnabled =
      updates.useTools !== undefined ? updates.useTools !== false : wasToolsEnabled;
    if (!nowToolsEnabled && wasToolsEnabled) {
      // Tools disabled - cleanup MCP and Plugin modules
      this.logger.debug('Cleaning up tool modules on disable');

      if (this.modules.mcp) {
        try {
          await this.modules.mcp.cleanup();
        } catch (error) {
          moduleErrors.push({
            module: 'mcp',
            operation: 'cleanup',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        delete this.modules.mcp;
      }

      if (this.modules.plugin) {
        try {
          if (this.data.id) {
            await cleanupPlugin(this.data.id);
          }
        } catch (error) {
          moduleErrors.push({
            module: 'plugin',
            operation: 'cleanup',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        delete this.modules.plugin;
      }
    } else if (nowToolsEnabled && !wasToolsEnabled) {
      // Tools enabled - initialize MCP and Plugin modules
      // Initialize plugin first, then MCP - maintain order for proper dependency
      const newPlugin = new Plugin(this);
      const newMcp = new MCP(this);

      try {
        await newPlugin.initialize();
        this.modules.plugin = newPlugin;
      } catch (error) {
        moduleErrors.push({
          module: 'plugin',
          operation: 'initialize',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await newMcp.initialize();
        this.modules.mcp = newMcp;
      } catch (error) {
        moduleErrors.push({
          module: 'mcp',
          operation: 'initialize',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Log any module errors
    if (moduleErrors.length > 0) {
      this.logger.warn('Agent update completed with module errors', {
        errorCount: moduleErrors.length,
        moduleErrorDetails: JSON.stringify(moduleErrors),
      });
    }

    // Module methods are directly implemented and don't need re-binding
  }
}

export type { AgentConfig } from './types';
export default Agent;
