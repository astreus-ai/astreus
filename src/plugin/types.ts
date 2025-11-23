import { MetadataObject } from '../types';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  handler: ToolHandler;
}

/**
 * Primitive values that can be passed as tool parameters
 */
export type ToolParameterPrimitive = string | number | boolean | null;

/**
 * Complex tool parameter value that can contain primitives, arrays, or nested objects
 */
export type ToolParameterValue =
  | ToolParameterPrimitive
  | ToolParameterPrimitive[]
  | { [key: string]: ToolParameterValue };

export interface ToolHandler {
  (params: Record<string, ToolParameterValue>, context?: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  agentId: string; // UUID
  taskId?: string; // UUID
  agent?: {
    hasKnowledge(): boolean;
    searchKnowledge?(
      query: string,
      limit: number,
      threshold: number
    ): Promise<
      Array<{
        content: string;
        metadata: MetadataObject;
        similarity: number;
      }>
    >;
    expandKnowledgeContext?(
      documentId: string, // UUID
      chunkIndex: number,
      expandBefore?: number,
      expandAfter?: number
    ): Promise<string[]>;
  };
  userId?: string;
  metadata?: MetadataObject;
}

export interface ToolResult {
  success: boolean;
  data?: ToolParameterValue;
  error?: string;
  metadata?: MetadataObject;
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, ToolParameterValue>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: ToolResult;
  executionTime: number;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];
  initialize?: (config?: Record<string, ToolParameterValue>) => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface PluginConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, ToolParameterValue>;
}

export interface PluginManager {
  registerPlugin(plugin: Plugin, config?: PluginConfig): Promise<void>;
  unregisterPlugin(name: string): Promise<void>;
  getPlugin(name: string): Plugin | undefined;
  getTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
  executeTool(toolCall: ToolCall, context?: ToolContext): Promise<ToolCallResult>;
  listPlugins(): Plugin[];
}
