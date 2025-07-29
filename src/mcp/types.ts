// MCP Types - Clean TypeScript Framework

/**
 * Primitive values that can be used in MCP
 */
export type MCPPrimitive = string | number | boolean | null;

/**
 * Complex MCP values that can contain primitives, arrays, or nested objects
 */
export type MCPValue = 
  | MCPPrimitive
  | MCPPrimitive[]
  | { [key: string]: MCPValue };

/**
 * JSON Schema representation for MCP tools
 */
export type MCPJsonSchema = {
  type: string;
  properties?: Record<string, MCPJsonSchema>;
  items?: MCPJsonSchema;
  required?: string[];
  enum?: Array<string | number>;
  description?: string;
};

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>; // Optional: Override specific env vars (use .env file instead)
  url?: string; // For SSE servers
  cwd?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPJsonSchema;
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, MCPValue>;
}

export interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}

// MCP Server definition for framework usage
export interface MCPServerDefinition extends MCPServerConfig {
  name: string; // Server name for identification
}