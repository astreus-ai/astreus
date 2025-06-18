// Tool parameter schema interface for defining plugin parameters
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
  /** Optional: Enumeration of allowed values */
  enum?: string[] | number[] | boolean[];
  /** Optional: Format specification (e.g., "email", "date", "uri") */
  format?: string;
  /** Optional: Items specification for array types */
  items?: ToolParameterSchema;
  /** Optional: Properties specification for object types */
  properties?: Record<string, ToolParameterSchema>;
}

// Core plugin interface that all plugins must implement
export interface Plugin {
  /** Required: Unique name of the plugin */
  name: string;
  /** Required: Description of what the plugin does */
  description: string;
  /** Required: Parameters the plugin accepts */
  parameters: ToolParameterSchema[];
  /** Required: Function to execute the plugin's functionality */
  execute: (params: Record<string, any>) => Promise<any>;
  /** Optional: Version of the plugin */
  version?: string;
  /** Optional: Author of the plugin */
  author?: string;
  /** Optional: Plugin category for organization */
  category?: string;
  /** Optional: Tags for categorization and search */
  tags?: string[];
  /** Optional: Initialization function called when plugin is loaded */
  init?: () => Promise<void>;
  /** Optional: Cleanup function called when plugin is unloaded */
  cleanup?: () => Promise<void>;
}

// Plugin configuration for plugin managers
export interface PluginConfig {
  /** Required: Name of the plugin manager */
  name: string;
  /** Optional: Description of the plugin manager */
  description?: string;
  /** Optional: Version of the plugin manager */
  version?: string;
  /** Required: Tools to be managed by this plugin manager */
  tools: Plugin[];
  /** Optional: Maximum number of concurrent plugin executions */
  maxConcurrency?: number;
  /** Optional: Default timeout for plugin execution in milliseconds */
  defaultTimeout?: number;
}

// Plugin instance interface for managing multiple plugins
export interface PluginInstance {
  /** Plugin manager configuration */
  config: PluginConfig;
  
  /**
   * Get all registered tools/plugins
   * @returns Array of all registered plugins
   */
  getTools(): Plugin[];
  
  /**
   * Get a specific tool/plugin by name
   * @param name Name of the plugin to retrieve
   * @returns Plugin instance or undefined if not found
   */
  getTool(name: string): Plugin | undefined;
  
  /**
   * Register a new tool/plugin
   * @param tool Plugin to register
   */
  registerTool(tool: Plugin): void;
  
  /**
   * Remove a tool/plugin by name
   * @param name Name of the plugin to remove
   * @returns Boolean indicating if the plugin was removed
   */
  removeTool(name: string): boolean;
  
  /**
   * Check if a tool/plugin exists
   * @param name Name of the plugin to check
   * @returns Boolean indicating if the plugin exists
   */
  hasTool(name: string): boolean;
  
  /**
   * Get the number of registered tools/plugins
   * @returns Number of registered plugins
   */
  getToolCount(): number;
  
  /**
   * Execute a plugin by name
   * @param name Name of the plugin to execute
   * @param params Parameters to pass to the plugin
   * @returns Promise resolving to the plugin execution result
   */
  executeTool?(name: string, params: Record<string, any>): Promise<any>;
  
  /**
   * Initialize all registered plugins
   * @returns Promise that resolves when all plugins are initialized
   */
  initializeAll?(): Promise<void>;
  
  /**
   * Cleanup all registered plugins
   * @returns Promise that resolves when all plugins are cleaned up
   */
  cleanupAll?(): Promise<void>;
}

// Plugin factory function type
export type PluginFactory = (config: PluginConfig) => PluginInstance;
