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

export interface ToolHandler {
  (params: Record<string, any>, context?: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  agentId: number;
  taskId?: number;
  userId?: string;
  metadata?: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
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
  initialize?: (config?: Record<string, any>) => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface PluginConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, any>;
}

export interface PluginManager {
  registerPlugin(plugin: Plugin, config?: PluginConfig): Promise<void>;
  unregisterPlugin(name: string): Promise<void>;
  getPlugin(name: string): Plugin | undefined;
  getTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
  executeToolCall(toolCall: ToolCall, context?: ToolContext): Promise<ToolCallResult>;
  listPlugins(): Plugin[];
}