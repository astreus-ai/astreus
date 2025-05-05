import { v4 as uuidv4 } from "uuid";
import {
  TaskConfig,
  TaskInstance,
  TaskStatus,
  TaskResult,
} from "../types/task";
import { Plugin } from "../types/plugin";
import { PluginManager } from "../plugin";
import { createDatabase, DatabaseInstance } from "../database";
import { MemoryInstance, ProviderModel } from "../types";
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

  public isCancelled: boolean = false;
  public lastSavedState: string = "";
  public savePromise: Promise<void> | null = null;

  constructor(config: TaskConfig, memory?: MemoryInstance, model?: ProviderModel, database?: DatabaseInstance) {
    this.id = config.id || uuidv4();
    this.config = config;
    this.status = "pending";
    this.retries = 0;
    this.plugins = [];
    this.createdAt = new Date();
    this.agentId = config.agentId;
    this.sessionId = config.sessionId;
    this.memory = memory;
    this.database = database;

    // Set context ID based on session ID
    if (this.sessionId) {
      this.contextId = this.sessionId;
    }

    // Load the plugins required for this task (but don't wait in constructor)
    this.loadPlugins(model).catch(error => {
      logger.error(`Error loading plugins for task ${this.id}:`, error);
    });

    // Save task to database (but don't wait for it in constructor)
    this.savePromise = this.saveToDatabase();
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
    const allTools = PluginManager.getAll();
    
    // Method 1: Get plugins from config first (explicitly provided in task config)
    if (this.config.plugins && this.config.plugins.length > 0) {
      const configPlugins = this.config.plugins
        .map(pluginName => {
          // Check if it's a tool instance already
          if (typeof pluginName === 'object' && 'name' in pluginName) {
            return pluginName as Plugin;
          }
          // Otherwise look it up by name
          return PluginManager.get(pluginName as string);
        })
        .filter(Boolean) as Plugin[];
      
      if (configPlugins.length > 0) {
        logger.task(this.id, `Using ${configPlugins.length} plugins from task config`, this.config.name);
        this.plugins = configPlugins;
        return; 
      }
    }
    
    // Method 2: Use LLM to select appropriate tools if model is provided
    if (model) {
      try {
        logger.task(this.id, "Using LLM to select tools for task", this.config.name);
        
        // Request tools with IntentRecognizer
        const selectedTools = await IntentRecognizer.recognizeIntent(
          this.config.name,
          this.config.description || this.config.name,
          allTools,
          model
        );
        
        if (selectedTools.length > 0) {
          logger.task(this.id, `LLM selected ${selectedTools.length} tools for task`, this.config.name);
          this.plugins = selectedTools;
          return;
        } else {
          logger.warn(`LLM did not select any tools for task "${this.config.name}", falling back to default`);
        }
      } catch (error) {
        logger.error(`Error using LLM for tool selection: ${error}`);
        // Fall back to default method
      }
    }
    
    // Fallback: use ONLY tools that match the task description instead of all agent plugins
    if (this.agentId) {
      logger.debug(`Task "${this.config.name}" did not get tools from LLM, using selective fallback`);
      
      // Get plugin names relevant to this task based on name keywords
      const taskNameLower = this.config.name.toLowerCase();
      
      // Select tools that appear to match the task
      const relevantPlugins = allTools.filter(plugin => {
        const pluginName = plugin.name.toLowerCase();
        // Be more specific about which tweet tools to use
        if (taskNameLower.includes("post") || taskNameLower.includes("send")) {
          return pluginName.includes("send_tweet") || pluginName.includes("post_tweet");
        }
        // For searching or getting tweets
        if (taskNameLower.includes("search") || taskNameLower.includes("find")) {
          return pluginName.includes("search_tweets");
        }
        // For getting tweets or user info
        if (taskNameLower.includes("get") || taskNameLower.includes("retrieve")) {
          return pluginName.includes("get_");
        }
        return false;
      });
      
      if (relevantPlugins.length > 0) {
        logger.task(this.id, `Selected ${relevantPlugins.length} plugins based on task keywords`, this.config.name);
        this.plugins = relevantPlugins;
        return;
      }
      
      // If no relevant plugins found through keyword matching, then use ALL agent plugins as last resort
      const agentPlugins = PluginManager.getByAgent(this.agentId);
      logger.task(this.id, `No specific tools matched task, falling back to all ${agentPlugins.length} agent plugins`, this.config.name);
      
      if (agentPlugins && agentPlugins.length > 0) {
        logger.task(this.id, `Adding agent plugins: ${agentPlugins.map(p => p.name).join(', ')}`, this.config.name);
        this.plugins = [...agentPlugins];
      } else {
        logger.warn(`No plugins found for agent ${this.agentId}`);
      }
    } else {
      logger.warn(`No agent ID provided for task "${this.config.name}", can't load plugins`);
    }
  }

  /**
   * Save task to database with proper locking to prevent concurrent saves
   */
  public async saveToDatabase(): Promise<void> {
    try {
      // Serialize the current state to compare with last saved state
      const currentState = JSON.stringify({
        status: this.status,
        retries: this.retries,
        result: this.result,
        startedAt: this.startedAt,
        completedAt: this.completedAt,
      });

      // Only save if there are changes
      if (currentState !== this.lastSavedState) {
        try {
          // Use database from instance if provided, otherwise create a new one
          const db = this.database || await createDatabase();
          const tasksTable = db.getTable("tasks");

          // Check if task exists
          const existingTask = await tasksTable.findOne({ id: this.id });
          const isNew = !existingTask;

          const taskData = {
            id: this.id,
            name: this.config.name,
            description: this.config.description || "",
            status: this.status,
            retries: this.retries,
            plugins: JSON.stringify(this.config.plugins || []),
            input: JSON.stringify(this.config.input || null),
            dependencies: JSON.stringify(this.config.dependencies || []),
            createdAt: this.createdAt,
            startedAt: this.startedAt || null,
            completedAt: this.completedAt || null,
            result: this.result ? JSON.stringify(this.result) : null,
            agentId: this.agentId || null,
            sessionId: this.sessionId || null,
            contextId: this.contextId || null,
          };

          if (isNew) {
            // Try to insert
            try {
              await tasksTable.insert(taskData);

              // Only log the first time we save a task
              if (this.lastSavedState === "") {
                logger.task(this.id, "Task saved to database", this.config.name);
              }
            } catch (insertErr) {
              // If constraint error, try updating instead
              const err = insertErr as Error | { code: string };
              if ('code' in err && err.code === "SQLITE_CONSTRAINT") {
                // Try updating instead - the task might have been inserted by another process
                try {
                  await tasksTable.update({ id: this.id }, taskData);
                  // No need to log this as it's a normal concurrent operation condition
                } catch (updateErr) {
                  logger.error(`Error updating task ${this.id} after constraint failure:`, updateErr);
                  // Don't rethrow - we've logged it and want to continue execution
                }
              } else {
                // This is a real error worth logging
                logger.error(`Error inserting task ${this.id}:`, insertErr);
                throw insertErr;
              }
            }
          } else {
            // Update existing task
            try {
              await tasksTable.update({ id: this.id }, taskData);

              // Don't log routine updates to reduce noise
              if (this.status === "completed" || this.status === "failed") {
                logger.task(this.id, `Task ${this.status}`, this.config.name);
              }
            } catch (updateErr) {
              logger.error(`Error updating task ${this.id}:`, updateErr);
              // Don't rethrow - we've logged it and want to continue execution
            }
          }
          // Update last saved state after successful save
          this.lastSavedState = currentState;
        } catch (err: any) {
          // Handle SQLITE_CONSTRAINT errors specifically
          if (err.code === "SQLITE_CONSTRAINT") {
            logger.debug(`Task ${this.id} constraint error handled during save`);
            // Don't rethrow - this is an expected race condition
          } else {
            logger.error(`Error saving task ${this.id}:`, err);
            // Don't rethrow as this would interrupt task execution
          }
        }
      }
    } catch (error) {
      logger.error("Error saving task to database:", error);
      // Don't rethrow as this would interrupt task execution
    }
  }

  /**
   * Execute the task using configured plugins
   */
  async execute(input?: any): Promise<TaskResult> {
    // Wait for any pending save operation to complete
    if (this.savePromise) {
      await this.savePromise;
    }

    // Add debug logging - Task execution start
    logger.debug(`Task ${this.id} (${this.config.name}) execution started with input:`, 
      JSON.stringify(input || this.config.input));

    // Use provided input or fallback to config input
    const taskInput: Record<string, unknown> = input || this.config.input;

    try {
      // Make sure plugins are loaded before starting the task
      if (!this.plugins || this.plugins.length === 0) {
        await this.loadPlugins();
      }
      
      // Skip execution if task is cancelled
      if (this.isCancelled) {
        throw new Error("Task was cancelled");
      }

      // Update status only after plugins are loaded
      this.status = "running";
      this.startedAt = new Date();
      this.savePromise = this.saveToDatabase();
      await this.savePromise;

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

      // Execute each plugin in sequence, passing output to next plugin
      let currentOutput: Record<string, unknown> = enrichedInput;
      let pluginOutput: unknown = null;

      // Ensure plugins array is valid before iterating
      if (!this.plugins || !Array.isArray(this.plugins)) {
        this.plugins = [];
      }
      
      logger.debug(`Task ${this.id} has ${this.plugins.length} plugins to execute`);

      // Prioritize the tools for better execution:
      // 1. If we're sending a tweet, prioritize the send_tweet tool
      // 2. If we have LLM-selected tools, use those first
      let prioritizedPlugins = [...this.plugins];
      
      // For tweet posting, prioritize send_tweet
      if (this.config.name.toLowerCase().includes("post") || 
          this.config.name.toLowerCase().includes("send")) {
        // Move send_tweet to the front if it exists
        const sendTweetIndex = prioritizedPlugins.findIndex(p => 
          p.name && p.name.toLowerCase().includes("send_tweet"));
        
        if (sendTweetIndex >= 0) {
          const sendTweetPlugin = prioritizedPlugins[sendTweetIndex];
          prioritizedPlugins = [sendTweetPlugin];
          logger.debug(`Prioritized ${sendTweetPlugin.name} for task "${this.config.name}"`);
        }
      }

      // Execute only the prioritized plugins
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

      // The final output should be the result from the last plugin, not the enriched input
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
        logger.task(this.id, `Task ${this.status}`, this.config.name);
      } else {
        this.status = "failed";
        logger.task(this.id, `Task ${this.status}`, this.config.name);
      }
    } catch (error) {
      // Handle error
      this.result = {
        success: false,
        error: error as Error,
      };
      
      logger.error(`Task ${this.id} failed with error:`, error);

      // Retry if max retries not exceeded
      if (this.retries < (this.config.maxRetries || 0)) {
        this.retries++;
        this.status = "pending";
        logger.info(
          `Retrying task '${this.id}', attempt ${this.retries}/${this.config.maxRetries}`
        );

        // Save current state before retrying
        this.savePromise = this.saveToDatabase();
        await this.savePromise;

        return this.execute(taskInput);
      } else {
        this.status = "failed";
        this.completedAt = new Date();
      }
    }

    // Save final state to database
    this.savePromise = this.saveToDatabase();
    await this.savePromise;

    return this.result as TaskResult;
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
      this.savePromise = this.saveToDatabase();
    }
  }

  /**
   * Set the memory instance for this task
   */
  setMemory(memory: MemoryInstance): void {
    this.memory = memory;
  }

  /**
   * Create a new task asynchronously
   */
  static async createTask(
    config: TaskConfig,
    memory?: MemoryInstance,
    model?: ProviderModel,
    database?: DatabaseInstance
  ): Promise<TaskInstance> {
    // Create a new task instance
    const task = new Task(config, memory, model, database);

    // Wait for the initial save to complete
    if (task.savePromise) {
      await task.savePromise;
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
    database?: DatabaseInstance
  ): TaskInstance {
    // Create and return a new task instance without waiting for save
    return new Task(config, memory, model, database);
  }
} 