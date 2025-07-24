import { IAgentModule, IAgent } from '../agent/types';
import { 
  Plugin as IPlugin, 
  PluginConfig, 
  PluginManager as IPluginManager,
  ToolDefinition, 
  ToolCall, 
  ToolCallResult, 
  ToolContext,
  ToolParameter,
  ToolParameterValue
} from './types';

// Type for LLM function calling tool schema property
interface LLMToolProperty {
  type: string;
  description?: string;
  enum?: Array<string | number>;
  items?: { type: string; description?: string };
  properties?: Record<string, LLMToolProperty>;
}

// Type for LLM function calling tool schema
interface LLMToolSchema {
  type: string;
  properties: Record<string, LLMToolProperty>;
  required: string[];
}

export class Plugin implements IAgentModule, IPluginManager {
  readonly name = 'plugin';
  private plugins: Map<string, IPlugin> = new Map();
  private configs: Map<string, PluginConfig> = new Map();
  private tools: Map<string, ToolDefinition> = new Map();

  constructor(private agent: IAgent) {}

  async initialize(): Promise<void> {
    // Plugin manager is ready to use immediately
  }

  async registerPlugin(plugin: IPlugin, config?: PluginConfig): Promise<void> {
    // Check if plugin already exists
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' is already registered`);
    }

    // Validate plugin
    this.validatePlugin(plugin);

    // Set default config
    const pluginConfig: PluginConfig = config || {
      name: plugin.name,
      enabled: true
    };

    // Initialize plugin if it has an initialize method
    if (plugin.initialize) {
      await plugin.initialize(pluginConfig.config);
    }

    // Register plugin and its tools
    this.plugins.set(plugin.name, plugin);
    this.configs.set(plugin.name, pluginConfig);

    // Register tools if plugin is enabled
    if (pluginConfig.enabled) {
      for (const tool of plugin.tools) {
        if (this.tools.has(tool.name)) {
          throw new Error(`Tool '${tool.name}' is already registered by another plugin`);
        }
        this.tools.set(tool.name, tool);
      }
    }

    // Plugin registered successfully
  }

  async unregisterPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin '${name}' is not registered`);
    }

    // Remove tools
    for (const tool of plugin.tools) {
      this.tools.delete(tool.name);
    }

    // Cleanup plugin if it has a cleanup method
    if (plugin.cleanup) {
      await plugin.cleanup();
    }

    // Remove plugin
    this.plugins.delete(name);
    this.configs.delete(name);

    // Plugin unregistered successfully
  }

  getPlugin(name: string): IPlugin | undefined {
    return this.plugins.get(name);
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async executeTool(toolCall: ToolCall, context?: ToolContext): Promise<ToolCallResult> {
    const startTime = Date.now();
    
    try {
      const tool = this.getTool(toolCall.name);
      if (!tool) {
        return {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            success: false,
            error: `Tool '${toolCall.name}' not found`
          },
          executionTime: Date.now() - startTime
        };
      }

      // Validate parameters
      const validationError = this.validateToolParameters(tool, toolCall.parameters);
      if (validationError) {
        return {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            success: false,
            error: validationError
          },
          executionTime: Date.now() - startTime
        };
      }

      // Execute tool
      const result = await tool.handler(toolCall.parameters, context);
      
      return {
        id: toolCall.id,
        name: toolCall.name,
        result,
        executionTime: Date.now() - startTime
      };

    } catch (error) {
      return {
        id: toolCall.id,
        name: toolCall.name,
        result: {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        },
        executionTime: Date.now() - startTime
      };
    }
  }

  listPlugins(): IPlugin[] {
    return Array.from(this.plugins.values());
  }

  // Get tools formatted for LLM function calling
  getToolsForLLM(): Array<{ type: string; function: { name: string; description: string; parameters: LLMToolSchema } }> {
    return this.getTools().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.convertParametersToJsonSchema(tool.parameters)
      }
    }));
  }

  private validatePlugin(plugin: IPlugin): void {
    if (!plugin.name || !plugin.version) {
      throw new Error('Plugin must have name and version');
    }

    if (!Array.isArray(plugin.tools)) {
      throw new Error('Plugin must have tools array');
    }

    // Validate each tool
    for (const tool of plugin.tools) {
      if (!tool.name || !tool.description || !tool.handler) {
        throw new Error(`Invalid tool definition in plugin '${plugin.name}'`);
      }
    }
  }

  private validateToolParameters(tool: ToolDefinition, parameters: Record<string, ToolParameterValue>): string | null {
    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      const value = parameters[paramName];
      
      // Check required parameters
      if (paramDef.required && (value === undefined || value === null)) {
        return `Required parameter '${paramName}' is missing`;
      }

      // Type validation
      if (value !== undefined && value !== null) {
        if (!this.validateParameterType(value as ToolParameterValue, paramDef)) {
          return `Parameter '${paramName}' has invalid type. Expected ${paramDef.type}`;
        }
      }
    }

    return null;
  }

  private validateParameterType(value: ToolParameterValue, paramDef: ToolParameter): boolean {
    switch (paramDef.type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      default:
        return false;
    }
  }

  private convertParametersToJsonSchema(parameters: Record<string, ToolParameter>): LLMToolSchema {
    const properties: Record<string, LLMToolProperty> = {};
    
    for (const [name, param] of Object.entries(parameters)) {
      properties[name] = {
        type: param.type,
        description: param.description
      };

      if (param.enum) {
        properties[name].enum = param.enum;
      }

      if (param.properties) {
        properties[name].properties = this.convertParametersToJsonSchema(param.properties).properties;
      }

      if (param.items) {
        properties[name].items = {
          type: param.items.type
        };
      }
    }

    return {
      type: 'object',
      properties,
      required: Object.entries(parameters)
        .filter(([, param]) => param.required)
        .map(([name]) => name)
    };
  }
}

// Global plugin instance
let plugin: Plugin | null = null;

export function getPlugin(agent?: IAgent): Plugin {
  if (!plugin && agent) {
    plugin = new Plugin(agent);
  }
  if (!plugin) {
    throw new Error('Plugin not initialized. Call with agent first.');
  }
  return plugin;
}

export * from './types';