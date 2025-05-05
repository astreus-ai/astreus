// Tool parameter schema
export interface ToolParameterSchema {
  /** Required: Name of the parameter */
  name: string;
  /** Required: Data type of the parameter */
  type: "string" | "number" | "boolean" | "array" | "object";
  /** Required: Description of the parameter's purpose */
  description: string;
  /** Optional: Whether this parameter is required, defaults to false */
  required?: boolean;
  /** Optional: Default value if parameter is not provided */
  default?: any;
}

// Plugin interface for the agent
export interface Plugin {
  /** Required: Unique name of the plugin */
  name: string;
  /** Required: Description of what the plugin does */
  description: string;
  /** Required: Parameters the plugin accepts */
  parameters: ToolParameterSchema[];
  /** Required: Function to execute the plugin's functionality */
  execute: (params: Record<string, any>) => Promise<any>;
}

// Plugin configuration
export interface PluginConfig {
  /** Required: Name of the plugin manager */
  name: string;
  /** Optional: Description of the plugin manager */
  description?: string;
  /** Optional: Version of the plugin manager */
  version?: string;
  /** Required: Tools to be managed by this plugin manager */
  tools: Plugin[];
}

// Plugin instance
export interface PluginInstance {
  config: PluginConfig;
  getTools(): Plugin[];
  getTool(name: string): Plugin | undefined;
  registerTool(tool: Plugin): void;
  removeTool(name: string): boolean;
}

// Plugin factory function type
export type PluginFactory = (config: PluginConfig) => PluginInstance;
