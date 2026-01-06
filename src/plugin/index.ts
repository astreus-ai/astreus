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
import { DEFAULT_PLUGIN_CONFIG } from './defaults';
import { ToolError } from '../errors';

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
  private registrationLock: Set<string> = new Set(); // Lock for preventing race conditions

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
        // Wait if another registration is in progress for this tool name
        // Add timeout to prevent infinite busy-wait
        const maxWaitTime = 5000; // 5 seconds max wait
        const startWait = Date.now();
        while (this.registrationLock.has(tool.name)) {
          if (Date.now() - startWait > maxWaitTime) {
            this.logger.error(`Tool registration lock timeout: ${tool.name}`);
            throw new Error(`Tool registration timeout for '${tool.name}': lock held for too long`);
          }
          await new Promise((r) => setTimeout(r, 10));
        }

        // Acquire lock for this tool name
        this.registrationLock.add(tool.name);

        try {
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
        } finally {
          // Release lock
          this.registrationLock.delete(tool.name);
        }
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
      version: plugin?.version ?? DEFAULT_PLUGIN_CONFIG.defaultVersion,
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
      description: tool?.description ?? DEFAULT_PLUGIN_CONFIG.defaultDescription,
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

      // Validate agent is available
      if (!this.agent || typeof this.agent.id !== 'string') {
        this.logger.error('Agent not available for tool execution');
        return {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            success: false,
            error: 'Agent not available for tool execution',
          },
          executionTime: Date.now() - startTime,
        };
      }

      // Create isolated execution context for this tool call
      // This prevents state sharing between plugins and tool calls
      const isolatedContext: ToolContext = {
        // Copy existing context properties if provided
        ...(context || {}),
        // Add execution isolation metadata
        agentId: context?.agentId || this.agent.id,
        agent: context?.agent || this.agent,
        // Add unique execution ID for this specific call
        executionId: `${toolCall.id}-${Date.now()}`,
        // Isolate any shared state by creating fresh copies
        toolName: toolCall.name,
        callTimestamp: new Date(),
      };

      // Execute tool with timeout
      this.logger.debug('Calling tool handler with isolated context', {
        toolName: toolCall.name,
        callId: toolCall.id,
        timeout: DEFAULT_PLUGIN_CONFIG.defaultTimeout,
        executionId: isolatedContext.executionId ?? null,
      });

      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Tool '${toolCall.name}' execution timed out after ${DEFAULT_PLUGIN_CONFIG.defaultTimeout}ms`
            )
          );
        }, DEFAULT_PLUGIN_CONFIG.defaultTimeout);
      });

      let result;
      try {
        result = await Promise.race([
          tool.handler(toolCall.parameters, isolatedContext),
          timeoutPromise,
        ]);
        clearTimeout(timeoutId!);
      } catch (raceError) {
        clearTimeout(timeoutId!);
        throw raceError;
      }
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
        executionId: isolatedContext.executionId ?? null,
      });

      return {
        id: toolCall.id,
        name: toolCall.name,
        result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error('Unknown error occurred');

      // Determine error type based on error characteristics
      let errorType: 'not_found' | 'validation' | 'execution' | 'timeout' | 'unknown' = 'execution';
      if (
        originalError.message.includes('timed out') ||
        originalError.message.includes('timeout')
      ) {
        errorType = 'timeout';
      } else if (
        originalError.message.includes('not found') ||
        originalError.message.includes('not available')
      ) {
        errorType = 'not_found';
      } else if (
        originalError.message.includes('Invalid') ||
        originalError.message.includes('validation')
      ) {
        errorType = 'validation';
      }

      // Determine if error is recoverable
      const recoverable = errorType !== 'not_found';

      // Create normalized ToolError for consistent error handling
      const toolError = new ToolError(
        `Plugin tool '${toolCall.name}' failed: ${originalError.message}`,
        toolCall.name,
        'plugin',
        errorType,
        recoverable,
        originalError
      );

      this.logger.error(`Tool execution failed: ${toolCall.name}`, toolError);
      this.logger.debug('Tool execution error', {
        toolName: toolCall.name,
        callId: toolCall.id,
        executionTime,
        errorType,
        recoverable,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });

      // Return normalized error result
      const errorResult = toolError.toToolResult();
      return {
        id: toolCall.id,
        name: toolCall.name,
        result: {
          success: false,
          error: errorResult.error,
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

    // Validate plugin name
    if (!plugin.name || typeof plugin.name !== 'string' || plugin.name.trim().length === 0) {
      this.logger.debug('Plugin validation failed - invalid name', {
        pluginName: plugin.name ?? DEFAULT_PLUGIN_CONFIG.missingName,
        nameType: typeof plugin.name,
      });
      throw new Error('Plugin must have a valid non-empty name');
    }

    // Validate plugin version
    if (
      !plugin.version ||
      typeof plugin.version !== 'string' ||
      plugin.version.trim().length === 0
    ) {
      this.logger.debug('Plugin validation failed - invalid version', {
        pluginName: plugin.name,
        version: plugin.version ?? DEFAULT_PLUGIN_CONFIG.defaultVersion,
        versionType: typeof plugin.version,
      });
      throw new Error(`Plugin '${plugin.name}' must have a valid non-empty version`);
    }

    // Validate plugin name format (alphanumeric with hyphens/underscores)
    const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    if (!namePattern.test(plugin.name)) {
      this.logger.debug('Plugin validation failed - invalid name format', {
        pluginName: plugin.name,
      });
      throw new Error(
        `Plugin name '${plugin.name}' must start with a letter and contain only alphanumeric characters, hyphens, or underscores`
      );
    }

    if (!Array.isArray(plugin.tools)) {
      this.logger.debug('Plugin validation failed - invalid tools array', {
        pluginName: plugin.name,
        toolsType: typeof plugin.tools,
        isArray: Array.isArray(plugin.tools),
      });
      throw new Error(`Plugin '${plugin.name}' must have tools array`);
    }

    // Check for duplicate tool names within the plugin
    const toolNames = new Set<string>();
    for (const tool of plugin.tools) {
      if (toolNames.has(tool.name)) {
        this.logger.debug('Plugin validation failed - duplicate tool name', {
          pluginName: plugin.name,
          duplicateToolName: tool.name,
        });
        throw new Error(`Plugin '${plugin.name}' has duplicate tool name '${tool.name}'`);
      }
      toolNames.add(tool.name);
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

      if (!tool.name || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        this.logger.debug('Tool validation failed - invalid name', {
          pluginName: plugin.name,
          toolName: tool.name ?? DEFAULT_PLUGIN_CONFIG.missingName,
        });
        throw new Error(`Invalid tool name in plugin '${plugin.name}'`);
      }

      if (!tool.description || typeof tool.description !== 'string') {
        this.logger.debug('Tool validation failed - invalid description', {
          pluginName: plugin.name,
          toolName: tool.name,
        });
        throw new Error(
          `Tool '${tool.name}' in plugin '${plugin.name}' must have a valid description`
        );
      }

      if (!tool.handler || typeof tool.handler !== 'function') {
        this.logger.debug('Tool validation failed - invalid handler', {
          pluginName: plugin.name,
          toolName: tool.name,
          handlerType: typeof tool.handler,
        });
        throw new Error(
          `Tool '${tool.name}' in plugin '${plugin.name}' must have a valid handler function`
        );
      }

      // Validate tool parameters
      if (tool.parameters && typeof tool.parameters === 'object') {
        this.validateToolParameterDefinitions(plugin.name, tool.name, tool.parameters);
      }
    }

    this.logger.debug('Plugin validation successful', {
      pluginName: plugin.name,
      version: plugin.version,
      toolCount: plugin.tools.length,
    });
  }

  private validateToolParameterDefinitions(
    pluginName: string,
    toolName: string,
    parameters: Record<string, ToolParameter>,
    depth: number = 0
  ): void {
    // Prevent stack overflow with depth limit
    const MAX_DEPTH = 50;
    if (depth > MAX_DEPTH) {
      throw new Error(`Parameter nesting too deep in tool '${toolName}' (max depth: ${MAX_DEPTH})`);
    }

    const validTypes = ['string', 'number', 'boolean', 'object', 'array'];

    for (const [paramName, paramDef] of Object.entries(parameters)) {
      if (!paramDef.type || !validTypes.includes(paramDef.type)) {
        this.logger.debug('Parameter validation failed - invalid type', {
          pluginName,
          toolName,
          paramName,
          paramType: paramDef.type,
          validTypes,
        });
        throw new Error(
          `Parameter '${paramName}' in tool '${toolName}' has invalid type '${paramDef.type}'`
        );
      }

      if (!paramDef.description || typeof paramDef.description !== 'string') {
        this.logger.debug('Parameter validation failed - missing description', {
          pluginName,
          toolName,
          paramName,
        });
        throw new Error(`Parameter '${paramName}' in tool '${toolName}' must have a description`);
      }

      // Validate nested object properties
      if (paramDef.type === 'object' && paramDef.properties) {
        this.validateToolParameterDefinitions(pluginName, toolName, paramDef.properties, depth + 1);
      }

      // Validate array items
      if (paramDef.type === 'array' && paramDef.items) {
        if (!validTypes.includes(paramDef.items.type)) {
          this.logger.debug('Parameter validation failed - invalid array items type', {
            pluginName,
            toolName,
            paramName,
            itemsType: paramDef.items.type,
          });
          throw new Error(
            `Array parameter '${paramName}' in tool '${toolName}' has invalid items type`
          );
        }
      }
    }
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
        if (!this.isToolParameterValue(value) || !this.validateParameterType(value, paramDef)) {
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

  private isToolParameterValue(value: unknown, depth: number = 0): value is ToolParameterValue {
    // Prevent stack overflow with depth limit
    const MAX_DEPTH = 50;
    if (depth > MAX_DEPTH) {
      this.logger.warn('Maximum nesting depth exceeded for parameter validation', { depth });
      return false;
    }

    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return true;
    }
    if (Array.isArray(value)) {
      return value.every((item) => this.isToolParameterValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).every((v) =>
        this.isToolParameterValue(v, depth + 1)
      );
    }
    return false;
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

  public convertParametersToJsonSchema(
    parameters: Record<string, ToolParameter>,
    depth: number = 0
  ): LLMToolSchema {
    // Prevent stack overflow with depth limit
    const MAX_DEPTH = 50;
    if (depth > MAX_DEPTH) {
      this.logger.warn('Maximum nesting depth exceeded for JSON schema conversion', { depth });
      return { type: 'object', properties: {}, required: [] };
    }

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
          param.properties,
          depth + 1
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

// Agent-based plugin instances
const pluginInstances = new Map<string, Plugin>();

export function getPlugin(agent?: IAgent): Plugin {
  if (!agent) {
    throw new Error('Agent required for plugin initialization');
  }
  const agentId = agent.id;
  if (!pluginInstances.has(agentId)) {
    pluginInstances.set(agentId, new Plugin(agent));
  }
  return pluginInstances.get(agentId)!;
}

/**
 * Cleanup plugin instance for a specific agent to prevent memory leaks.
 * Should be called when an agent is destroyed or no longer needed.
 * @param agentId - The agent ID to cleanup plugin for.
 */
export async function cleanupPluginForAgent(agentId: string): Promise<void> {
  const plugin = pluginInstances.get(agentId);
  if (plugin) {
    // Unregister all plugins to trigger their cleanup methods
    const plugins = plugin.listPlugins();
    for (const p of plugins) {
      await plugin.unregisterPlugin(p.name);
    }
    pluginInstances.delete(agentId);
  }
}

/**
 * Cleanup plugin instance for a specific agent to prevent memory leaks.
 * Should be called when the plugin manager is no longer needed.
 * @param agentId - The agent ID to cleanup plugin for. If not provided, cleans up all instances.
 */
export async function cleanupPlugin(agentId?: string): Promise<void> {
  if (agentId) {
    await cleanupPluginForAgent(agentId);
  } else {
    // Cleanup all instances
    const agentIds = Array.from(pluginInstances.keys());
    for (const id of agentIds) {
      await cleanupPluginForAgent(id);
    }
  }
}

/**
 * Reset plugin instances (mainly for testing purposes).
 * Performs cleanup before clearing instances to prevent memory leaks.
 * @param agentId - The agent ID to reset plugin for. If not provided, resets all instances.
 */
export async function resetPlugin(agentId?: string): Promise<void> {
  if (agentId) {
    // Cleanup before deleting
    const plugin = pluginInstances.get(agentId);
    if (plugin) {
      const plugins = plugin.listPlugins();
      for (const p of plugins) {
        try {
          await plugin.unregisterPlugin(p.name);
        } catch {
          // Ignore cleanup errors during reset
        }
      }
    }
    pluginInstances.delete(agentId);
  } else {
    // Cleanup all instances before clearing
    for (const [, plugin] of pluginInstances) {
      const plugins = plugin.listPlugins();
      for (const p of plugins) {
        try {
          await plugin.unregisterPlugin(p.name);
        } catch {
          // Ignore cleanup errors during reset
        }
      }
    }
    pluginInstances.clear();
  }
}

export * from './types';

// Export utility function for converting tool parameters to JSON schema
export function convertToolParametersToJsonSchema(
  parameters: Record<string, ToolParameter>,
  depth: number = 0
): LLMToolSchema {
  // Prevent stack overflow with depth limit
  const MAX_DEPTH = 50;
  if (depth > MAX_DEPTH) {
    return { type: 'object', properties: {}, required: [] };
  }

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
      properties[name].properties = convertToolParametersToJsonSchema(
        param.properties,
        depth + 1
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
