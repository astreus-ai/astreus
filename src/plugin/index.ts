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
  ToolParameterValue,
} from './types';
import { Logger } from '../logger/types';

// Type for LLM function calling tool schema property
interface LLMToolProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: Array<string | number>;
  items?: { type: string };
  properties?: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      description?: string;
    }
  >;
}

// Type for LLM function calling tool schema
interface LLMToolSchema {
  type: 'object';
  properties: Record<string, LLMToolProperty>;
  required?: string[];
}

export class Plugin implements IAgentModule, IPluginManager {
  readonly name = 'plugin';
  private plugins: Map<string, IPlugin> = new Map();
  private configs: Map<string, PluginConfig> = new Map();
  private tools: Map<string, ToolDefinition> = new Map();
  private logger: Logger;

  constructor(private agent: IAgent) {
    this.logger = agent.logger;

    // User-facing info log
    this.logger.info('Plugin manager initialized');

    this.logger.debug('Plugin manager initialized', {
      agentId: agent.id,
      agentName: agent.name,
    });
  }

  async initialize(): Promise<void> {
    // User-facing info log
    this.logger.info('Plugin manager ready');

    this.logger.debug('Plugin manager initialization completed');
  }

  async registerPlugin(plugin: IPlugin, config?: PluginConfig): Promise<void> {
    // User-facing info log
    this.logger.info(`Registering plugin: ${plugin.name}`);

    this.logger.debug('Registering plugin', {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      toolCount: plugin.tools.length,
      toolNames: plugin.tools.map((t) => t.name),
      hasConfig: !!config,
      hasInitialize: !!plugin.initialize,
      hasCleanup: !!plugin.cleanup,
    });

    // Check if plugin already exists
    if (this.plugins.has(plugin.name)) {
      this.logger.error(`Plugin already registered: ${plugin.name}`);
      this.logger.debug('Plugin registration failed - already exists', {
        pluginName: plugin.name,
        existingPlugins: Array.from(this.plugins.keys()),
      });
      throw new Error(`Plugin '${plugin.name}' is already registered`);
    }

    // Validate plugin
    this.logger.debug('Validating plugin structure', { pluginName: plugin.name });
    this.validatePlugin(plugin);

    // Set default config
    const pluginConfig: PluginConfig = config || {
      name: plugin.name,
      enabled: true,
    };

    this.logger.debug('Plugin config prepared', {
      pluginName: plugin.name,
      enabled: pluginConfig.enabled,
      hasCustomConfig: !!pluginConfig.config,
    });

    // Initialize plugin if it has an initialize method
    if (plugin.initialize) {
      this.logger.debug('Initializing plugin', { pluginName: plugin.name });
      await plugin.initialize(pluginConfig.config);
      this.logger.debug('Plugin initialized successfully', { pluginName: plugin.name });
    }

    // Register plugin and its tools
    this.plugins.set(plugin.name, plugin);
    this.configs.set(plugin.name, pluginConfig);

    // Register tools if plugin is enabled
    if (pluginConfig.enabled) {
      this.logger.debug('Registering plugin tools', {
        pluginName: plugin.name,
        toolCount: plugin.tools.length,
      });

      for (const tool of plugin.tools) {
        if (this.tools.has(tool.name)) {
          this.logger.error(`Tool name conflict: ${tool.name}`);
          this.logger.debug('Tool registration failed - name conflict', {
            toolName: tool.name,
            pluginName: plugin.name,
            existingTools: Array.from(this.tools.keys()),
          });
          throw new Error(`Tool '${tool.name}' is already registered by another plugin`);
        }
        this.tools.set(tool.name, tool);

        this.logger.debug('Tool registered', {
          toolName: tool.name,
          pluginName: plugin.name,
          description: tool.description,
        });
      }
    } else {
      this.logger.debug('Plugin disabled, tools not registered', {
        pluginName: plugin.name,
        toolCount: plugin.tools.length,
      });
    }

    // User-facing success message
    this.logger.info(`Plugin registered: ${plugin.name} (${plugin.tools.length} tools)`);

    this.logger.debug('Plugin registered successfully', {
      pluginName: plugin.name,
      version: plugin.version,
      toolsRegistered: pluginConfig.enabled ? plugin.tools.length : 0,
      totalPlugins: this.plugins.size,
      totalTools: this.tools.size,
    });
  }

  async unregisterPlugin(name: string): Promise<void> {
    // User-facing info log
    this.logger.info(`Unregistering plugin: ${name}`);

    this.logger.debug('Unregistering plugin', {
      pluginName: name,
      isRegistered: this.plugins.has(name),
    });

    const plugin = this.plugins.get(name);
    if (!plugin) {
      this.logger.error(`Plugin not found: ${name}`);
      this.logger.debug('Plugin unregistration failed - not found', {
        pluginName: name,
        availablePlugins: Array.from(this.plugins.keys()),
      });
      throw new Error(`Plugin '${name}' is not registered`);
    }

    // Remove tools
    const removedTools = [];
    for (const tool of plugin.tools) {
      if (this.tools.has(tool.name)) {
        this.tools.delete(tool.name);
        removedTools.push(tool.name);

        this.logger.debug('Tool unregistered', {
          toolName: tool.name,
          pluginName: name,
        });
      }
    }

    this.logger.debug('Plugin tools removed', {
      pluginName: name,
      removedTools,
      removedCount: removedTools.length,
    });

    // Cleanup plugin if it has a cleanup method
    if (plugin.cleanup) {
      this.logger.debug('Running plugin cleanup', { pluginName: name });
      await plugin.cleanup();
      this.logger.debug('Plugin cleanup completed', { pluginName: name });
    }

    // Remove plugin
    this.plugins.delete(name);
    this.configs.delete(name);

    // User-facing success message
    this.logger.info(`Plugin unregistered: ${name}`);

    this.logger.debug('Plugin unregistered successfully', {
      pluginName: name,
      removedToolCount: removedTools.length,
      remainingPlugins: this.plugins.size,
      remainingTools: this.tools.size,
    });
  }

  getPlugin(name: string): IPlugin | undefined {
    const plugin = this.plugins.get(name);

    this.logger.debug('Plugin lookup', {
      pluginName: name,
      found: !!plugin,
      version: plugin?.version || 'unknown',
    });

    return plugin;
  }

  getTools(): ToolDefinition[] {
    const tools = Array.from(this.tools.values());

    this.logger.debug('Retrieved all tools', {
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
    });

    return tools;
  }

  getTool(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);

    this.logger.debug('Tool lookup', {
      toolName: name,
      found: !!tool,
      description: tool?.description || 'none',
    });

    return tool;
  }

  async executeTool(toolCall: ToolCall, context?: ToolContext): Promise<ToolCallResult> {
    const startTime = Date.now();

    // User-facing info log
    this.logger.info(`Executing tool: ${toolCall.name}`);

    this.logger.debug('Executing tool', {
      toolName: toolCall.name,
      callId: toolCall.id,
      parameters: Object.keys(toolCall.parameters),
      parameterCount: Object.keys(toolCall.parameters).length,
      hasContext: !!context,
    });

    try {
      const tool = this.getTool(toolCall.name);
      if (!tool) {
        this.logger.error(`Tool not found: ${toolCall.name}`);
        this.logger.debug('Tool execution failed - tool not found', {
          toolName: toolCall.name,
          callId: toolCall.id,
          availableTools: Array.from(this.tools.keys()),
        });

        return {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            success: false,
            error: `Tool '${toolCall.name}' not found`,
          },
          executionTime: Date.now() - startTime,
        };
      }

      // Validate parameters
      this.logger.debug('Validating tool parameters', {
        toolName: toolCall.name,
        callId: toolCall.id,
      });

      const validationError = this.validateToolParameters(tool, toolCall.parameters);
      if (validationError) {
        this.logger.error(`Tool parameter validation failed: ${toolCall.name}`);
        this.logger.debug('Tool parameter validation error', {
          toolName: toolCall.name,
          callId: toolCall.id,
          validationError,
          parameters: toolCall.parameters,
        });

        return {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            success: false,
            error: validationError,
          },
          executionTime: Date.now() - startTime,
        };
      }

      // Execute tool
      this.logger.debug('Calling tool handler', {
        toolName: toolCall.name,
        callId: toolCall.id,
      });

      const result = await tool.handler(toolCall.parameters, context);
      const executionTime = Date.now() - startTime;

      // User-facing success message
      this.logger.info(`Tool completed: ${toolCall.name} (${executionTime}ms)`);

      this.logger.debug('Tool execution successful', {
        toolName: toolCall.name,
        callId: toolCall.id,
        executionTime,
        success: result.success,
        hasData: !!result.data,
        hasError: !!result.error,
      });

      return {
        id: toolCall.id,
        name: toolCall.name,
        result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error(`Tool execution failed: ${toolCall.name}`);
      this.logger.debug('Tool execution error', {
        toolName: toolCall.name,
        callId: toolCall.id,
        executionTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });

      return {
        id: toolCall.id,
        name: toolCall.name,
        result: {
          success: false,
          error: errorMessage,
        },
        executionTime,
      };
    }
  }

  listPlugins(): IPlugin[] {
    const plugins = Array.from(this.plugins.values());

    this.logger.debug('Listed plugins', {
      pluginCount: plugins.length,
      pluginNames: plugins.map((p) => p.name),
    });

    return plugins;
  }

  // Get tools formatted for LLM function calling
  getToolsForLLM(): Array<{
    type: string;
    function: { name: string; description: string; parameters: LLMToolSchema };
  }> {
    const tools = this.getTools();
    const llmTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.convertParametersToJsonSchema(tool.parameters),
      },
    }));

    this.logger.debug('Generated LLM tool schemas', {
      toolCount: llmTools.length,
      toolNames: llmTools.map((t) => t.function.name),
    });

    return llmTools;
  }

  private validatePlugin(plugin: IPlugin): void {
    this.logger.debug('Validating plugin structure', {
      pluginName: plugin.name,
      hasName: !!plugin.name,
      hasVersion: !!plugin.version,
      hasTools: Array.isArray(plugin.tools),
      toolCount: Array.isArray(plugin.tools) ? plugin.tools.length : 0,
    });

    if (!plugin.name || !plugin.version) {
      this.logger.debug('Plugin validation failed - missing name or version', {
        pluginName: plugin.name || '[missing]',
        hasName: !!plugin.name,
        hasVersion: !!plugin.version,
      });
      throw new Error('Plugin must have name and version');
    }

    if (!Array.isArray(plugin.tools)) {
      this.logger.debug('Plugin validation failed - invalid tools array', {
        pluginName: plugin.name,
        toolsType: typeof plugin.tools,
        isArray: Array.isArray(plugin.tools),
      });
      throw new Error('Plugin must have tools array');
    }

    // Validate each tool
    for (const tool of plugin.tools) {
      this.logger.debug('Validating tool definition', {
        pluginName: plugin.name,
        toolName: tool.name,
        hasName: !!tool.name,
        hasDescription: !!tool.description,
        hasHandler: !!tool.handler,
      });

      if (!tool.name || !tool.description || !tool.handler) {
        this.logger.debug('Tool validation failed', {
          pluginName: plugin.name,
          toolName: tool.name || '[missing]',
          hasName: !!tool.name,
          hasDescription: !!tool.description,
          hasHandler: !!tool.handler,
        });
        throw new Error(`Invalid tool definition in plugin '${plugin.name}'`);
      }
    }

    this.logger.debug('Plugin validation successful', {
      pluginName: plugin.name,
      version: plugin.version,
      toolCount: plugin.tools.length,
    });
  }

  private validateToolParameters(
    tool: ToolDefinition,
    parameters: Record<string, ToolParameterValue>
  ): string | null {
    this.logger.debug('Validating tool parameters', {
      toolName: tool.name,
      expectedParams: Object.keys(tool.parameters),
      providedParams: Object.keys(parameters),
      parameterCount: Object.keys(parameters).length,
    });

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      const value = parameters[paramName];

      this.logger.debug('Validating parameter', {
        toolName: tool.name,
        paramName,
        paramType: paramDef.type,
        required: !!paramDef.required,
        hasValue: value !== undefined && value !== null,
        valueType: typeof value,
      });

      // Check required parameters
      if (paramDef.required && (value === undefined || value === null)) {
        this.logger.debug('Required parameter missing', {
          toolName: tool.name,
          paramName,
          paramType: paramDef.type,
        });
        return `Required parameter '${paramName}' is missing`;
      }

      // Type validation
      if (value !== undefined && value !== null) {
        if (!this.validateParameterType(value as ToolParameterValue, paramDef)) {
          this.logger.debug('Parameter type validation failed', {
            toolName: tool.name,
            paramName,
            expectedType: paramDef.type,
            actualType: typeof value,
            value: String(value).slice(0, 100), // Truncate long values
          });
          return `Parameter '${paramName}' has invalid type. Expected ${paramDef.type}`;
        }
      }
    }

    this.logger.debug('Tool parameter validation successful', {
      toolName: tool.name,
      validatedParams: Object.keys(tool.parameters).length,
    });

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

  public convertParametersToJsonSchema(parameters: Record<string, ToolParameter>): LLMToolSchema {
    const properties: Record<string, LLMToolProperty> = {};

    for (const [name, param] of Object.entries(parameters)) {
      properties[name] = {
        type: param.type as 'string' | 'number' | 'boolean' | 'object' | 'array',
        description: param.description,
      };

      if (param.enum) {
        properties[name].enum = param.enum;
      }

      if (param.properties) {
        properties[name].properties = this.convertParametersToJsonSchema(
          param.properties
        ).properties;
      }

      if (param.items) {
        properties[name].items = {
          type: param.items.type,
        };
      }
    }

    return {
      type: 'object',
      properties,
      required: Object.entries(parameters)
        .filter(([, param]) => param.required)
        .map(([name]) => name),
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

// Export utility function for converting tool parameters to JSON schema
export function convertToolParametersToJsonSchema(
  parameters: Record<string, ToolParameter>
): LLMToolSchema {
  const properties: Record<string, LLMToolProperty> = {};

  for (const [name, param] of Object.entries(parameters)) {
    properties[name] = {
      type: param.type as 'string' | 'number' | 'boolean' | 'object' | 'array',
      description: param.description,
    };

    if (param.enum) {
      properties[name].enum = param.enum;
    }

    if (param.properties) {
      properties[name].properties = convertToolParametersToJsonSchema(param.properties).properties;
    }

    if (param.items) {
      properties[name].items = {
        type: param.items.type,
      };
    }
  }

  return {
    type: 'object',
    properties,
    required: Object.entries(parameters)
      .filter(([, param]) => param.required)
      .map(([name]) => name),
  };
}
