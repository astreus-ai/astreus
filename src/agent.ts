import { v4 as uuidv4 } from "uuid";
import { AgentConfig, AgentInstance, AgentFactory, Plugin, ProviderMessage, MemoryEntry, TaskManagerInstance, TaskConfig, TaskResult, ProviderModel, MemoryInstance } from "./types";
import { createDatabase } from "./database";
import { Embedding } from "./providers";
import { createTaskManager } from "./tasks";
import { PluginManager } from "./plugin";
import { validateRequiredParams, validateRequiredParam } from "./utils/validation";
import { logger } from "./utils/logger";

// Agent implementation
class Agent implements AgentInstance {
  public id: string;
  public config: AgentConfig;
  private memory: MemoryInstance; // Replace any with MemoryInstance
  private tools: Map<string, Plugin>;
  private taskManager: TaskManagerInstance;

  constructor(config: AgentConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Agent constructor");
    validateRequiredParams(
      config,
      ["memory", "name"],
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
      description: config.description || `Agent ${config.name}`,
      tools: config.tools || [],
      plugins: config.plugins || []
    };
    this.memory = config.memory;
    this.tools = new Map();

    // Initialize TaskManager with agent ID and memory
    this.taskManager = createTaskManager({
      agentId: this.id,
      memory: this.memory,
      database: this.config.database
    });

    // Initialize tools if provided
    if (this.config.tools) {
      this.config.tools.forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
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
      const agentsTable = db.getTable("agents");

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

  async chat(
    message: string,
    sessionId?: string,
    userId?: string,
    options?: {
      metadata?: Record<string, unknown>; // Change from any to unknown
      embedding?: number[];
      useTaskSystem?: boolean;
    }
  ): Promise<string> {
    // Validate required parameters
    validateRequiredParam(message, "message", "chat");
    
    // Apply defaults for optional parameters
    const sid = sessionId || "default";
    const messages: ProviderMessage[] = [];
    const opts = {
      metadata: options?.metadata || {},
      embedding: options?.embedding,
      useTaskSystem: options?.useTaskSystem !== false  // Default to true unless explicitly disabled
    };

    // Set the current session ID in the task manager
    this.taskManager.setSessionId(sid);

    // Add message to memory
    await this.memory.add({
      agentId: this.id,
      sessionId: sid,
      userId,
      role: "user",
      content: message,
      metadata: opts.metadata,
      embedding: opts.embedding,
    });

    // Get conversation history
    const history = await this.memory.getBySession(sid);

    // Add system prompt
    if (this.config.systemPrompt) {
      messages.push({
        role: "system",
        content: this.config.systemPrompt,
      });
    }

    // Add conversation history
    history.forEach((entry: MemoryEntry) => {
      messages.push({
        role: entry.role as "system" | "user" | "assistant",
        content: entry.content,
      });
    });

    // Get available tools
    const availableTools = Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // If tools are available, add them to the system message
    if (availableTools.length > 0 && this.config.systemPrompt) {
      // Find the system message
      const systemMessage = messages.find((msg) => msg.role === "system");
      if (systemMessage) {
        // Append tools information to the system message
        systemMessage.content += `\n\nYou have access to the following tools:\n${JSON.stringify(
          availableTools,
          null,
          2
        )}`;
      }
    }

    let response: string;

    // Determine if we should use task-based approach
    if (opts.useTaskSystem && this.tools.size > 0) {
      // First, analyze the message to determine if it requires tasks
      const analysisResponse = await this.getModel().complete([
        ...messages,
        {
          role: "system",
          content: `You are a task planning assistant. Analyze the user's request and determine if it should be broken down into tasks. 
If tasks are needed, format your response as a JSON array with this structure:
[
  {
    "name": "Task name",
    "description": "Detailed description of the task",
    "input": {Any input data for the task}
  }
]
The system will automatically determine which tools and plugins to use based on the task name and description.
If no tasks are needed, respond with "NO_TASKS_NEEDED".`,
        },
      ]);

      // Check if the analysis identified tasks
      if (analysisResponse.includes("[") && analysisResponse.includes("]")) {
        try {
          // Extract JSON array from the response
          const jsonString = analysisResponse.substring(
            analysisResponse.indexOf("["),
            analysisResponse.lastIndexOf("]") + 1
          );

          // Parse the tasks
          const taskConfigs: TaskConfig[] = JSON.parse(jsonString);

          // Create and execute tasks with agent and session IDs
          const taskResults = await this.processTasks(taskConfigs, sid);

          // Generate response based on task results
          response = await this.generateTaskResultResponse(
            taskResults,
            messages
          );
        } catch (error) {
          logger.error("Error processing tasks:", error);
          // Fallback to standard completion if task processing fails
          response = await this.getModel().complete(messages);
        }
      } else {
        // No tasks needed, just complete the response normally
        response = await this.getModel().complete(messages);
      }
    } else {
      // Standard completion without task system
      response = await this.getModel().complete(messages);
    }

    // Generate embedding for assistant response if needed
    let assistantEmbedding: number[] | undefined = undefined;
    const enableEmbeddings = this.memory.config?.enableEmbeddings;

    if (enableEmbeddings && opts.embedding) {
      try {
        assistantEmbedding = await Embedding.generateEmbedding(response);
      } catch (error) {
        logger.warn(
          "Error generating embedding for assistant response:",
          error
        );
      }
    }

    // Add response to memory
    await this.memory.add({
      agentId: this.id,
      sessionId: sid,
      userId,
      role: "assistant",
      content: response,
      metadata: opts.metadata,
      embedding: assistantEmbedding,
    });

    return response;
  }

  /**
   * Process multiple tasks based on user message
   */
  private async processTasks(
    taskConfigs: TaskConfig[],
    sessionId?: string
  ): Promise<Map<string, TaskResult>> {
    // Validate required parameters
    validateRequiredParam(taskConfigs, "taskConfigs", "processTasks");
    
    // Set session ID if provided
    if (sessionId) {
      this.taskManager.setSessionId(sessionId);
    }
    
    // Get the agent's model for tool selection
    const model = this.getModel();

    // Create tasks in the task manager with agent and session IDs
    for (const config of taskConfigs) {
      // Tasks already inherit agent and session IDs from the task manager
      this.taskManager.addExistingTask(config, model);
    }

    // Run all tasks and get results
    return await this.taskManager.run();
  }

  /**
   * Generate a response based on task results
   */
  private async generateTaskResultResponse(
    taskResults: Map<string, TaskResult>,
    conversationMessages: ProviderMessage[]
  ): Promise<string> {
    // Create a summary of task results
    const resultSummary = Array.from(taskResults.entries()).map(
      ([taskId, result]) => {
        return {
          taskId,
          success: result.success,
          output: result.output,
          error: result.error ? result.error.message : undefined,
        };
      }
    );

    // Ask the model to generate a response based on task results
    const response = await this.getModel().complete([
      ...conversationMessages,
      {
        role: "system",
        content: `You are assisting with a task-based workflow. Multiple tasks were executed based on the user's request. 
Here are the results of those tasks:
${JSON.stringify(resultSummary, null, 2)}

Analyze these results and generate a helpful, coherent response to the user that summarizes what was done and the outcome. 
Do not mention that tasks were executed behind the scenes - just provide the information the user needs in a natural way.`,
      },
    ]);

    return response;
  }

  /**
   * Create and add a task to the task manager
   */
  createTask(config: TaskConfig, sessionId?: string) {
    // Validate required parameters
    validateRequiredParam(config, "config", "createTask");
    validateRequiredParams(
      config,
      ["name", "description"],
      "createTask"
    );
    
    // If a task has plugin names that aren't strings, filter them out
    if (config.plugins) {
      const validPlugins = config.plugins.filter(plugin => typeof plugin === 'string');
      if (validPlugins.length !== config.plugins.length) {
        logger.warn(`Filtered out ${config.plugins.length - validPlugins.length} invalid plugins from task config`);
        config.plugins = validPlugins;
      }
    }
    
    // Set the session ID for this task if provided
    if (sessionId) {
      this.taskManager.setSessionId(sessionId);
    }
    
    // Add agent's model to the task config for tool selection
    const model = this.getModel();
    
    // Create the task (agent ID is already set in the task manager)
    return this.taskManager.addExistingTask(config, model);
  }

  /**
   * Get all tasks from the task manager
   */
  getTasks() {
    return this.taskManager.getTasks();
  }

  /**
   * Get tasks for the current agent
   */
  getAgentTasks() {
    return this.taskManager.getTasksByAgent(this.id);
  }

  /**
   * Get tasks for a specific session
   */
  getSessionTasks(sessionId: string) {
    return this.taskManager.getTasksBySession(sessionId);
  }

  /**
   * Run specific tasks or all tasks in the task manager
   */
  async runTasks(taskIds?: string[]) {
    return await this.taskManager.run(taskIds);
  }

  async getHistory(sessionId?: string): Promise<MemoryEntry[]> {
    return await this.memory.getBySession(sessionId || "default");
  }

  async clearHistory(sessionId?: string): Promise<void> {
    return await this.memory.clear(sessionId || "default");
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
}

// Agent factory function
export const createAgent: AgentFactory = async (config: AgentConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createAgent");
  validateRequiredParams(
    config,
    ["memory", "name"],
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