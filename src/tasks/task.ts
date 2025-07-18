import { v4 as uuidv4 } from "uuid";
import {
  TaskConfig,
  TaskInstance,
  TaskStatus,
  TaskResult,
} from "../types/task";
import { Plugin } from "../types/plugin";
import { PluginRegistry } from "../plugin";
import { createDatabase as _createDatabase, DatabaseInstance } from "../database";
import { MemoryInstance, MemoryEntry, ProviderModel, ProviderMessage, CompletionOptions } from "../types";
import { PersonalityInstance } from "../personality/types";
import { logger } from "../utils";
import { IntentRecognizer } from "../utils/intent";

/**
 * Task class implementing the TaskInstance interface
 */
export class Task implements TaskInstance {
  public id: string;
  public config: TaskConfig;
  public status: TaskStatus;
  public result?: TaskResult;
  public retries: number;
  public plugins: Plugin[];
  public createdAt: Date;
  public startedAt?: Date;
  public completedAt?: Date;
  public agentId?: string;
  public sessionId?: string;
  public contextId?: string;
  public memory?: MemoryInstance;
  public database?: DatabaseInstance;
  public personality?: PersonalityInstance;

  public isCancelled: boolean = false;
  
  // Add a tracking variable to prevent duplicate logging
  private toolSelectionLogged: boolean = false;

  constructor(config: TaskConfig, memory?: MemoryInstance, model?: ProviderModel, database?: DatabaseInstance, personality?: PersonalityInstance) {
    this.id = config.id || uuidv4();
    this.config = {
      ...config,
      model: config.model || model // Use config.model if provided, otherwise use the model parameter
    };
    this.status = "pending";
    this.retries = 0;
    this.plugins = [];
    this.createdAt = new Date();
    this.agentId = config.agentId;
    this.sessionId = config.sessionId;
    this.memory = memory;
    this.database = database;
    this.personality = config.personality || personality;

    // Set context ID based on session ID
    if (this.sessionId) {
      this.contextId = this.sessionId;
    }

    // Load the plugins required for this task (but don't wait in constructor)
    this.loadPlugins(this.config.model).catch(error => {
      logger.error(`Error loading plugins for task ${this.id}:`, error);
    });


  }

  /**
   * Get the combined system prompt with personality
   */
  private getCombinedSystemPrompt(baseSystemPrompt?: string): string {
    const systemPrompt = baseSystemPrompt || '';
    
    if (this.personality) {
      const personalityPrompt = this.personality.getPrompt();
      // Add personality prompt at the beginning if it exists
      if (personalityPrompt) {
        return personalityPrompt + (systemPrompt ? '\n\n' + systemPrompt : '');
      }
    }
    
    return systemPrompt;
  }

  /**
   * Initialize plugins for the task
   * This tries three methods in order:
   * 1. Use LLM-selected tools if model is provided
   * 2. Use keyword matching based on task name
   * 3. Fall back to all agent plugins
   */
  public async loadPlugins(model?: ProviderModel): Promise<void> {
    // Get all available tools
    const allTools = PluginRegistry.getAll();
    
    // Method 1: Get plugins from config first (explicitly provided in task config)
    if (this.config.plugins && this.config.plugins.length > 0) {
      const configPlugins = this.config.plugins
        .map(pluginName => {
          // Check if it's a tool instance already
          if (typeof pluginName === 'object' && 'name' in pluginName) {
            return pluginName as Plugin;
          }
          // Otherwise look it up by name
          return PluginRegistry.get(pluginName as string);
        })
        .filter(Boolean) as Plugin[];
      
      if (configPlugins.length > 0) {
        if (!this.toolSelectionLogged) {
          logger.debug(this.config.name || "Task", "Plugin", `Using ${configPlugins.length} plugins from task config`);
          this.toolSelectionLogged = true;
        }
        this.plugins = configPlugins;
        return; 
      }
    }
    
    // Method 2: Use LLM to select appropriate tools if model is provided
    if (model) {
      try {
        logger.debug(this.config.name || "Task", "Plugin", "Using LLM to select tools for task");
        
        // Request tools with IntentRecognizer
        const selectedTools = await IntentRecognizer.recognizeIntent(
          this.config.name,
          this.config.description || this.config.name,
          allTools,
          model
        );
        
        if (selectedTools.length > 0) {
          if (!this.toolSelectionLogged) {
            logger.debug(this.config.name || "Task", "Plugin", `LLM selected tools: ${selectedTools.map(t => t.name).join(', ')}`);
            this.toolSelectionLogged = true;
          }
          this.plugins = selectedTools;
          // Save plugins to config to avoid duplicate selection
          this.config.plugins = selectedTools.map(t => t.name);
          return;
        } else {
          logger.warn(`LLM did not select any tools for task "${this.config.name}", falling back to default`);
        }
      } catch (error) {
        logger.error(`Error using LLM for tool selection: ${error}`);
        // Fall back to default method
      }
    }
    
    logger.warn(`No plugins selected for task "${this.config.name}"`);
  }



  /**
   * Execute the task using configured plugins
   */
  async execute(input?: any): Promise<TaskResult> {
    // Database operations are handled in createTask static method

    // Add debug logging - Task execution start
    logger.debug(`Task ${this.id} (${this.config.name}) execution started with input:`, 
      JSON.stringify(input || this.config.input));
      
    // Record task execution start in memory
    await this.addTaskMemoryEntry(`Task execution started: ${this.config.name}`, "task_event");

    // Use provided input or fallback to config input
    const taskInput: Record<string, unknown> = input || this.config.input;

    try {
      // Make sure plugins are loaded before starting the task
      if (!this.plugins || this.plugins.length === 0) {
        await this.loadPlugins(this.config.model);
      }
      
      // Skip execution if task is cancelled
      if (this.isCancelled) {
        throw new Error("Task was cancelled");
      }

      // Update status only after plugins are loaded
      this.status = "running";
      this.startedAt = new Date();

      // Get task context from previous tasks in the same session
      let taskContext = {};
      if (this.sessionId) {
        taskContext = await this.getTaskContext(this.sessionId);
      }

      // Merge task input with the accumulated context
      const enrichedInput: Record<string, unknown> = {
        ...taskInput,
        _context: taskContext,
      };
      
      // Log the enriched input at debug level
      logger.debug(`Task ${this.id} enriched input:`, JSON.stringify(enrichedInput));

      // Execute plugins with the input
      let currentOutput: Record<string, unknown> = enrichedInput;
      
      // Ensure plugins array is valid before proceeding
      if (!this.plugins || !Array.isArray(this.plugins)) {
        this.plugins = [];
      }
      
      logger.debug(`Task ${this.id} has ${this.plugins.length} plugins to execute`);
      
      // Record available plugins in memory
      if (this.plugins.length > 0) {
        await this.addTaskMemoryEntry(
          `Available plugins: ${this.plugins.map(p => p.name).join(", ")}`, 
          "task_event"
        );
      }

      // Use the plugins as they are
      const prioritizedPlugins = [...this.plugins];

      // Check if we have plugins to execute
      if (prioritizedPlugins.length === 0) {
        logger.warn(`Task ${this.id} has no plugins to execute, the task may not complete as expected`);
      }

      // Use model to execute the task with the plugins if available
      const model = this.config.model;
      if (model && prioritizedPlugins.length > 0) {
        logger.debug(this.config.name || "Task", "Execution", `Using model ${model.name} to execute with plugins`);
        
        // Record model usage in memory
        await this.addTaskMemoryEntry(
          `Using model ${model.name} to execute task with plugins`, 
          "task_event"
        );
        
        // Format tools for the model - convert Astreus tool format to provider tool format
        const formattedTools = prioritizedPlugins.map(tool => {
          // Convert parameters to proper format for provider
          let formattedParameters = {};
          
          if (tool.parameters && Array.isArray(tool.parameters)) {
            // Convert array of parameter objects to JSON Schema properties
            const properties: Record<string, any> = {};
            const required: string[] = [];
            
            tool.parameters.forEach(param => {
              if (param.name && param.type) {
                properties[param.name] = {
                  type: param.type,
                  description: param.description || `Parameter ${param.name}`
                };
                
                if (param.required) {
                  required.push(param.name);
                }
              }
            });
            
            // Create proper JSON Schema
            formattedParameters = {
              type: "object",
              properties: properties
            };
            
            // Add required array if there are required parameters
            if (required.length > 0) {
              formattedParameters = {
                ...formattedParameters,
                required: required
              };
            }
          } else if (tool.parameters) {
            // Use parameters as-is if not an array
            formattedParameters = tool.parameters;
          }
          
          return {
            name: tool.name,
            description: tool.description || "",
            parameters: formattedParameters
          };
        });
        
        // Create messages for the model
        const messages: ProviderMessage[] = [
          {
            role: "user",
            content: `Complete this task: ${this.config.name}
${this.config.description ? `Description: ${this.config.description}` : ''}
Input: ${JSON.stringify(enrichedInput)}`
          }
        ];
        
        // Let the model generate a response using the tools
        try {
          // Create the base system message
          const baseSystemMessage = `You are an AI assistant that can use tools to complete tasks.
Complete this task: ${this.config.name}
${this.config.description ? `Description: ${this.config.description}` : ''}

Available tools:
${prioritizedPlugins.map(tool => `- ${tool.name}: ${tool.description || 'No description provided'}`).join('\n')}

Use the available tools to fulfill this task effectively. When a tool should be used, call it with appropriate parameters.`;

          // Get the combined system message with personality
          const systemMessage = this.getCombinedSystemPrompt(baseSystemMessage);

          // Log formatted tools for debugging
          logger.debug(`Task ${this.id} using ${formattedTools.length} tools with model ${model.name}`, {
            toolNames: formattedTools.map(t => t.name).join(', ')
          });

          // If the tools have parameters with improper formats, log them for debugging
          const toolsWithPotentialIssues = formattedTools.filter(tool => {
            const params = tool.parameters;
            return !params || (typeof params === 'object' && Object.keys(params).length === 0);
          });

          if (toolsWithPotentialIssues.length > 0) {
            logger.warn(`Task ${this.id} has tools with potential parameter format issues:`, 
              toolsWithPotentialIssues.map(t => t.name).join(', '));
          }

          // Call the model with messages and completion options
          const completionOptions: CompletionOptions = {
            tools: formattedTools,
            toolCalling: true,
            systemMessage: systemMessage
          };
          
          logger.debug(`Task ${this.id} calling model with ${messages.length} messages and ${formattedTools.length} tools`);
          const completion = await model.complete(messages, completionOptions);
          
          // Check if completion is a structured object with tool calls
          if (typeof completion === 'object' && completion.tool_calls && Array.isArray(completion.tool_calls)) {
            logger.debug(`Task ${this.id} received structured tool calls response`);
            
            const toolCalls = completion.tool_calls;
            logger.info(`Task ${this.id} response includes ${toolCalls.length} tool calls:`);
            
            // Log tool calls and execute them
            const toolResults = [];
            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
                              if (call.type === 'function' && call.name) {
                logger.info(`Tool call ${i + 1}: ${call.name} with arguments: ${JSON.stringify(call.arguments)}`);
                
                // Record tool call in memory
                await this.addTaskMemoryEntry(
                  `Tool call: ${call.name} with arguments: ${JSON.stringify(call.arguments)}`,
                  "task_tool"
                );
                
                // Find the tool to execute
                const tool = prioritizedPlugins.find(t => t.name === call.name);
                if (tool && typeof tool.execute === 'function') {
                  try {
                    logger.info(`Executing tool ${call.name}...`);
                    const result = await tool.execute({
                      ...enrichedInput,
                      ...call.arguments
                    });
                    toolResults.push({
                      name: call.name,
                      arguments: call.arguments,
                      result
                    });
                    logger.info(`Tool ${call.name} executed successfully`);
                    
                    // Record successful tool execution in memory
                    await this.addTaskMemoryEntry(
                      `Tool ${call.name} executed successfully`,
                      "task_result",
                      { toolName: call.name, success: true }
                    );
                  } catch (error) {
                    logger.error(`Error executing tool ${call.name}:`, error);
                    toolResults.push({
                      name: call.name,
                      arguments: call.arguments,
                      error: error instanceof Error ? error.message : `Error: ${error}`
                    });
                    
                    // Record tool execution error in memory
                    await this.addTaskMemoryEntry(
                      `Tool ${call.name} execution failed: ${error instanceof Error ? error.message : error}`,
                      "task_result",
                      { toolName: call.name, success: false }
                    );
                  }
                } else {
                  logger.warn(`Tool ${call.name} not found or has no execute method`);
                  toolResults.push({
                    name: call.name,
                    arguments: call.arguments,
                    error: `Tool ${call.name} not found or has no execute method`
                  });
                  
                  // Record tool not found in memory
                  await this.addTaskMemoryEntry(
                    `Tool ${call.name} not found or has no execute method`,
                    "task_result",
                    { toolName: call.name, success: false }
                  );
                }
              }
            }
            
            // Generate a response based on tool results
            if (toolResults.length > 0) {
              try {
                logger.info(`Generating response based on ${toolResults.length} tool results`);
                const resultsMessage: ProviderMessage = {
                  role: "system",
                  content: `The following tools were called based on the user's request:
${toolResults.map(tr => `Tool: ${tr.name}
Arguments: ${JSON.stringify(tr.arguments)}
Result: ${tr.error ? 'ERROR: ' + tr.error : JSON.stringify(tr.result)}`).join('\n\n')}

Please analyze these results and generate a helpful, coherent response to the user that summarizes what was done and the outcome.
Do not mention the technical details of the tool calls - just provide a natural, conversational response about what was accomplished.`
                };
                
                // Call the model again with the results
                const summaryResponse = await model.complete([
                  ...messages,
                  resultsMessage
                ]);
                
                // Use the summary response as content
                const summaryContent = typeof summaryResponse === 'string' 
                  ? summaryResponse 
                  : summaryResponse.content;
                
                // Add both the summary and the raw results
                currentOutput = {
                  ...enrichedInput,
                  content: summaryContent,
                  summary: summaryContent,
                  tool_calls: toolCalls,
                  tool_results: toolResults,
                  tools_used: prioritizedPlugins.map(t => t.name)
                };
              } catch (error) {
                logger.error(`Error generating summary from tool results:`, error);
                // Fall back to standard output without summary
                currentOutput = {
                  ...enrichedInput,
                  content: completion.content || '',
                  tool_calls: toolCalls,
                  tool_results: toolResults,
                  tools_used: prioritizedPlugins.map(t => t.name)
                };
              }
            } else {
              // No tools were successfully executed
              currentOutput = {
                ...enrichedInput,
                content: completion.content || '',
                tool_calls: toolCalls,
                tool_results: toolResults,
                tools_used: prioritizedPlugins.map(t => t.name)
              };
            }
          }
          // Handle text-based tool calls (for older models)
          else if (typeof completion === 'string' && completion.includes('Tool Call:')) {
            logger.debug(`Task ${this.id} model response received, length: ${completion.length} chars (text format)`);
            
            // Extract and log tool calls for better debugging
            const toolCallMatches = completion.match(/Tool Call: ([^\n]+)[\s\S]*?Arguments: ({[\s\S]*?})(?=\n\n|\n?$)/g);
            if (toolCallMatches && toolCallMatches.length > 0) {
              logger.info(`Task ${this.id} response includes ${toolCallMatches.length} tool calls (text format):`);
              
              // Execute each tool call
              const toolResults = [];
              const parsedCalls = [];
              for (let i = 0; i < toolCallMatches.length; i++) {
                const match = toolCallMatches[i];
                const toolName = match.match(/Tool Call: ([^\n]+)/)?.[1];
                const argsMatch = match.match(/Arguments: (.*?)(?=\n\n|\n?$)/s);
                const argsString = argsMatch ? argsMatch[1] : '{}';
                
                logger.info(`Tool call ${i + 1}: ${toolName} with arguments: ${argsString}`);
                
                if (toolName) {
                  // Parse arguments
                  let args = {};
                  try {
                    args = JSON.parse(argsString);
                  } catch (err) {
                    logger.warn(`Failed to parse arguments for tool ${toolName}: ${err}`);
                  }
                  
                  parsedCalls.push({
                    name: toolName,
                    arguments: args
                  });
                  
                  // Find and execute the tool
                  const tool = prioritizedPlugins.find(t => t.name === toolName);
                  if (tool && typeof tool.execute === 'function') {
                    try {
                      logger.info(`Executing tool ${toolName}...`);
                      const result = await tool.execute({
                        ...enrichedInput,
                        ...args
                      });
                      toolResults.push({
                        name: toolName,
                        arguments: args,
                        result
                      });
                      logger.info(`Tool ${toolName} executed successfully`);
                    } catch (error) {
                      logger.error(`Error executing tool ${toolName}:`, error);
                      toolResults.push({
                        name: toolName,
                        arguments: args,
                        error: error instanceof Error ? error.message : `Error: ${error}`
                      });
                    }
                  } else {
                    logger.warn(`Tool ${toolName} not found or has no execute method`);
                    toolResults.push({
                      name: toolName,
                      arguments: args,
                      error: `Tool ${toolName} not found or has no execute method`
                    });
                  }
                }
              }
              
              // Generate a response based on tool results
              if (toolResults.length > 0) {
                try {
                  logger.info(`Generating response based on ${toolResults.length} tool results`);
                  const resultsMessage: ProviderMessage = {
                    role: "system",
                    content: `The following tools were called based on the user's request:
${toolResults.map(tr => `Tool: ${tr.name}
Arguments: ${JSON.stringify(tr.arguments)}
Result: ${tr.error ? 'ERROR: ' + tr.error : JSON.stringify(tr.result)}`).join('\n\n')}

Please analyze these results and generate a helpful, coherent response to the user that summarizes what was done and the outcome.
Do not mention the technical details of the tool calls - just provide a natural, conversational response about what was accomplished.`
                  };
                  
                  // Call the model again with the results
                  const summaryResponse = await model.complete([
                    ...messages,
                    resultsMessage
                  ]);
                  
                  // Use the summary response
                  const summaryContent = typeof summaryResponse === 'string' 
                    ? summaryResponse 
                    : summaryResponse.content;
                  
                  // Include both the summary and the raw results
                  currentOutput = {
                    ...enrichedInput,
                    content: summaryContent,
                    summary: summaryContent,
                    result: completion,
                    tool_calls: parsedCalls,
                    tool_results: toolResults,
                    tools_used: prioritizedPlugins.map(t => t.name)
                  };
                } catch (error) {
                  logger.error(`Error generating summary from tool results:`, error);
                  // Fall back to standard output without summary
                  currentOutput = {
                    ...enrichedInput,
                    result: completion,
                    tool_calls: parsedCalls,
                    tool_results: toolResults,
                    tools_used: prioritizedPlugins.map(t => t.name)
                  };
                }
              } else {
                // No tools were successfully executed
                currentOutput = {
                  ...enrichedInput,
                  result: completion,
                  tool_calls: parsedCalls,
                  tool_results: toolResults,
                  tools_used: prioritizedPlugins.map(t => t.name)
                };
              }
            } else {
              logger.info(`Task ${this.id} response appears to include tool calls but format could not be parsed`);
              
              // Just pass through the response
              currentOutput = {
                ...enrichedInput,
                result: completion,
                tools_used: prioritizedPlugins.map(t => t.name)
              };
            }
          } else {
            // No tool calls detected
            logger.debug(`Task ${this.id} model response received, length: ${typeof completion === 'string' ? completion.length : JSON.stringify(completion).length} chars`);
            logger.warn(`Task ${this.id} response does not include tool calls, the model may not be using the tools properly`);
            
            // Use the response as-is
            currentOutput = {
              ...enrichedInput,
              result: completion,
              tools_used: prioritizedPlugins.map(t => t.name)
            };
          }
          
          logger.debug(`Model execution completed for task ${this.id}`);
        } catch (error) {
          logger.error(`Error executing task with model: ${error}`);
          throw error;
        }
      } else {
        // No model or no plugins, execute plugins sequentially
        logger.debug(`Task ${this.id} using sequential plugin execution (${prioritizedPlugins.length} plugins)`);
        let pluginOutput: unknown = null;
        
        // Execute each plugin in sequence
        for (const plugin of prioritizedPlugins) {
          if (this.isCancelled) {
            throw new Error("Task was cancelled during execution");
          }

          if (!plugin) {
            logger.warn("Encountered null or undefined plugin, skipping");
            continue;
          }

          if (plugin.execute) {
            const pluginName = plugin.name || "unnamed_plugin";
            logger.debug(`Executing plugin '${pluginName}' with input:`, JSON.stringify(currentOutput));
            try {
              // Execute the plugin with the current input/output chain
              pluginOutput = await plugin.execute(currentOutput);
              logger.debug(`Plugin '${pluginName}' returned:`, JSON.stringify(pluginOutput));
              
              // Update currentOutput with plugin's output, not the entire input
              if (pluginOutput !== undefined && pluginOutput !== null) {
                // If plugin returns a value, use it as the new current output
                currentOutput = pluginOutput as Record<string, unknown>;
                logger.debug(`Updated currentOutput with plugin result:`, JSON.stringify(currentOutput));
              } else {
                logger.debug(`Plugin returned undefined/null, keeping previous output`);
              }
              // If plugin returns undefined/null, keep the previous output
            } catch (error) {
              logger.error(`Error executing plugin '${pluginName}':`, error);
              throw error;
            }
          } else {
            const pluginName = plugin.name || "unnamed_plugin";
            logger.warn(
              `Plugin '${pluginName}' does not have an execute method`
            );
          }
        }
      }

      // The final output is the result from execution
      const finalOutput = currentOutput;
      
      // Only show the final output at debug level
      logger.debug(`Task ${this.id} final output:`, JSON.stringify(finalOutput));
      
      // Strip _context from the output if it got added by the enriched input
      if (finalOutput && typeof finalOutput === 'object' && '_context' in finalOutput) {
        const { _context, ...strippedOutput } = finalOutput;
        // Use _context to prevent unused variable warning
        logger.debug(`Context data size: ${JSON.stringify(_context).length} bytes`);
        
        // Only replace if there are other properties beyond _context
        if (Object.keys(strippedOutput).length > 0) {
          currentOutput = strippedOutput as Record<string, unknown>;
          logger.debug(`Stripped _context, new output:`, JSON.stringify(currentOutput));
        } else {
          logger.debug(`After stripping _context, no other properties found, keeping original`);
        }
      }

      // Update the context with this task's output
      if (this.sessionId) {
        taskContext = {
          ...taskContext,
          [this.config.name]: currentOutput,
          lastTaskOutput: currentOutput,
        };
        // Store updated context in memory system
        await this.saveTaskContext(this.sessionId, taskContext);
      }

      // Set result and update status
      this.result = {
        success: true,
        output: currentOutput,
        context: taskContext,
      };
      
      logger.debug(`Task ${this.id} completed successfully`);
        
      this.completedAt = new Date();
      if (this.result.success) {
        this.status = "completed";
        logger.info(this.config.name || "Task", "Execution", `Task ${this.status}: ${this.config.name}`);
        
        // Record task completion in memory
        await this.addTaskMemoryEntry(
          `Task completed successfully: ${this.config.name}`, 
          "task_event",
          { output: JSON.stringify(currentOutput).slice(0, 500) } // Limit size of stored output
        );
      } else {
        this.status = "failed";
        logger.info(this.config.name || "Task", "Execution", `Task ${this.status}: ${this.result.error}`);
        
        // Record task failure in memory
        await this.addTaskMemoryEntry(
          `Task failed: ${this.config.name}`, 
          "task_event"
        );
      }

      return this.result as TaskResult;
    } catch (error) {
      this.status = "failed";
      this.completedAt = new Date();
      this.result = {
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };

      logger.error(this.config.name || "Task", "Execution", `Task ${this.status}: ${error}`);
      
      return this.result as TaskResult;
    }
  }

  /**
   * Get task context from memory using session ID
   */
  public async getTaskContext(sessionId: string): Promise<Record<string, unknown>> {
    try {
      // Use the memory system if available
      if (this.memory) {
        // Get the task context memories from session
        const memories = await this.memory.getBySession(sessionId);

        // Find the most recent task context memory
        const contextMemories = memories.filter(
          (m) => m.role === "task_context"
        );

        if (contextMemories.length > 0) {
          // Sort by timestamp descending and get most recent
          contextMemories.sort(
            (a, b) => {
              // Ensure timestamps are Date objects or convert them
              const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
              const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
              return bTime - aTime;
            }
          );

          // Extract the context data from memory content
          try {
            return JSON.parse(contextMemories[0].content);
          } catch (parseError) {
            logger.error(
              `Error parsing task context data for session ${sessionId}:`,
              parseError
            );
            return {};
          }
        }
      }

      return {};
    } catch (error) {
      logger.error(
        `Error retrieving task context for session ${sessionId}:`,
        error
      );
      return {};
    }
  }

  /**
   * Save task context to memory system
   */
  public async saveTaskContext(
    sessionId: string,
    contextData: Record<string, unknown>
  ): Promise<void> {
    try {
      // Only save if memory system is available
      if (this.memory) {
        // Serialize the context data
        const serializedData = JSON.stringify(contextData);

        // Store in memory with role=task_context
        await this.memory.add({
          agentId: this.agentId || "system",
          sessionId: sessionId,
          userId: "",
          role: "task_context",
          content: serializedData,
          metadata: {
            taskId: this.id,
            taskName: this.config.name,
            contextType: "task_execution_context",
          },
        });
      } else {
        logger.warn(
          `Memory system not available for task ${this.id}, skipping context save`
        );
      }
    } catch (error) {
      logger.error(
        `Error saving task context for session ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Cancel the task execution
   */
  cancel(): void {
    this.isCancelled = true;
    if (this.status === "pending" || this.status === "running") {
      this.status = "failed";
      this.result = {
        success: false,
        error: new Error("Task was cancelled"),
      };

    }
  }

  /**
   * Set the memory instance for this task
   */
  setMemory(memory: MemoryInstance): void {
    this.memory = memory;
  }

  /**
   * Get memory entries specific to this task
   * @returns Promise that resolves to an array of task-specific memory entries
   */
  public async getTaskMemory(): Promise<MemoryEntry[]> {
    if (!this.memory || !this.sessionId) {
      return [];
    }
    
    try {
      // Get all memories for this session
      const memories = await this.memory.getBySession(this.sessionId);
      
      // Filter for memories related to this task
      return memories.filter(memory => 
        memory.metadata && 
        typeof memory.metadata === 'object' &&
        'taskId' in memory.metadata &&
        memory.metadata.taskId === this.id
      );
    } catch (error) {
      logger.error(`Error getting task memory for task ${this.id}:`, error);
      return [];
    }
  }

  /**
   * Add a memory entry for this task
   * @param content Content of the memory entry
   * @param role Role for the memory entry (task_event, task_tool, task_result)
   * @param additionalMetadata Additional metadata to include
   * @returns Promise that resolves when the memory is added
   */
  public async addTaskMemoryEntry(
    content: string, 
    role: "task_event" | "task_tool" | "task_result" = "task_event",
    additionalMetadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!this.memory || !this.sessionId) {
      return;
    }
    
    try {
      await this.memory.add({
        agentId: this.agentId || "system",
        sessionId: this.sessionId,
        userId: "",
        role: role,
        content: content,
        metadata: {
          taskId: this.id,
          taskName: this.config.name,
          taskStatus: this.status,
          ...additionalMetadata
        }
      });
      logger.debug(`Added task memory entry for task ${this.id}: ${role}`);
    } catch (error) {
      logger.error(`Error adding task memory for task ${this.id}:`, error);
    }
  }

  /**
   * Create a new task asynchronously
   */
  static async createTask(
    config: TaskConfig,
    memory?: MemoryInstance,
    model?: ProviderModel,
    database?: DatabaseInstance,
    personality?: PersonalityInstance
  ): Promise<TaskInstance> {
    // Create a new task instance
    const task = new Task(config, memory, model, database, personality);

    // Save task to database if database is available
    if (task.database) {
      try {
        // Ensure tasks table exists
        await task.database.ensureTable('tasks', (table) => {
          table.string("id").primary();
          table.string("name").notNullable();
          table.text("description").notNullable();
          table.string("status").notNullable().index();
          table.integer("retries").defaultTo(0);
          table.json("plugins").nullable();
          table.json("input").nullable();
          table.json("dependencies").nullable();
          table.json("result").nullable();
          table.timestamp("createdAt").defaultTo(task.database!.knex.fn.now());
          table.timestamp("startedAt").nullable();
          table.timestamp("completedAt").nullable();
          table.string("agentId").nullable().index();
          table.string("sessionId").nullable().index();
          table.string("contextId").nullable().index();
        });

        // Use default tasks table name - can be customized via database config if needed
        const tasksTable = task.database.getTable('tasks');

        // Prepare task data for database
        const taskData = {
          id: task.id,
          name: task.config.name,
          description: task.config.description,
          status: task.status,
          retries: task.retries,
          plugins: JSON.stringify(task.config.plugins || []),
          input: task.config.input ? JSON.stringify(task.config.input) : null,
          dependencies: task.config.dependencies ? JSON.stringify(task.config.dependencies) : null,
          result: task.result ? JSON.stringify(task.result) : null,
          createdAt: task.createdAt,
          startedAt: task.startedAt || null,
          completedAt: task.completedAt || null,
          agentId: task.agentId || null,
          sessionId: task.sessionId || null,
          contextId: task.contextId || null,
        };

        // Check if task already exists
        const existingTask = await tasksTable.findOne({ id: task.id });

        if (existingTask) {
          // Update existing task
          await tasksTable.update({ id: task.id }, taskData);
          logger.debug(`Task ${task.id}: Updated in database`);
        } else {
          // Insert new task
          await tasksTable.insert(taskData);
          logger.debug(`Task ${task.id}: Saved to database`);
        }

        // Task state is now stored in database
      } catch (error) {
        logger.error(`Task ${task.id}: Error saving to database:`, error);
        // Don't throw error to avoid breaking task creation
      }
    }

    return task;
  }

  /**
   * Create a new task synchronously
   */
  static createTaskSync(
    config: TaskConfig,
    memory?: MemoryInstance,
    model?: ProviderModel,
    database?: DatabaseInstance,
    personality?: PersonalityInstance
  ): TaskInstance {
    // Create and return a new task instance without waiting for save
    return new Task(config, memory, model, database, personality);
  }
} 