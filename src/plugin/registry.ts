import { PluginConfig, PluginInstance, Plugin } from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";

/**
 * Comprehensive Plugin Registry that handles all plugin-related functionality
 * This class provides both instance-level management for specific agents
 * and static global registry for framework-wide plugin management.
 */
export class PluginRegistry implements PluginInstance {
  public config: PluginConfig;
  private tools: Map<string, Plugin>;

  // Global registry shared across all instances
  private static registry = new Map<string, Plugin>();

  constructor(config: PluginConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "PluginRegistry constructor");
    validateRequiredParams(
      config,
      ["name", "tools"],
      "PluginRegistry constructor"
    );
    
    // Apply defaults for optional fields
    this.config = {
      ...config,
      description: config.description || `Plugin manager for ${config.name}`,
      version: config.version || '1.0.0',
      tools: config.tools || []
    };
    
    this.tools = new Map();

    // Initialize tools
    if (this.config.tools) {
      this.config.tools.forEach((tool) => {
        this.registerTool(tool);
      });
    }
    
    logger.info(`Plugin manager initialized with ${this.tools.size} tools`);
  }

  // ========== Instance methods for managing local tools ==========

  /**
   * Get all tools registered with this instance
   * @returns Array of all registered tools
   */
  getTools(): Plugin[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by name
   * @param name Name of the tool to retrieve
   * @returns Tool if found, undefined otherwise
   */
  getTool(name: string): Plugin | undefined {
    // Validate required parameters
    validateRequiredParam(name, "name", "getTool");
    
    return this.tools.get(name);
  }

  /**
   * Register a tool with this instance
   * Also registers the tool with the global registry
   * @param tool Tool to register
   * @throws Error if the tool is invalid
   */
  registerTool(tool: Plugin): void {
    // Validate required parameters
    validateRequiredParam(tool, "tool", "registerTool");
    
    try {
      // Check that tool has a name and execute method
      if (!tool.name) {
        logger.warn("Cannot register tool: Missing name property");
        return;
      }
      
      if (!tool.execute || typeof tool.execute !== 'function') {
        logger.warn(`Cannot register tool "${tool.name}": Missing execute method`);
        return;
      }
      
      // Register with the instance
      this.tools.set(tool.name, tool);

      // Also register with the global registry
      PluginRegistry.register(tool);
      
      logger.debug(`Tool "${tool.name}" registered successfully`);
    } catch (error) {
      logger.error(`Failed to register tool: ${error}`);
      throw error;
    }
  }

  /**
   * Remove a tool from this instance
   * Also removes the tool from the global registry
   * @param name Name of the tool to remove
   * @returns true if tool was found and removed, false otherwise
   */
  removeTool(name: string): boolean {
    // Validate required parameters
    validateRequiredParam(name, "name", "removeTool");
    
    const removed = this.tools.delete(name);
    
    // Also remove from global registry if it was removed from instance
    if (removed) {
      PluginRegistry.unregister(name);
      logger.debug(`Tool "${name}" removed`);
    }

    return removed;
  }

  /**
   * Check if a tool is registered with this instance
   * @param name Name of the tool to check
   * @returns true if tool is registered, false otherwise
   */
  hasTool(name: string): boolean {
    // Validate required parameters
    validateRequiredParam(name, "name", "hasTool");
    
    return this.tools.has(name);
  }

  /**
   * Get the number of tools registered with this instance
   * @returns Number of tools
   */
  getToolCount(): number {
    return this.tools.size;
  }

  // ========== Static methods for global plugin registry ==========

  /**
   * Register a plugin with the global registry
   * @param plugin Plugin to register
   * @throws Error if the plugin is invalid
   */
  static register(plugin: Plugin): void {
    // Validate required parameters
    validateRequiredParam(plugin, "plugin", "PluginRegistry.register");
    
    try {
      // Check that plugin has a name and execute method
      if (!plugin.name) {
        logger.warn("Cannot register plugin: Missing name property");
        return;
      }
      
      if (!plugin.execute || typeof plugin.execute !== 'function') {
        logger.warn(`Cannot register plugin "${plugin.name}": Missing execute method`);
        return;
      }
      
      this.registry.set(plugin.name, plugin);
      logger.debug(`Plugin "${plugin.name}" registered in global registry`);
    } catch (error) {
      logger.error(`Failed to register plugin in global registry: ${error}`);
      throw error;
    }
  }

  /**
   * Unregister a plugin from the global registry
   * @param name Name of the plugin to unregister
   * @returns true if plugin was found and removed, false otherwise
   */
  static unregister(name: string): boolean {
    // Validate required parameters
    validateRequiredParam(name, "name", "PluginRegistry.unregister");
    
    const result = this.registry.delete(name);
    if (result) {
      logger.debug(`Plugin "${name}" unregistered from global registry`);
    }
    return result;
  }

  /**
   * Get a plugin by name from the global registry
   * @param name Name of the plugin to retrieve
   * @returns Plugin if found, undefined otherwise
   */
  static get(name: string): Plugin | undefined {
    // Validate required parameters
    validateRequiredParam(name, "name", "PluginRegistry.get");
    
    return this.registry.get(name);
  }

  /**
   * Get all plugins from the global registry
   * @returns Array of all registered plugins
   */
  static getAll(): Plugin[] {
    return Array.from(this.registry.values());
  }

  /**
   * Get all plugins for a specific agent
   * @param agentId ID of the agent to get plugins for
   * @returns Array of plugins for the specified agent
   */
  static getByAgent(agentId: string): Plugin[] {
    try {
      // Validate required parameters
      validateRequiredParam(agentId, "agentId", "getByAgent");
      
      // Log what we're doing
      logger.debug(`Getting plugins for agent ${agentId}`);
      logger.debug(`Total plugins in registry: ${this.registry.size}`);
      
      // Do safe access of the registry contents
      const plugins = Array.from(this.registry.values());
      
      // Log each plugin for debugging
      plugins.forEach((plugin, index) => {
        const name = plugin?.name || 'unnamed';
        logger.debug(`Plugin ${index}: ${name}`);
      });
      
      // For now, return all plugins as we don't track agent-plugin relationships
      // In the future, this could be enhanced to track which plugins are used by which agents
      return plugins;
    } catch (error) {
      // Log the error and return empty array
      logger.error(`Error getting plugins for agent ${agentId}:`, error);
      return [];
    }
  }

  /**
   * Reset the global plugin registry
   * Useful for testing or when reloading plugins
   */
  static reset(): void {
    this.registry.clear();
    logger.info("Global plugin registry reset");
  }

  /**
   * Check if a plugin exists in the global registry
   * @param name Name of the plugin to check
   * @returns true if plugin exists, false otherwise
   */
  static has(name: string): boolean {
    // Validate required parameters
    validateRequiredParam(name, "name", "PluginRegistry.has");
    
    return this.registry.has(name);
  }

  /**
   * Get the number of plugins in the global registry
   * @returns Number of plugins
   */
  static count(): number {
    return this.registry.size;
  }

  /**
   * Load a plugin from a repository or object
   * @param pluginOrPath Plugin object or path to a plugin module
   * @returns Promise that resolves when the plugin is loaded and registered
   * @throws Error if loading fails
   */
  static async load(pluginOrPath: string | Plugin): Promise<void> {
    // Validate required parameters
    validateRequiredParam(pluginOrPath, "pluginOrPath", "PluginRegistry.load");
    
    try {
      if (typeof pluginOrPath === "string") {
        // This is a path to a plugin module
        try {
          // Dynamic import
          const module = await import(pluginOrPath);
          const plugin = module.default || module;

          if (plugin && typeof plugin === 'object') {
            this.register(plugin);
            logger.info(`Plugin loaded from path: ${pluginOrPath}`);
          } else {
            const error = `Plugin module at ${pluginOrPath} does not export a valid plugin`;
            logger.warn(error);
            throw new Error(error);
          }
        } catch (error) {
          logger.error(`Failed to load plugin from ${pluginOrPath}:`, error);
          throw error;
        }
      } else if (pluginOrPath && typeof pluginOrPath === 'object') {
        // This is a plugin object
        this.register(pluginOrPath);
        logger.info(`Plugin "${pluginOrPath.name}" loaded directly`);
      } else {
        throw new Error('Invalid plugin format');
      }
    } catch (error) {
      logger.error("Error loading plugin:", error);
      throw error;
    }
  }

  /**
   * Load multiple plugins at once
   * @param plugins Array of plugin objects or paths
   * @returns Promise that resolves when all plugins are loaded
   * @throws Error if loading any plugin fails
   */
  static async loadMany(plugins: Array<string | Plugin>): Promise<void> {
    // Validate required parameters
    validateRequiredParam(plugins, "plugins", "PluginRegistry.loadMany");
    
    try {
      await Promise.all(plugins.map((plugin) => this.load(plugin)));
      logger.info(`Loaded ${plugins.length} plugins`);
    } catch (error) {
      logger.error("Error loading multiple plugins:", error);
      throw error;
    }
  }

  /**
   * Create a new PluginRegistry instance
   * @param config Configuration for the plugin manager
   * @returns New PluginRegistry instance
   */
  static create(config: PluginConfig): PluginInstance {
    // Validate required parameters
    validateRequiredParam(config, "config", "PluginRegistry.create");
    validateRequiredParams(
      config,
      ["name", "tools"],
      "PluginRegistry.create"
    );
    
    return new PluginRegistry(config);
  }
}