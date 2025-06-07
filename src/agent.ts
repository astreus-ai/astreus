import { v4 as uuidv4 } from "uuid";
import { AgentConfig, AgentInstance, AgentFactory, Plugin, ProviderModel, MemoryInstance, ChatInstance } from "./types";
import { createDatabase } from "./database";
import { PluginManager } from "./plugin";
import { validateRequiredParams, validateRequiredParam } from "./utils/validation";
import { logger } from "./utils/logger";
import { createRAGTools } from "./utils/rag-tools";
import { 
  DEFAULT_AGENT_NAME
} from "./constants";

// Agent implementation
class Agent implements AgentInstance {
  public id: string;
  public config: AgentConfig;
  private memory: MemoryInstance; // Replace any with MemoryInstance
  private tools: Map<string, Plugin>;
  private chatManager?: ChatInstance;

  constructor(config: AgentConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Agent constructor");
    validateRequiredParams(
      config,
      ["memory"],  // 'name' is optional now since we have a default
      "Agent constructor"
    );
    
    // Ensure either model or provider is specified
    if (!config.model && !config.provider) {
      throw new Error("Either 'model' or 'provider' must be specified in agent config");
    }
    
    // If provider is given but model is not, use default model from provider
    if (config.provider && !config.model) {
      const defaultModelName = config.provider.getDefaultModel?.() || config.provider.listModels()[0];
      if (defaultModelName) {
        config.model = config.provider.getModel(defaultModelName);
      } else {
        throw new Error("No default model available in provider");
      }
    }
    
    // Ensure we have a model at this point
    if (!config.model) {
      throw new Error("No model could be determined for the agent");
    }
    
    // Set default values for optional parameters
    this.id = config.id || uuidv4();
    this.config = {
      ...config,
      name: config.name || DEFAULT_AGENT_NAME,
      description: config.description || `Agent ${config.name || DEFAULT_AGENT_NAME}`,
      tools: config.tools || [],
      plugins: config.plugins || []
    };
    this.memory = config.memory;
    this.tools = new Map();
    this.chatManager = config.chat;

    // Initialize tools if provided
    if (this.config.tools) {
      this.config.tools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
    }

    // Create RAG tools if RAG instance is provided
    if (this.config.rag) {
      const ragTools = createRAGTools(this.config.rag);
      ragTools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
      logger.debug(`Added ${ragTools.length} RAG tools to agent ${this.config.name}`);
    }

    // Initialize plugins and register their tools if provided
    if (this.config.plugins) {
      for (const plugin of this.config.plugins) {
        // Check if plugin has getTools method (PluginInstance)
        if (plugin && 'getTools' in plugin && typeof plugin.getTools === 'function') {
          const pluginTools = plugin.getTools();
          
          if (pluginTools && Array.isArray(pluginTools)) {
            pluginTools.forEach((tool: Plugin) => {
              if (tool && tool.name) {
                this.tools.set(tool.name, tool);
                // Also register with the global registry
                PluginManager.register(tool);
              }
            });
          }
        } 
        // Check if it's a direct Plugin object
        else if (plugin && 'name' in plugin && plugin.name && 'execute' in plugin) {
          // This is already a tool/plugin, register it directly
          const toolPlugin = plugin as Plugin;
          this.tools.set(toolPlugin.name, toolPlugin);
          PluginManager.register(toolPlugin);
        }
      }
    }

    // Save agent to database
    this.saveToDatabase();
  }

  private async saveToDatabase(): Promise<void> {
    try {
      // Use database from config if provided, otherwise create a new one
      const db = this.config.database || await createDatabase();
      const tableNames = db.getTableNames();
      const agentsTable = db.getTable(tableNames.agents);

      // Check if agent already exists
      const existingAgent = await agentsTable.findOne({ id: this.id });

      if (!existingAgent) {
        // Save new agent
        await agentsTable.insert({
          id: this.id,
          name: this.config.name,
          description: this.config.description || null,
          systemPrompt: this.config.systemPrompt || null,
          modelName: this.config.model?.name || "unknown",
          createdAt: new Date(),
          updatedAt: new Date(),
          configuration: JSON.stringify({
            hasTools: this.tools.size > 0,
            supportsTaskSystem: true,
          }),
        });
        logger.agent(this.config.name, `Agent saved to database with ID: ${this.id}`);
      } else {
        // Update existing agent
        await agentsTable.update(
          { id: this.id },
          {
            name: this.config.name,
            description: this.config.description || null,
            systemPrompt: this.config.systemPrompt || null,
            modelName: this.config.model?.name || "unknown",
            updatedAt: new Date(),
            configuration: JSON.stringify({
              hasTools: this.tools.size > 0,
              supportsTaskSystem: true,
            }),
          }
        );
        logger.agent(this.config.name, `Agent updated in database with ID: ${this.id}`);
      }
    } catch (error) {
      logger.error("Error saving agent to database:", error);
    }
  }

  // Helper method to safely get the model
  private getModel(): ProviderModel {
    if (!this.config.model) {
      throw new Error("No model specified for agent");
    }
    return this.config.model;
  }







  /**
   * Get available tool names
   * @returns Array of tool names available to the agent
   */
  getAvailableTools(): string[] {
    return Array.from(this.tools.keys());
  }

  addTool(tool: Plugin): void {
    // Validate required parameters
    validateRequiredParam(tool, "tool", "addTool");
    validateRequiredParams(
      tool,
      ["name", "description", "execute"],
      "addTool"
    );
    
    this.tools.set(tool.name, tool);
    // Update database when tools change
    this.saveToDatabase();
  }

  /**
   * Get the chat manager instance if available
   */
  getChatManager(): ChatInstance | undefined {
    return this.chatManager;
  }

  /**
   * Set or update the chat manager instance
   */
  setChatManager(chatManager: ChatInstance): void {
    this.chatManager = chatManager;
  }
}

// Agent factory function
export const createAgent: AgentFactory = async (config: AgentConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createAgent");
  validateRequiredParams(
    config,
    ["memory"],
    "createAgent"
  );
  
  // Ensure either model or provider is specified
  if (!config.model && !config.provider) {
    throw new Error("Either 'model' or 'provider' must be specified in agent config");
  }
  
  // Create a new agent instance
  const agent = new Agent(config);

  return agent;
}; 