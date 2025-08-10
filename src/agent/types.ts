/**
 * Core types for the agent system
 */
import { Logger } from '../logger/types';
import { Task, TaskRequest, TaskSearchOptions, TaskResponse } from '../task/types';
import { Memory, MemorySearchOptions } from '../memory/types';
import {
  Plugin,
  PluginConfig,
  ToolDefinition,
  ToolCall as PluginToolCall,
  ToolCallResult,
} from '../plugin/types';
import { MCPServerDefinition, MCPValue, MCPTool } from '../mcp/types';
import { AnalysisOptions } from '../vision/index';
import { MetadataObject } from '../types';

// Forward declaration for sub-agents - using IAgent interface

export type Constructor<T = object> = new (...args: never[]) => T;

/**
 * Task module methods - bound when Task module is available
 */
export interface ITaskMethods {
  createTask(request: TaskRequest): Promise<Task>;
  getTask(id: number): Promise<Task | null>;
  listTasks(options?: TaskSearchOptions): Promise<Task[]>;
  updateTask(id: number, updates: Partial<Task>): Promise<Task | null>;
  deleteTask(id: number): Promise<boolean>;
  clearTasks(): Promise<number>;
  executeTask(
    taskId: number,
    options?: { model?: string; stream?: boolean }
  ): Promise<TaskResponse>;
}

/**
 * Memory module methods - bound when Memory module is available
 */
export interface IMemoryMethods {
  addMemory(content: string, metadata?: MetadataObject): Promise<Memory>;
  getMemory(id: number): Promise<Memory | null>;
  searchMemories(query: string, options?: MemorySearchOptions): Promise<Memory[]>;
  listMemories(options?: MemorySearchOptions): Promise<Memory[]>;
  updateMemory(
    id: number,
    updates: { content?: string; metadata?: MetadataObject }
  ): Promise<Memory | null>;
  deleteMemory(id: number): Promise<boolean>;
  clearMemories(): Promise<number>;
  rememberConversation(content: string, role?: 'user' | 'assistant'): Promise<Memory>;
  searchMemoriesBySimilarity(query: string, options?: MemorySearchOptions): Promise<Memory[]>;
  generateEmbeddingForMemory(
    memoryId: number
  ): Promise<{ success: boolean; message: string; embedding?: number[] }>;
}

/**
 * Knowledge module methods - bound when Knowledge module is available
 */
export interface IKnowledgeMethods {
  addKnowledge(content: string, title?: string, metadata?: MetadataObject): Promise<number>;
  searchKnowledge(
    query: string,
    limit?: number,
    threshold?: number
  ): Promise<Array<{ content: string; metadata: MetadataObject; similarity: number }>>;
  getKnowledgeContext(query: string, limit?: number): Promise<string>;
  getKnowledgeDocuments(): Promise<Array<{ id: number; title: string; created_at: string }>>;
  deleteKnowledgeDocument(documentId: number): Promise<boolean>;
  deleteKnowledgeChunk(chunkId: number): Promise<boolean>;
  clearKnowledge(): Promise<void>;
  addKnowledgeFromFile(filePath: string, metadata?: MetadataObject): Promise<void>;
  addKnowledgeFromDirectory(dirPath: string, metadata?: MetadataObject): Promise<void>;
  expandKnowledgeContext(
    documentId: number,
    chunkIndex: number,
    expandBefore?: number,
    expandAfter?: number
  ): Promise<string[]>;
}

/**
 * Plugin module methods - bound when Plugin module is available
 */
export interface IPluginMethods {
  registerPlugin(plugin: Plugin, config?: PluginConfig): Promise<void>;
  unregisterPlugin(name: string): Promise<void>;
  getPlugins(): Plugin[];
  getTools(): ToolDefinition[];
  executeTool(toolCall: PluginToolCall): Promise<ToolCallResult>;
}

/**
 * MCP module methods - bound when MCP module is available
 */
export interface IMCPMethods {
  addMCPServer(serverDef: MCPServerDefinition): Promise<void>;
  addMCPServers(servers: MCPServerDefinition[]): Promise<void>;
  removeMCPServer(name: string): void;
  callMCPTool(
    toolName: string,
    args: Record<string, MCPValue>
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  getMCPTools(): MCPTool[];
}

/**
 * Vision module methods - bound when Vision module is available
 */
export interface IVisionMethods {
  analyzeImage(imagePath: string, options?: AnalysisOptions): Promise<string>;
  describeImage(imagePath: string): Promise<string>;
  extractTextFromImage(imagePath: string): Promise<string>;
}

/**
 * SubAgent module methods - bound when SubAgent module is available
 */
export interface ISubAgentMethods {
  executeWithSubAgents(
    prompt: string,
    subAgents: IAgent[],
    options?: Record<string, unknown>,
    mainModel?: string
  ): Promise<string>;
  delegateTask(
    taskPrompt: string,
    targetAgent: IAgent,
    options?: Record<string, unknown>
  ): Promise<string>;
  coordinateAgents(
    tasks: Array<{ agent: IAgent; prompt: string }>,
    coordination?: 'parallel' | 'sequential'
  ): Promise<Array<{ task: { agent: IAgent; prompt: string }; result: string }>>;
}

/**
 * Base interface that all agents must implement
 */
export interface IAgent {
  id: number;
  name: string;
  config: AgentConfig;
  logger: Logger;
  run(prompt: string, options?: RunOptions): Promise<string>;
  ask(prompt: string, options?: AskOptions): Promise<string>;
  canUseTools(): boolean;
  hasMemory(): boolean;
  hasKnowledge(): boolean;
  hasVision(): boolean;
}

/**
 * Base interface for all agent modules
 */
export interface IAgentModule {
  readonly name: string;
  initialize(): Promise<void>;
  destroy?(): Promise<void>;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  id?: number;
  name: string;
  description?: string;
  model?: string;
  embeddingModel?: string; // Specific model for embeddings (auto-detected if not specified)
  visionModel?: string; // Specific model for vision (auto-detected if not specified)
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  memory?: boolean;
  knowledge?: boolean;
  vision?: boolean;
  useTools?: boolean;
  contextCompression?: boolean; // Enable smart context management for long conversations
  debug?: boolean; // Enable debug logging
  subAgents?: IAgent[]; // Sub-agents for this agent
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for agent.run() method
 */
export interface RunOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  useTools?: boolean;
  onChunk?: (chunk: string) => void;
}

/**
 * Options for agent.ask() method
 */
export interface AskOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  useTools?: boolean;
  onChunk?: (chunk: string) => void;
  // Sub-agent specific options
  useSubAgents?: boolean;
  delegation?: 'auto' | 'manual' | 'sequential';
  taskAssignment?: Record<number, string>; // agentId -> task mapping
  coordination?: 'parallel' | 'sequential'; // How to coordinate sub-agent execution
  attachments?: Array<{
    type: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'json' | 'file';
    path: string;
    name?: string;
    language?: string; // For code files
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
      tools?: Array<{
        name: string;
        description: string;
        parameters: Record<
          string,
          {
            name: string;
            type: 'string' | 'number' | 'boolean' | 'object' | 'array';
            description: string;
            required?: boolean;
          }
        >;
        handler: (params: Record<string, string | number | boolean | null>) => Promise<{
          success: boolean;
          data?: string | number | boolean | object;
          error?: string;
        }>;
      }>;
    };
    config?: Record<string, string | number | boolean | null>;
  }>;
}

/**
 * Complete Agent interface with all possible bound methods
 * This reflects what the Agent class actually provides after module binding
 */
export interface IAgentWithModules
  extends IAgent,
    ITaskMethods,
    Partial<IMemoryMethods>,
    Partial<IKnowledgeMethods>,
    Partial<IPluginMethods>,
    Partial<IMCPMethods>,
    Partial<IVisionMethods>,
    Partial<ISubAgentMethods> {}
