import { IAgentModule, IAgent } from '../agent/types';
import { SubAgentRunOptions } from '../sub-agent/types';
import {
  Task as TaskType,
  TaskSearchOptions,
  TaskStatus,
  TaskRequest,
  TaskResponse,
} from './types';
import { MetadataObject } from '../types';
import { getDatabase } from '../database';
import {
  getLLM,
  LLMResponse,
  LLMMessage,
  LLMMessageContent,
  LLMMessageContentPart,
  Tool,
} from '../llm';
import { Memory } from '../memory';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';
import { Logger } from '../logger/types';
import { getEncryptionService } from '../database/encryption';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_AGENT_CONFIG } from '../agent/defaults';
import { DEFAULT_TASK_CONFIG } from './defaults';
import { convertToolParametersToJsonSchema } from '../plugin';

// Database row interfaces
interface TaskDbRow {
  id: number;
  agentId: number;
  prompt: string;
  response: string | null;
  status: TaskStatus;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  completedAt: string | null;
}

export class Task implements IAgentModule {
  readonly name = 'task';
  private knex: Knex | null = null;
  private logger: Logger;
  private _encryption?: ReturnType<typeof getEncryptionService>;

  private get encryption() {
    if (!this._encryption) {
      this._encryption = getEncryptionService();
    }
    return this._encryption;
  }

  constructor(private agent: IAgent) {
    this.logger = agent.logger;
  }

  async initialize(): Promise<void> {
    await this.ensureDatabase();
    await this.initializeTaskTable();
  }

  private async ensureDatabase(): Promise<void> {
    if (!this.knex) {
      const db = await getDatabase();
      this.knex = db.getKnex();
    }
  }

  private async initializeTaskTable(): Promise<void> {
    // Tasks table is now shared and initialized in the main database module
    // This method is kept for compatibility but does nothing
  }

  /**
   * Encrypt sensitive task fields before storing
   */
  private async encryptTaskData(
    data: Record<string, string | number | boolean | null>
  ): Promise<Record<string, string | number | boolean | null>> {
    if (!this.encryption.isEnabled()) {
      return data;
    }

    const encrypted = { ...data };

    if (encrypted.prompt !== undefined && encrypted.prompt !== null) {
      encrypted.prompt = await this.encryption.encrypt(String(encrypted.prompt), 'tasks.prompt');
    }

    if (encrypted.response !== undefined && encrypted.response !== null) {
      encrypted.response = await this.encryption.encrypt(
        String(encrypted.response),
        'tasks.response'
      );
    }

    if (encrypted.metadata !== undefined && encrypted.metadata !== null) {
      // Convert metadata to JSON string first if needed
      const metadataToEncrypt =
        typeof encrypted.metadata === 'string'
          ? encrypted.metadata
          : JSON.stringify(encrypted.metadata);
      encrypted.metadata = await this.encryption.encryptJSON(metadataToEncrypt, 'tasks.metadata');
    }

    return encrypted;
  }

  /**
   * Decrypt sensitive task fields after retrieving
   */
  private async decryptTaskData(
    data: Record<string, string | number | boolean | null>
  ): Promise<Record<string, string | number | boolean | null>> {
    if (!this.encryption.isEnabled() || !data) {
      return data;
    }

    const decrypted = { ...data };

    if (decrypted.prompt !== undefined && decrypted.prompt !== null) {
      decrypted.prompt = await this.encryption.decrypt(String(decrypted.prompt), 'tasks.prompt');
    }

    if (decrypted.response !== undefined && decrypted.response !== null) {
      decrypted.response = await this.encryption.decrypt(
        String(decrypted.response),
        'tasks.response'
      );
    }

    if (decrypted.metadata !== undefined && decrypted.metadata !== null) {
      const decryptedMetadata = await this.encryption.decryptJSON(
        String(decrypted.metadata),
        'tasks.metadata'
      );
      decrypted.metadata = decryptedMetadata ? JSON.stringify(decryptedMetadata) : null;
    }

    return decrypted;
  }

  async createTask(request: TaskRequest): Promise<TaskType> {
    // User-facing info log
    this.logger.info('Creating new task');

    this.logger.debug('Creating task', {
      promptLength: request.prompt.length,
      promptPreview: request.prompt.slice(0, 100) + '...,',
      agentId: this.agent.id,
      hasAttachments: !!request.attachments?.length,
      hasMcpServers: !!request.mcpServers?.length,
      hasPlugins: !!request.plugins?.length,
      useTools: !!request.useTools,
    });

    await this.ensureDatabase();
    const tableName = 'tasks';

    const metadata = request.metadata || {};
    if (request.useTools !== undefined) {
      metadata.useTools = request.useTools;
    }
    if (request.attachments) {
      metadata.attachments = JSON.stringify(request.attachments);
    }
    if (request.mcpServers) {
      metadata.mcpServers = JSON.stringify(request.mcpServers);
    }
    if (request.plugins) {
      metadata.plugins = JSON.stringify(request.plugins);
    }
    if (request.schedule) {
      metadata.schedule = request.schedule;
    }
    // Store sub-agent delegation options
    if (request.useSubAgents !== undefined) {
      metadata.useSubAgents = request.useSubAgents;
    }
    if (request.subAgentDelegation) {
      metadata.subAgentDelegation = request.subAgentDelegation;
    }
    if (request.subAgentCoordination) {
      metadata.subAgentCoordination = request.subAgentCoordination;
    }
    if (request.taskAssignment) {
      metadata.taskAssignment = JSON.stringify(request.taskAssignment);
    }

    // Process attachments and enhance prompt
    let enhancedPrompt = request.prompt;

    if (request.attachments && request.attachments.length > 0) {
      const attachmentDescriptions = await Promise.all(
        request.attachments.map(async (attachment) => {
          const displayName = attachment.name || attachment.path.split('/').pop();
          let description = `${attachment.type}: ${displayName} (${attachment.path})`;

          if (attachment.language) {
            description += ` [Language: ${attachment.language}]`;
          }

          // For text-based files, include a preview
          if (['text', 'markdown', 'code', 'json'].includes(attachment.type)) {
            try {
              const content = await fs.readFile(attachment.path, 'utf-8');
              const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
              description += `\nPreview: ${preview}`;
            } catch (error) {
              description += ` [File not accessible: ${error instanceof Error ? error.message : 'Unknown error'}]`;
            }
          }

          return description;
        })
      );

      enhancedPrompt = `${request.prompt}\n\nAttached files:\n${attachmentDescriptions.join('\n\n')}`;

      // Auto-enable tools if attachments are present and useTools not explicitly set
      if (request.useTools === undefined) {
        metadata.useTools = true;
      }
    }

    // Prepare data for encryption
    const insertData = {
      agentId: this.agent.id,
      prompt: enhancedPrompt,
      response: null,
      status: 'pending',
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    };

    // Encrypt sensitive fields
    const encryptedData = await this.encryptTaskData(insertData);

    const [task] = await this.knex!(tableName).insert(encryptedData).returning('*');

    // Decrypt for response
    const decryptedTask = await this.decryptTaskData(
      task as Record<string, string | number | boolean | null>
    );
    const formattedTask = this.formatTask(decryptedTask as unknown as TaskDbRow);

    // User-facing success message
    this.logger.info(`Task created with ID: ${formattedTask.id}`);

    this.logger.debug('Task created successfully', {
      taskId: formattedTask.id || 0,
      status: String(formattedTask.status),
      hasMetadata: !!formattedTask.metadata,
    });

    return formattedTask;
  }

  async executeTask(
    taskId: number,
    options?: { model?: string; stream?: boolean; onChunk?: (chunk: string) => void }
  ): Promise<TaskResponse> {
    const startTime = Date.now();

    // User-facing info log
    this.logger.info(`Executing task: ${taskId}`);

    this.logger.debug('Starting task execution', {
      taskId,
      agentId: this.agent.id,
      model: options?.model || 'default',
      stream: !!options?.stream,
    });

    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Auto-detect scheduled task and log info
    if (task.metadata?.schedule) {
      this.logger.info(
        `Task has schedule: ${task.metadata.schedule} - this will be handled by the graph system when used in graphs`
      );
    }

    // Update status to in_progress
    await this.updateTaskStatus(taskId, 'in_progress');

    try {
      // Check if tools should be used for this specific task
      const taskUseTools = task.metadata?.useTools;
      const agentUseTools = this.agent.config.useTools;
      const shouldUseTools = taskUseTools !== undefined ? taskUseTools : agentUseTools !== false;

      let llmResponse: LLMResponse;

      // Add memory context if agent has memory enabled
      const agentHasMemory = this.agent.config.memory || false;

      // Add task-level MCP servers if specified
      if (
        task.metadata?.mcpServers &&
        this.agent &&
        'addMCPServers' in this.agent &&
        typeof this.agent.addMCPServers === 'function'
      ) {
        await this.agent.addMCPServers(task.metadata.mcpServers);
      }

      // Add task-level plugins if specified
      if (
        task.metadata?.plugins &&
        typeof task.metadata.plugins === 'string' &&
        this.agent &&
        'registerPlugin' in this.agent &&
        typeof this.agent.registerPlugin === 'function'
      ) {
        try {
          const parsedPlugins = JSON.parse(task.metadata.plugins);
          if (Array.isArray(parsedPlugins)) {
            for (const pluginData of parsedPlugins) {
              await this.agent.registerPlugin(pluginData.plugin, pluginData.config);
            }
          }
        } catch (error) {
          this.logger.debug('Failed to parse plugins metadata', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Check for sub-agent delegation options
      const taskUseSubAgents = task.metadata?.useSubAgents;
      const hasSubAgents =
        this.agent &&
        'config' in this.agent &&
        this.agent.config.subAgents &&
        this.agent.config.subAgents.length > 0;

      // If task should use sub-agents and agent has sub-agents, use agent.ask() for delegation
      if (
        taskUseSubAgents &&
        hasSubAgents &&
        this.agent &&
        'ask' in this.agent &&
        typeof this.agent.ask === 'function'
      ) {
        // Prepare sub-agent options from task metadata
        const delegation = task.metadata?.subAgentDelegation;
        const coordination = task.metadata?.subAgentCoordination;

        const subAgentOptions: SubAgentRunOptions = {
          useSubAgents: true,
          delegation:
            typeof delegation === 'string' && ['auto', 'manual', 'sequential'].includes(delegation)
              ? (delegation as 'auto' | 'manual' | 'sequential')
              : 'auto',
          coordination:
            typeof coordination === 'string' && ['parallel', 'sequential'].includes(coordination)
              ? (coordination as 'parallel' | 'sequential')
              : 'sequential',
        };

        // Add task assignment if specified
        if (task.metadata?.taskAssignment && typeof task.metadata.taskAssignment === 'string') {
          try {
            subAgentOptions.taskAssignment = JSON.parse(task.metadata.taskAssignment);
          } catch (error) {
            this.logger.debug('Failed to parse taskAssignment metadata', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Add other options
        if (options?.model) {
          subAgentOptions.model = options.model;
        }
        if (options?.stream) {
          subAgentOptions.stream = options.stream;
        }
        if (typeof shouldUseTools === 'boolean') {
          subAgentOptions.useTools = shouldUseTools;
        }

        // Execute task with sub-agent delegation using agent.ask()
        const response = await this.agent.ask(task.prompt, subAgentOptions);

        llmResponse = {
          content: response,
          model: options?.model || this.agent.config.model || DEFAULT_AGENT_CONFIG.model,
        };
      } else {
        // Direct LLM execution with optional tool support
        const llm = getLLM(this.logger);

        // Prepare messages for LLM
        const llmMessages: LLMMessage[] = [];

        // Add system prompt
        const systemPrompt = this.agent.config.systemPrompt;
        if (systemPrompt) {
          llmMessages.push({ role: 'system', content: systemPrompt });
        }

        // Add conversation context from agent
        const contextMessages = this.agent.getContext();
        for (const contextMsg of contextMessages) {
          llmMessages.push({
            role: contextMsg.role,
            content: contextMsg.content,
          });
        }

        // Build the prompt with context and memory if needed
        let contextualPrompt = task.prompt;

        if (agentHasMemory) {
          const memory = new Memory(this.agent);
          const recentMemories = await memory.listMemories({
            limit: 20,
            orderBy: 'createdAt',
            order: 'asc',
          });

          if (recentMemories.length > 0) {
            const memoryContext = recentMemories
              .map((mem: MemoryType) => {
                if (mem.metadata?.type === 'user_message') {
                  return `Human: ${mem.content}`;
                } else if (mem.metadata?.type === 'assistant_response') {
                  return `Assistant: ${mem.content}`;
                }
                return null;
              })
              .filter(Boolean)
              .join('\n');

            contextualPrompt = `Previous conversation:\n${memoryContext}\n\nCurrent request: ${task.prompt}`;
          }
        }

        // Prepare tools if enabled
        const tools: Tool[] = [];

        if (shouldUseTools && this.agent.canUseTools()) {
          // Add MCP tools
          if (
            this.agent &&
            'getMCPTools' in this.agent &&
            typeof this.agent.getMCPTools === 'function'
          ) {
            const mcpTools = this.agent.getMCPTools();
            for (const mcpTool of mcpTools) {
              tools.push({
                type: 'function',
                function: {
                  name: `mcp_${mcpTool.name}`,
                  description: mcpTool.description,
                  parameters: mcpTool.inputSchema || {
                    type: 'object',
                    properties: {},
                  },
                },
              });
            }
          }

          // Add plugin tools
          if (this.agent && 'getTools' in this.agent && typeof this.agent.getTools === 'function') {
            const pluginTools = this.agent.getTools();
            for (const pluginTool of pluginTools) {
              tools.push({
                type: 'function',
                function: {
                  name: `plugin_${pluginTool.name}`,
                  description: pluginTool.description,
                  parameters: convertToolParametersToJsonSchema(pluginTool.parameters),
                },
              });
            }
          }
        }

        // Process attachments if present
        let userMessageContent: LLMMessageContent = contextualPrompt;

        if (task.metadata?.attachments) {
          try {
            const attachments = JSON.parse(task.metadata.attachments as string);
            const imageAttachments = attachments.filter(
              (att: { type: string; path: string }) => att.type === 'image'
            );

            if (imageAttachments.length > 0) {
              // Use visionModel if specified, otherwise fall back to main model
              const visionModel =
                this.agent.config.visionModel ||
                options?.model ||
                this.agent.config.model ||
                'gpt-4o';
              const visionCapableModels = [
                'gpt-4o',
                'gpt-4o-mini',
                'gpt-4-turbo',
                'gpt-4-vision-preview',
                'claude-3',
                'gemini',
              ];
              const isVisionCapable = visionCapableModels.some((vm) => visionModel.includes(vm));

              if (isVisionCapable) {
                // Create multi-modal content
                const contentParts: LLMMessageContentPart[] = [{ type: 'text', text: task.prompt }];

                // Add image parts
                for (const imageAtt of imageAttachments) {
                  try {
                    const imagePath = path.resolve(imageAtt.path);
                    const imageData = await fs.readFile(imagePath);
                    const base64Image = imageData.toString('base64');
                    const mimeType = getMimeType(path.extname(imagePath));

                    contentParts.push({
                      type: 'image_url',
                      image_url: {
                        url: `data:${mimeType};base64,${base64Image}`,
                        detail: 'auto',
                      },
                    });

                    this.logger.debug('Added image to message', {
                      imagePath: imageAtt.path,
                      mimeType,
                      base64Length: base64Image.length,
                    });
                  } catch {
                    this.logger.warn(`Failed to read image attachment: ${imageAtt.path}`);
                  }
                }

                userMessageContent = contentParts;
              }
            }
          } catch {
            this.logger.debug('Failed to parse attachments');
          }
        }

        // Add current prompt with potential image content
        llmMessages.push({ role: 'user', content: userMessageContent });

        // Use visionModel if images are present, otherwise use regular model
        const hasImages =
          task.metadata?.attachments &&
          JSON.parse(task.metadata.attachments as string).some(
            (att: { type: string }) => att.type === 'image'
          );
        const modelToUse =
          hasImages && this.agent.config.visionModel
            ? this.agent.config.visionModel
            : options?.model || this.agent.config.model || DEFAULT_AGENT_CONFIG.model;

        this.logger.debug('Model selection for task execution', {
          hasImages: !!hasImages,
          agentVisionModel: this.agent.config.visionModel || 'none',
          agentMainModel: this.agent.config.model || 'none',
          optionsModel: options?.model || 'none',
          modelToUse: modelToUse,
          taskId: taskId,
        });

        const llmOptions = {
          model: modelToUse,
          messages: llmMessages,
          temperature: this.agent.config.temperature || DEFAULT_AGENT_CONFIG.temperature,
          maxTokens: this.agent.config.maxTokens || DEFAULT_AGENT_CONFIG.maxTokens,
          tools: tools.length > 0 ? tools : undefined,
        };

        if (options?.stream) {
          // Handle streaming with tool support
          let fullContent = '';
          let streamToolCalls: Array<{
            id: string;
            type: 'function';
            function: {
              name: string;
              arguments: Record<string, string | number | boolean | null>;
            };
          }> = [];

          for await (const chunk of llm.generateStreamResponse(llmOptions)) {
            fullContent += chunk.content;
            if (chunk.content) {
              // Use onChunk callback if available, otherwise fallback to process.stdout
              if (options?.onChunk) {
                options.onChunk(chunk.content);
              } else {
                process.stdout.write(chunk.content);
              }
            }
            if (chunk.toolCalls) {
              streamToolCalls = chunk.toolCalls;
            }
          }

          // Handle tool calls if present during streaming
          if (streamToolCalls.length > 0) {
            // Add assistant message with tool calls
            llmMessages.push({
              role: 'assistant',
              content: fullContent || '',
              tool_calls: streamToolCalls,
            });

            // Execute each tool call
            for (const toolCall of streamToolCalls) {
              try {
                let toolResult: string;

                if (toolCall.function.name.startsWith('mcp_')) {
                  // Handle MCP tool
                  const mcpToolName = toolCall.function.name.substring(4);
                  const mcpArgs =
                    typeof toolCall.function.arguments === 'string'
                      ? JSON.parse(toolCall.function.arguments)
                      : toolCall.function.arguments;

                  if (
                    this.agent &&
                    'callMCPTool' in this.agent &&
                    typeof this.agent.callMCPTool === 'function'
                  ) {
                    const mcpResult = await this.agent.callMCPTool(mcpToolName, mcpArgs);
                    toolResult = mcpResult.content
                      .map((c: { text?: string }) => c.text || '')
                      .join('\\n');
                  } else {
                    toolResult = 'Error: MCP tools not available';
                  }
                } else if (toolCall.function.name.startsWith('plugin_')) {
                  // Handle plugin tool
                  const pluginToolName = toolCall.function.name.substring(7);
                  const pluginArgs =
                    typeof toolCall.function.arguments === 'string'
                      ? JSON.parse(toolCall.function.arguments)
                      : toolCall.function.arguments;

                  if (
                    this.agent &&
                    'executeTool' in this.agent &&
                    typeof this.agent.executeTool === 'function'
                  ) {
                    const pluginCallResult = await this.agent.executeTool({
                      id: toolCall.id || `${Date.now()}-${Math.random()}`,
                      name: pluginToolName,
                      parameters: pluginArgs,
                    });

                    toolResult = pluginCallResult.result.success
                      ? typeof pluginCallResult.result.data === 'string'
                        ? pluginCallResult.result.data
                        : JSON.stringify(pluginCallResult.result.data)
                      : `Error: ${pluginCallResult.result.error || 'Unknown error'}`;
                  } else {
                    toolResult = 'Error: Plugin tools not available';
                  }
                } else {
                  toolResult = `Unknown tool type: ${toolCall.function.name}`;
                }

                // Add tool result to messages
                llmMessages.push({
                  role: 'tool',
                  content: toolResult,
                  tool_call_id: toolCall.id,
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                llmMessages.push({
                  role: 'tool',
                  content: `Error: ${errorMessage}`,
                  tool_call_id: toolCall.id,
                });
              }
            }

            // Get final response from LLM with tool results (streaming)
            const finalLlmOptions = {
              ...llmOptions,
              messages: llmMessages,
              tools: undefined, // Don't include tools in follow-up
            };

            let finalStreamContent = '';
            for await (const chunk of llm.generateStreamResponse(finalLlmOptions)) {
              finalStreamContent += chunk.content;
              if (chunk.content) {
                // Use onChunk callback if available, otherwise fallback to process.stdout
                if (options?.onChunk) {
                  options.onChunk(chunk.content);
                } else {
                  process.stdout.write(chunk.content);
                }
              }
            }
            fullContent = finalStreamContent;
          }

          llmResponse = {
            content: fullContent,
            model: modelToUse,
            toolCalls: streamToolCalls,
          };
        } else {
          // Non-streaming with tool handling
          const initialResponse = await llm.generateResponse(llmOptions);
          let finalResponse = initialResponse.content;
          let toolCallsExecuted: Array<{
            id: string;
            type: 'function';
            function: {
              name: string;
              arguments: Record<string, string | number | boolean | null>;
            };
          }> = [];

          // Handle tool calls if present
          if (initialResponse.toolCalls && initialResponse.toolCalls.length > 0) {
            toolCallsExecuted = initialResponse.toolCalls;

            // Add assistant message with tool calls
            llmMessages.push({
              role: 'assistant',
              content: initialResponse.content || '',
              tool_calls: initialResponse.toolCalls,
            });

            // Execute each tool call
            for (const toolCall of initialResponse.toolCalls) {
              try {
                let toolResult: string;

                if (toolCall.function.name.startsWith('mcp_')) {
                  // Handle MCP tool
                  const mcpToolName = toolCall.function.name.substring(4);
                  const mcpArgs =
                    typeof toolCall.function.arguments === 'string'
                      ? JSON.parse(toolCall.function.arguments)
                      : toolCall.function.arguments;

                  if (
                    this.agent &&
                    'callMCPTool' in this.agent &&
                    typeof this.agent.callMCPTool === 'function'
                  ) {
                    const mcpResult = await this.agent.callMCPTool(mcpToolName, mcpArgs);
                    toolResult = mcpResult.content
                      .map((c: { text?: string }) => c.text || '')
                      .join('\\n');
                  } else {
                    toolResult = 'Error: MCP tools not available';
                  }
                } else if (toolCall.function.name.startsWith('plugin_')) {
                  // Handle plugin tool
                  const pluginToolName = toolCall.function.name.substring(7);
                  const pluginArgs =
                    typeof toolCall.function.arguments === 'string'
                      ? JSON.parse(toolCall.function.arguments)
                      : toolCall.function.arguments;

                  if (
                    this.agent &&
                    'executeTool' in this.agent &&
                    typeof this.agent.executeTool === 'function'
                  ) {
                    const pluginCallResult = await this.agent.executeTool({
                      id: toolCall.id || `${Date.now()}-${Math.random()}`,
                      name: pluginToolName,
                      parameters: pluginArgs,
                    });

                    toolResult = pluginCallResult.result.success
                      ? typeof pluginCallResult.result.data === 'string'
                        ? pluginCallResult.result.data
                        : JSON.stringify(pluginCallResult.result.data)
                      : `Error: ${pluginCallResult.result.error || 'Unknown error'}`;
                  } else {
                    toolResult = 'Error: Plugin tools not available';
                  }
                } else {
                  toolResult = `Unknown tool type: ${toolCall.function.name}`;
                }

                // Add tool result to messages
                llmMessages.push({
                  role: 'tool',
                  content: toolResult,
                  tool_call_id: toolCall.id,
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                llmMessages.push({
                  role: 'tool',
                  content: `Error: ${errorMessage}`,
                  tool_call_id: toolCall.id,
                });
              }
            }

            // Get final response from LLM with tool results
            const finalLlmOptions = {
              ...llmOptions,
              messages: llmMessages,
              tools: undefined, // Don't include tools in follow-up
            };

            const finalLlmResponse = await llm.generateResponse(finalLlmOptions);
            finalResponse = finalLlmResponse.content;
          }

          llmResponse = {
            content: finalResponse,
            model: modelToUse,
            usage: initialResponse.usage,
            toolCalls: toolCallsExecuted,
          };
        }
      }

      // Update task with response and mark as completed
      const updatedTask = await this.updateTask(taskId, {
        response: llmResponse.content,
        status: 'completed',
        completedAt: new Date(),
      });

      // User-facing success message
      this.logger.info(`Task ${taskId} completed successfully`);

      this.logger.debug('Task execution completed', {
        taskId,
        responseLength: llmResponse.content.length,
        executionTimeMs: Date.now() - startTime,
        status: 'completed',
      });

      // Add task conversation to memory/context
      if (this.agent && 'addMemory' in this.agent && typeof this.agent.addMemory === 'function') {
        await (
          this.agent.addMemory as (
            content: string,
            metadata?: MetadataObject
          ) => Promise<{ id: number; content: string }>
        )(task.prompt, {
          role: 'user',
          type: 'task_execution',
          taskId: taskId,
          source: 'task',
        });

        await (
          this.agent.addMemory as (
            content: string,
            metadata?: MetadataObject
          ) => Promise<{ id: number; content: string }>
        )(llmResponse.content, {
          role: 'assistant',
          type: 'task_response',
          taskId: taskId,
          model: llmResponse.model || '',
          source: 'task',
        });
      }

      return {
        task: updatedTask!,
        response: llmResponse.content,
        model: llmResponse.model,
        usage: llmResponse.usage,
      };
    } catch (error) {
      // Mark task as failed
      await this.updateTaskStatus(taskId, 'failed');

      // User-facing error message
      this.logger.error(`Task ${taskId} failed`, error instanceof Error ? error : undefined, {
        taskId,
        executionTimeMs: Date.now() - startTime,
        agentId: this.agent.id,
      });

      throw error;
    }
  }

  async getTask(id: number): Promise<TaskType | null> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    const task = await this.knex!(tableName).where({ id, agentId: this.agent.id }).first();

    if (!task) return null;

    // Decrypt sensitive fields
    const decryptedTask = await this.decryptTaskData(
      task as Record<string, string | number | boolean | null>
    );
    return this.formatTask(decryptedTask as unknown as TaskDbRow);
  }

  async listTasks(options: TaskSearchOptions = {}): Promise<TaskType[]> {
    this.logger.info('Listing tasks');

    this.logger.debug('Listing tasks with options', {
      limit: options.limit || DEFAULT_TASK_CONFIG.searchLimit,
      offset: options.offset || DEFAULT_TASK_CONFIG.searchOffset,
      status: options.status || DEFAULT_TASK_CONFIG.logStatus,
      orderBy: options.orderBy || DEFAULT_TASK_CONFIG.searchOrderBy,
      order: options.order || DEFAULT_TASK_CONFIG.searchOrder,
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'tasks';

    const { limit = 100, offset = 0, status, orderBy = 'createdAt', order = 'desc' } = options;

    const orderColumn =
      orderBy === 'createdAt'
        ? 'created_at'
        : orderBy === 'updatedAt'
          ? 'updated_at'
          : orderBy === 'completedAt'
            ? 'completedAt'
            : 'created_at';

    let query = this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .orderBy(orderColumn, order)
      .limit(limit)
      .offset(offset);

    if (status) {
      query = query.andWhere({ status });
    }

    const tasks = await query;

    // Decrypt tasks if encryption is enabled
    if (this.encryption.isEnabled()) {
      const decryptedTasks = await Promise.all(
        tasks.map(async (task) => {
          try {
            const decrypted = await this.decryptTaskData(
              task as Record<string, string | number | boolean | null>
            );
            return this.formatTask(decrypted as unknown as TaskDbRow);
          } catch {
            // If decryption fails, return original task (might be unencrypted legacy data)
            this.logger.debug('Failed to decrypt task during list', { taskId: task.id });
            return this.formatTask(task);
          }
        })
      );
      return decryptedTasks;
    } else {
      return tasks.map((task) => this.formatTask(task));
    }
  }

  async updateTask(id: number, updates: Partial<TaskType>): Promise<TaskType | null> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    const updateData: Partial<TaskDbRow> = {};

    if (updates.prompt !== undefined) updateData.prompt = updates.prompt;
    if (updates.response !== undefined) updateData.response = updates.response;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata);
    if (updates.completedAt !== undefined)
      updateData.completedAt =
        updates.completedAt instanceof Date
          ? updates.completedAt.toISOString()
          : updates.completedAt;

    if (Object.keys(updateData).length === 0) {
      return this.getTask(id);
    }

    // Encrypt sensitive fields in update data
    const encryptedUpdateData = await this.encryptTaskData(updateData);

    const [task] = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .update(encryptedUpdateData)
      .returning('*');

    if (!task) return null;

    // Decrypt for response
    const decryptedTask = await this.decryptTaskData(
      task as Record<string, string | number | boolean | null>
    );
    return this.formatTask(decryptedTask as unknown as TaskDbRow);
  }

  private async updateTaskStatus(id: number, status: TaskStatus): Promise<TaskType | null> {
    const updateData: Partial<TaskDbRow> = { status };

    if (status === 'completed') {
      updateData.completedAt = new Date().toISOString();
    }

    // Convert TaskDbRow format to TaskType format for the updateTask method
    const taskTypeUpdate: Partial<TaskType> = {
      status: updateData.status,
      ...(updateData.completedAt && { completedAt: new Date(updateData.completedAt) }),
    };

    return this.updateTask(id, taskTypeUpdate);
  }

  async deleteTask(id: number): Promise<boolean> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    const deleted = await this.knex!(tableName).where({ id, agentId: this.agent.id }).delete();

    return deleted > 0;
  }

  async clearTasks(): Promise<number> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    return await this.knex!(tableName).where({ agentId: this.agent.id }).delete();
  }

  private formatTask(task: TaskDbRow): TaskType {
    return {
      id: task.id,
      agentId: task.agentId,
      prompt: task.prompt,
      response: task.response ?? undefined,
      status: task.status,
      metadata: task.metadata
        ? typeof task.metadata === 'string'
          ? JSON.parse(task.metadata)
          : task.metadata
        : undefined,
      createdAt: new Date(task.created_at),
      updatedAt: new Date(task.updated_at),
      completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
    };
  }
}

// Helper function to get MIME type from file extension
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };

  return mimeTypes[extension.toLowerCase()] || DEFAULT_TASK_CONFIG.defaultMimeType;
}

// Export types
export type {
  Task as TaskType,
  TaskRequest,
  TaskResponse,
  TaskSearchOptions,
  TaskStatus,
} from './types';
