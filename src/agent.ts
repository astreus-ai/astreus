import { v4 as uuidv4 } from "uuid";
import { AgentConfig, AgentInstance, AgentFactory, Plugin, ProviderMessage, MemoryEntry, TaskManagerInstance, TaskConfig, TaskResult, ProviderModel, MemoryInstance, TaskInstance, StructuredCompletionResponse } from "./types";
import { createDatabase } from "./database";
import { Embedding } from "./providers";
import { createTaskManager } from "./tasks";
import { PluginManager } from "./plugin";
import { validateRequiredParams, validateRequiredParam } from "./utils/validation";
import { logger } from "./utils/logger";
import { createRAGTools } from "./utils/rag-tools";
import { 
  DEFAULT_AGENT_NAME, 
  DEFAULT_TEMPERATURE, 
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TASK_CONCURRENCY
} from "./constants";

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

    // Initialize TaskManager with agent ID and memory
    this.taskManager = createTaskManager({
      agentId: this.id,
      memory: this.memory,
      database: this.config.database,
      concurrency: DEFAULT_TASK_CONCURRENCY
    });

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
      temperature?: number;
      maxTokens?: number;
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
      useTaskSystem: options?.useTaskSystem !== false,  // Default to true unless explicitly disabled
      temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS
    };

    // Set the current session ID in the task manager
    this.taskManager.setSessionId(sid);

    // Get conversation history first 
    const history = await this.memory.getBySession(sid);

    // Add message to memory
    await this.memory.add({
      agentId: this.id,
      sessionId: sid,
      userId,
      role: "user",
      content: message,
      metadata: {
        ...opts.metadata,
        timestamp: new Date().toISOString(),
        agentName: this.config.name,
        useTaskSystem: opts.useTaskSystem,
        conversationLength: history.length
      },
      embedding: opts.embedding,
    });

    // Update history with the new message
    const updatedHistory = await this.memory.getBySession(sid);

    // Add system prompt
    if (this.config.systemPrompt) {
      messages.push({
        role: "system",
        content: this.config.systemPrompt,
      });
    }

    // Add conversation history
    updatedHistory.forEach((entry: MemoryEntry) => {
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

    let response: string | StructuredCompletionResponse;

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
      const responseText = typeof analysisResponse === 'string' ? analysisResponse : analysisResponse.content;
      
      if (responseText.includes("[") && responseText.includes("]")) {
        try {
          // Extract JSON array from the response
          const jsonString = responseText.substring(
            responseText.indexOf("["),
            responseText.lastIndexOf("]") + 1
          );

          // Parse the tasks
          const taskConfigs: TaskConfig[] = JSON.parse(jsonString);

          // Create and execute tasks with agent and session IDs
          const taskResults = await this.processTasks(taskConfigs, sid);

          // Generate response based on task results
          const taskResponse = await this.generateTaskResultResponse(
            taskResults,
            messages
          );
          response = taskResponse;
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
      // Regular chat completion
      response = await this.getModel().complete(messages, {
        tools: availableTools.length > 0 ? availableTools : undefined,
        toolCalling: availableTools.length > 0,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens
      });
    }

    // Handle tool execution if the response contains tool calls
    if (typeof response === 'object' && response.tool_calls && Array.isArray(response.tool_calls)) {
      logger.debug(`Agent ${this.id} received ${response.tool_calls.length} tool calls to execute`);
      
      const toolResults = [];
      for (const toolCall of response.tool_calls) {
        try {
          if (toolCall.type === 'function' && toolCall.name) {
            logger.debug(`Executing tool: ${toolCall.name} with arguments:`, toolCall.arguments);
            
            // Find the tool to execute
            const tool = this.tools.get(toolCall.name);
            if (tool && tool.execute) {
              // Execute the tool
              const result = await tool.execute(toolCall.arguments || {});
              
              toolResults.push({
                name: toolCall.name,
                arguments: toolCall.arguments,
                result: result,
                success: true
              });
              
              logger.debug(`Tool ${toolCall.name} executed successfully`);
            } else {
              logger.warn(`Tool ${toolCall.name} not found or not executable`);
              toolResults.push({
                name: toolCall.name,
                arguments: toolCall.arguments,
                error: `Tool ${toolCall.name} not found or not executable`,
                success: false
              });
            }
          }
        } catch (error) {
          logger.error(`Error executing tool ${toolCall.name}:`, error);
          toolResults.push({
            name: toolCall.name,
            arguments: toolCall.arguments,
            error: error instanceof Error ? error.message : String(error),
            success: false
          });
        }
      }
      
      // Generate a final response based on tool results
      if (toolResults.length > 0) {
        try {
          logger.debug(`Generating final response based on ${toolResults.length} tool results`);
          
          const toolResultsMessage = {
            role: "system" as const,
            content: `You called the following tools and got these results:
${toolResults.map(tr => `Tool: ${tr.name}
Arguments: ${JSON.stringify(tr.arguments)}
Result: ${tr.success ? JSON.stringify(tr.result) : 'ERROR: ' + tr.error}`).join('\n\n')}

Based on these tool results, generate a helpful response to the user. Be natural and conversational - don't mention the technical details of the tool calls.`
          };
          
          // Call the model again with the tool results to generate the final response
          const finalResponse = await this.getModel().complete([
            ...messages,
            toolResultsMessage
          ]);
          
          // Update response to the final result
          response = typeof finalResponse === 'string' ? finalResponse : finalResponse.content;
          
          logger.debug(`Generated final response after tool execution: ${response.length} characters`);
        } catch (error) {
          logger.error('Error generating final response from tool results:', error);
          // Fallback to original content plus tool results summary
          const originalContent = typeof response === 'string' ? response : response.content;
          response = `${originalContent}\n\nTool execution completed with ${toolResults.filter(r => r.success).length} successful results.`;
        }
      }
    }

    // Generate embedding for assistant response if needed
    let assistantEmbedding: number[] | undefined = undefined;
    const enableEmbeddings = this.memory.config?.enableEmbeddings;

    if (enableEmbeddings && opts.embedding) {
      try {
        // Convert response to string for embedding generation
        const responseText = typeof response === 'string' ? response : response.content;
        assistantEmbedding = await Embedding.generateEmbedding(responseText);
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
      content: typeof response === 'string' ? response : response.content,
      metadata: {
        ...opts.metadata,
        timestamp: new Date().toISOString(),
        agentName: this.config.name,
        modelUsed: this.config.model?.name,
        taskSystemUsed: opts.useTaskSystem,
        temperature: opts.temperature,
        responseLength: (typeof response === 'string' ? response : response.content).length
      },
      embedding: assistantEmbedding,
    });

    // Return the response (convert to string if it's a structured response)
    return typeof response === 'string' ? response : response.content;
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
    const modelResponse = await this.getModel().complete([
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

    // Convert response to string if it's a structured response
    return typeof modelResponse === 'string' ? modelResponse : modelResponse.content;
  }

  /**
   * Create a task for this agent
   * @param config Task configuration
   * @param sessionId Optional session ID for the task
   * @returns The created task
   */
  async createTask(config: TaskConfig, sessionId?: string): Promise<TaskInstance> {
    // Set agent ID and session ID if not provided
    const taskConfig = {
      ...config,
      agentId: config.agentId || this.id,
      sessionId: config.sessionId || sessionId || "default",
    };

    // Ensure task manager has latest session ID
    if (sessionId) {
      this.taskManager.setSessionId(sessionId);
    }

    // Use agent's model for the task if available
    const model = this.getModel();
    this.taskManager.setProviderModel(model);
    
    // Create the task
    return this.taskManager.createTask(taskConfig);
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

  /**
   * Get filtered chat history from memory
   * @param sessionId Session ID to get history for
   * @param filter Optional filter criteria for memory entries
   * @returns Filtered memory entries
   */
  async getFilteredHistory(
    sessionId?: string, 
    filter?: {
      roles?: string[];
      limit?: number;
      includeMetadata?: boolean;
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<MemoryEntry[]> {
    const sid = sessionId || "default";
    let memories = await this.memory.getBySession(sid);
    
    // Apply role filter if specified
    if (filter?.roles && filter.roles.length > 0) {
      memories = memories.filter(entry => 
        filter.roles!.includes(entry.role)
      );
    }
    
    // Apply date filters if specified
    if (filter?.fromDate) {
      memories = memories.filter(entry => 
        entry.timestamp >= filter.fromDate!
      );
    }
    
    if (filter?.toDate) {
      memories = memories.filter(entry => 
        entry.timestamp <= filter.toDate!
      );
    }
    
    // If not including metadata, remove it from the results
    if (filter?.includeMetadata === false) {
      memories = memories.map(entry => ({
        ...entry,
        metadata: undefined
      }));
    }
    
    // Apply limit if specified
    if (filter?.limit && filter.limit > 0) {
      memories = memories.slice(0, filter.limit);
    }
    
    return memories;
  }

  async clearHistory(sessionId?: string): Promise<void> {
    return await this.memory.clear(sessionId || "default");
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