/**
 * Core types for the agent system
 */
import { Logger } from '../logger/types';

// Forward declaration for sub-agents - using IAgent interface

export type Constructor<T = object> = new (...args: never[]) => T;

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
        parameters: Record<string, {
          name: string;
          type: 'string' | 'number' | 'boolean' | 'object' | 'array';
          description: string;
          required?: boolean;
        }>;
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