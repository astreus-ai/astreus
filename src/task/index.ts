import crypto from 'crypto';
import { IAgentModule, IAgent } from '../agent/types';
import { SubAgentRunOptions } from '../sub-agent/types';
import {
  Task as TaskType,
  TaskSearchOptions,
  TaskStatus,
  TaskRequest,
  TaskResponse,
} from './types';
import { getDatabase } from '../database';
import {
  getLLM,
  LLMResponse,
  LLMMessage,
  LLMMessageContent,
  LLMMessageContentPart,
  Tool,
  ToolCall,
} from '../llm';
import { LLMUsage } from '../llm/types';
import { Memory } from '../memory';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';
import { Logger } from '../logger/types';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_AGENT_CONFIG } from '../agent/defaults';
import { DEFAULT_TASK_CONFIG } from './defaults';
import { convertToolParametersToJsonSchema } from '../plugin';
import { MetadataObject } from '../types';

/**
 * Simple async mutex for protecting initialization.
 * Replaces spin-wait anti-pattern with proper promise-based waiting.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// Database row interfaces
interface TaskDbRow {
  id: string; // UUID
  agentId: string; // UUID
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
  private static initializingDatabase: Promise<void> | null = null;
  private static readonly MAX_TOOL_CALLS = DEFAULT_TASK_CONFIG.maxToolCalls;
  // AsyncMutex pattern for race condition prevention (replaces spin-wait)
  private static initMutex = new AsyncMutex();

  constructor(private agent: IAgent) {
    this.logger = agent.logger;
  }

  async initialize(): Promise<void> {
    await this.ensureDatabase();
  }

  private async ensureDatabase(): Promise<void> {
    if (this.knex) {
      return;
    }

    // Check if another instance is already initializing
    if (Task.initializingDatabase) {
      await Task.initializingDatabase;
      // After waiting, get the knex instance from the initialized database
      const db = await getDatabase();
      this.knex = db.getKnex();
      return;
    }

    // Use AsyncMutex instead of spin-wait for proper synchronization
    await Task.initMutex.acquire();
    let mutexReleased = false;
    try {
      // Double-check after acquiring lock
      if (this.knex) return;

      // Check again if initialization started while waiting for lock
      if (Task.initializingDatabase) {
        // Release mutex early since we'll wait on the promise
        Task.initMutex.release();
        mutexReleased = true;
        await Task.initializingDatabase;
        const db = await getDatabase();
        this.knex = db.getKnex();
        return;
      }

      // Start initialization
      Task.initializingDatabase = (async () => {
        const db = await getDatabase();
        this.knex = db.getKnex();
      })();

      try {
        await Task.initializingDatabase;
      } finally {
        Task.initializingDatabase = null;
      }
    } finally {
      // Only release if not already released
      if (!mutexReleased) {
        Task.initMutex.release();
      }
    }
  }

  private getKnex(): Knex {
    if (!this.knex) {
      throw new Error('Database not initialized. Call ensureDatabase() first.');
    }
    return this.knex;
  }

  async createTask(request: TaskRequest): Promise<TaskType> {
    // User-facing info log
    this.logger.info('Creating new task');

    this.logger.debug('Creating task', {
      promptLength: request.prompt.length,
      promptPreview: request.prompt.slice(0, 100) + '...',
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
          const displayName = attachment.name || attachment.path?.split('/').pop() || 'unknown';
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
      id: crypto.randomUUID(), // Generate UUID for task
      agentId: this.agent.id,
      graphId: request.graphId || null, // Graph relationship
      graphNodeId: request.graphNodeId || null, // Graph node relationship
      prompt: enhancedPrompt,
      response: null,
      status: 'pending',
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      executionContext: request.executionContext ? JSON.stringify(request.executionContext) : null,
    };

    // Encrypt sensitive fields using centralized encryption
    const encryptedData = await encryptSensitiveFields(insertData, 'tasks');

    // Use transaction for atomicity - ensures data consistency
    const task = await this.getKnex().transaction(async (trx) => {
      const [inserted] = await trx(tableName).insert(encryptedData).returning('*');
      return inserted;
    });

    // Decrypt for response
    const decryptedTask = await decryptSensitiveFields(
      task as Record<string, string | number | boolean | null>,
      'tasks'
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
    taskId: string,
    options?: {
      model?: string;
      stream?: boolean;
      onChunk?: (chunk: string) => void;
      onToolCall?: (
        toolName: string,
        args: Record<string, unknown>,
        status: 'start' | 'end',
        result?: string
      ) => void;
    }
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

        // Prepare messages for LLM (with max context limit)
        const MAX_CONTEXT_MESSAGES = 100;
        const llmMessages: LLMMessage[] = [];

        // Add system prompt
        const systemPrompt = this.agent.config.systemPrompt;
        if (systemPrompt) {
          llmMessages.push({ role: 'system', content: systemPrompt });
        }

        // Add conversation context from agent (with bounds checking)
        const contextMessages = this.agent.getContext();
        const maxContextToAdd = Math.max(0, MAX_CONTEXT_MESSAGES - llmMessages.length - 1); // Reserve space for user message
        const contextToAdd = contextMessages.slice(-maxContextToAdd); // Keep most recent context

        if (contextMessages.length > maxContextToAdd) {
          this.logger.debug('Context messages truncated due to limit', {
            original: contextMessages.length,
            kept: maxContextToAdd,
          });
        }

        for (const contextMsg of contextToAdd) {
          llmMessages.push({
            role: contextMsg.role,
            content: contextMsg.content,
          });
        }

        // Build the prompt with context and memory if needed
        // Skip manual memory loading if task is part of a graph - graph handles context via loadGraphContext
        let contextualPrompt = task.prompt;

        if (agentHasMemory && !task.graphId) {
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

                // Maximum image size limit (10MB) to prevent memory issues
                const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

                // Add image parts
                for (const imageAtt of imageAttachments) {
                  try {
                    const imagePath = path.resolve(imageAtt.path);

                    // Check file size before loading to prevent memory issues
                    const stats = await fs.stat(imagePath);
                    if (stats.size > MAX_IMAGE_SIZE) {
                      this.logger.warn('Image too large, skipping', {
                        size: stats.size,
                        maxSize: MAX_IMAGE_SIZE,
                        path: imageAtt.path,
                      });
                      continue;
                    }

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
        let hasImages = false;
        try {
          hasImages =
            task.metadata?.attachments &&
            JSON.parse(task.metadata.attachments as string).some(
              (att: { type: string }) => att.type === 'image'
            );
        } catch {
          this.logger.debug('Failed to parse attachments for image detection');
        }
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
          const streamToolCalls: ToolCall[] = [];
          let streamUsage: LLMUsage | undefined;

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
              // Merge tool calls instead of replacing to avoid losing calls across chunks
              for (const tc of chunk.toolCalls) {
                const existingIndex = streamToolCalls.findIndex((t) => t.id === tc.id);
                if (existingIndex >= 0) {
                  // Update existing tool call (may have more complete arguments)
                  streamToolCalls[existingIndex] = tc;
                } else {
                  // Add bounds checking to prevent unbounded array growth
                  if (streamToolCalls.length >= Task.MAX_TOOL_CALLS) {
                    this.logger.warn(
                      'Maximum tool calls limit reached, ignoring additional tool calls',
                      {
                        maxToolCalls: Task.MAX_TOOL_CALLS,
                        taskId,
                      }
                    );
                    break;
                  }
                  streamToolCalls.push(tc);
                }
              }
            }
            if (chunk.usage) {
              streamUsage = chunk.usage;
            }
          }

          // Handle tool calls with multi-turn agentic loop
          const MAX_TOOL_ITERATIONS = DEFAULT_TASK_CONFIG.maxToolIterations; // Prevent infinite loops
          let toolIteration = 0;
          const allToolCalls: ToolCall[] = [...streamToolCalls];

          while (streamToolCalls.length > 0 && toolIteration < MAX_TOOL_ITERATIONS) {
            toolIteration++;
            this.logger.debug(`Tool iteration ${toolIteration}`, {
              toolCallCount: streamToolCalls.length,
              toolNames: streamToolCalls.map((tc) => tc.function?.name),
            });

            // Add assistant message with tool calls (copy array to avoid mutation issues)
            llmMessages.push({
              role: 'assistant',
              content: fullContent || '',
              tool_calls: [...streamToolCalls], // Copy to avoid reference mutation
            });

            // Execute each tool call
            for (const toolCall of streamToolCalls) {
              // Define these outside try block for catch access
              const toolName = toolCall.function?.name || 'unknown';
              let toolArgs: Record<string, unknown> = {};

              // Parse arguments once
              try {
                const argsStr = toolCall.function?.arguments;
                if (argsStr && typeof argsStr === 'string') {
                  toolArgs = JSON.parse(argsStr);
                } else if (typeof argsStr === 'object' && argsStr !== null) {
                  toolArgs = argsStr as Record<string, unknown>;
                }
              } catch {
                toolArgs = {};
              }

              // Notify tool call start
              if (options?.onToolCall) {
                const displayName = toolName.replace(/^(mcp_|plugin_)/, '');
                options.onToolCall(displayName, toolArgs, 'start');
              }

              try {
                let toolResult: string;

                // Validate tool call has required fields
                if (!toolCall.function?.name) {
                  toolResult = 'Error: Invalid tool call - missing function name';
                } else if (toolCall.function.name.startsWith('mcp_')) {
                  // Handle MCP tool
                  const mcpToolName =
                    toolCall.function.name.length > 4 ? toolCall.function.name.substring(4) : '';

                  if (
                    this.agent &&
                    'callMCPTool' in this.agent &&
                    typeof this.agent.callMCPTool === 'function'
                  ) {
                    const mcpResult = await this.agent.callMCPTool(mcpToolName, toolArgs);
                    toolResult = mcpResult?.content
                      ? mcpResult.content.map((c: { text?: string }) => c.text || '').join('\n')
                      : 'No content returned from MCP tool';
                  } else {
                    toolResult = 'Error: MCP tools not available';
                  }
                } else if (toolCall.function.name.startsWith('plugin_')) {
                  // Handle plugin tool
                  const pluginToolName =
                    toolCall.function.name.length > 7 ? toolCall.function.name.substring(7) : '';

                  if (
                    this.agent &&
                    'executeTool' in this.agent &&
                    typeof this.agent.executeTool === 'function'
                  ) {
                    const pluginCallResult = await this.agent.executeTool({
                      id:
                        toolCall.id && toolCall.id.trim() !== ''
                          ? toolCall.id
                          : `tool-${crypto.randomUUID()}`,
                      name: pluginToolName,
                      parameters: toolArgs,
                    });

                    toolResult = pluginCallResult?.result
                      ? pluginCallResult.result.success
                        ? typeof pluginCallResult.result.data === 'string'
                          ? pluginCallResult.result.data
                          : JSON.stringify(pluginCallResult.result.data ?? null)
                        : `Error: ${pluginCallResult.result.error || 'Unknown error'}`
                      : 'Error: No result returned from plugin';
                  } else {
                    toolResult = 'Error: Plugin tools not available';
                  }
                } else {
                  toolResult = `Unknown tool type: ${toolCall.function.name}`;
                }

                // Notify tool call end
                if (options?.onToolCall) {
                  const displayName = toolName.replace(/^(mcp_|plugin_)/, '');
                  options.onToolCall(displayName, toolArgs, 'end', toolResult);
                }

                // Add tool result to messages
                llmMessages.push({
                  role: 'tool',
                  content: toolResult,
                  tool_call_id: toolCall.id,
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                // Notify tool call error
                if (options?.onToolCall) {
                  const displayName = toolName.replace(/^(mcp_|plugin_)/, '');
                  options.onToolCall(displayName, toolArgs, 'end', `Error: ${errorMessage}`);
                }
                llmMessages.push({
                  role: 'tool',
                  content: `Error: ${errorMessage}`,
                  tool_call_id: toolCall.id,
                });
              }
            }

            // Get next response from LLM with tool results (keep tools for multi-turn)
            const nextLlmOptions = {
              ...llmOptions,
              messages: llmMessages,
              tools: tools.length > 0 ? tools : undefined, // Keep tools for multi-turn
            };

            // Reset for next iteration
            streamToolCalls.length = 0;
            fullContent = '';

            try {
              for await (const chunk of llm.generateStreamResponse(nextLlmOptions)) {
                fullContent += chunk.content;
                if (chunk.content) {
                  if (options?.onChunk) {
                    options.onChunk(chunk.content);
                  } else {
                    process.stdout.write(chunk.content);
                  }
                }
                // Collect new tool calls for next iteration
                if (chunk.toolCalls) {
                  for (const tc of chunk.toolCalls) {
                    const existingIndex = streamToolCalls.findIndex((t) => t.id === tc.id);
                    if (existingIndex >= 0) {
                      streamToolCalls[existingIndex] = tc;
                    } else if (streamToolCalls.length < Task.MAX_TOOL_CALLS) {
                      streamToolCalls.push(tc);
                      allToolCalls.push(tc);
                    }
                  }
                }
                if (chunk.usage) {
                  if (streamUsage) {
                    streamUsage.promptTokens += chunk.usage.promptTokens;
                    streamUsage.completionTokens += chunk.usage.completionTokens;
                    streamUsage.totalTokens += chunk.usage.totalTokens;
                    streamUsage.cost = (streamUsage.cost ?? 0) + (chunk.usage.cost ?? 0);
                  } else {
                    streamUsage = chunk.usage;
                  }
                }
              }
            } catch (llmError) {
              const errorMessage = llmError instanceof Error ? llmError.message : String(llmError);
              const toolErrorResponse = `\n\nError during tool execution: ${errorMessage}`;
              fullContent += toolErrorResponse;
              if (options?.onChunk) {
                options.onChunk(toolErrorResponse);
              } else {
                process.stdout.write(toolErrorResponse);
              }
              break; // Exit loop on error
            }
          }

          if (toolIteration >= MAX_TOOL_ITERATIONS) {
            this.logger.warn('Maximum tool iterations reached', {
              maxIterations: MAX_TOOL_ITERATIONS,
              taskId,
            });
          }

          llmResponse = {
            content: fullContent,
            model: modelToUse,
            toolCalls: allToolCalls,
            usage: streamUsage,
          };
        } else {
          // Non-streaming with multi-turn tool handling
          let currentResponse = await llm.generateResponse(llmOptions);
          let finalResponse = currentResponse.content;
          const allToolCallsExecuted: ToolCall[] = [];
          const totalUsage = currentResponse.usage;

          const MAX_TOOL_ITERATIONS = DEFAULT_TASK_CONFIG.maxToolIterations;
          let toolIteration = 0;

          while (
            currentResponse.toolCalls &&
            currentResponse.toolCalls.length > 0 &&
            toolIteration < MAX_TOOL_ITERATIONS
          ) {
            toolIteration++;
            this.logger.debug(`Non-streaming tool iteration ${toolIteration}`, {
              toolCallCount: currentResponse.toolCalls.length,
              toolNames: currentResponse.toolCalls.map((tc) => tc.function?.name),
            });

            const currentToolCalls = currentResponse.toolCalls.slice(0, Task.MAX_TOOL_CALLS);
            allToolCallsExecuted.push(...currentToolCalls);

            // Add assistant message with tool calls
            llmMessages.push({
              role: 'assistant',
              content: currentResponse.content || '',
              tool_calls: currentToolCalls,
            });

            // Execute each tool call
            for (const toolCall of currentToolCalls) {
              try {
                let toolResult: string;

                if (!toolCall.function?.name) {
                  toolResult = 'Error: Invalid tool call - missing function name';
                } else if (toolCall.function.name.startsWith('mcp_')) {
                  const mcpToolName =
                    toolCall.function.name.length > 4 ? toolCall.function.name.substring(4) : '';
                  let mcpArgs: Record<string, unknown> = {};
                  try {
                    const argsStr = toolCall.function.arguments;
                    if (argsStr && typeof argsStr === 'string') {
                      mcpArgs = JSON.parse(argsStr);
                    } else if (typeof argsStr === 'object' && argsStr !== null) {
                      mcpArgs = argsStr as Record<string, unknown>;
                    }
                  } catch {
                    mcpArgs = {};
                  }

                  if (
                    this.agent &&
                    'callMCPTool' in this.agent &&
                    typeof this.agent.callMCPTool === 'function'
                  ) {
                    const mcpResult = await this.agent.callMCPTool(mcpToolName, mcpArgs);
                    toolResult = mcpResult?.content
                      ? mcpResult.content.map((c: { text?: string }) => c.text || '').join('\n')
                      : 'No content returned from MCP tool';
                  } else {
                    toolResult = 'Error: MCP tools not available';
                  }
                } else if (toolCall.function.name.startsWith('plugin_')) {
                  const pluginToolName =
                    toolCall.function.name.length > 7 ? toolCall.function.name.substring(7) : '';
                  let pluginArgs: Record<string, unknown> = {};
                  try {
                    const argsStr = toolCall.function.arguments;
                    if (argsStr && typeof argsStr === 'string') {
                      pluginArgs = JSON.parse(argsStr);
                    } else if (typeof argsStr === 'object' && argsStr !== null) {
                      pluginArgs = argsStr as Record<string, unknown>;
                    }
                  } catch {
                    pluginArgs = {};
                  }

                  if (
                    this.agent &&
                    'executeTool' in this.agent &&
                    typeof this.agent.executeTool === 'function'
                  ) {
                    const pluginCallResult = await this.agent.executeTool({
                      id:
                        toolCall.id && toolCall.id.trim() !== ''
                          ? toolCall.id
                          : `tool-${crypto.randomUUID()}`,
                      name: pluginToolName,
                      parameters: pluginArgs,
                    });

                    toolResult = pluginCallResult?.result
                      ? pluginCallResult.result.success
                        ? typeof pluginCallResult.result.data === 'string'
                          ? pluginCallResult.result.data
                          : JSON.stringify(pluginCallResult.result.data ?? null)
                        : `Error: ${pluginCallResult.result.error || 'Unknown error'}`
                      : 'Error: No result returned from plugin';
                  } else {
                    toolResult = 'Error: Plugin tools not available';
                  }
                } else {
                  toolResult = `Unknown tool type: ${toolCall.function.name}`;
                }

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

            // Get next response with tools still available for multi-turn
            try {
              currentResponse = await llm.generateResponse({
                ...llmOptions,
                messages: llmMessages,
                tools: tools.length > 0 ? tools : undefined,
              });
              finalResponse = currentResponse.content;

              if (currentResponse.usage && totalUsage) {
                totalUsage.promptTokens += currentResponse.usage.promptTokens;
                totalUsage.completionTokens += currentResponse.usage.completionTokens;
                totalUsage.totalTokens += currentResponse.usage.totalTokens;
                totalUsage.cost = (totalUsage.cost ?? 0) + (currentResponse.usage.cost ?? 0);
              }
            } catch (llmError) {
              const errorMessage = llmError instanceof Error ? llmError.message : String(llmError);
              finalResponse = `Error during tool execution: ${errorMessage}`;
              break;
            }
          }

          if (toolIteration >= MAX_TOOL_ITERATIONS) {
            this.logger.warn('Maximum tool iterations reached (non-streaming)', {
              maxIterations: MAX_TOOL_ITERATIONS,
              taskId,
            });
          }

          llmResponse = {
            content: finalResponse,
            model: modelToUse,
            usage: totalUsage,
            toolCalls: allToolCallsExecuted,
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
      // Skip if task is part of a graph - graph module handles memory saving with proper context
      if (
        !task.graphId &&
        this.agent &&
        'addMemory' in this.agent &&
        typeof this.agent.addMemory === 'function'
      ) {
        await this.agent.addMemory(task.prompt, {
          role: 'user',
          type: 'task_execution',
          taskId: taskId,
          source: 'task',
        });

        await this.agent.addMemory(llmResponse.content, {
          role: 'assistant',
          type: 'task_response',
          taskId: taskId,
          model: llmResponse.model || '',
          source: 'task',
        });
      }

      if (!updatedTask) {
        throw new Error(`Failed to update task ${taskId} after execution`);
      }

      return {
        task: updatedTask,
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

  async getTask(id: string): Promise<TaskType | null> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    const task = await this.getKnex()(tableName).where({ id, agentId: this.agent.id }).first();

    if (!task) return null;

    // Decrypt sensitive fields
    const decryptedTask = await decryptSensitiveFields(
      task as Record<string, string | number | boolean | null>,
      'tasks'
    );
    return this.formatTask(decryptedTask as unknown as TaskDbRow);
  }

  async listTasks(options: TaskSearchOptions = {}): Promise<TaskType[]> {
    this.logger.info('Listing tasks');

    this.logger.debug('Listing tasks with options', {
      limit: options.limit || DEFAULT_TASK_CONFIG.searchLimit,
      offset: options.offset || DEFAULT_TASK_CONFIG.searchOffset,
      status: options.status || DEFAULT_TASK_CONFIG.logStatus,
      graphId: options.graphId || 'all',
      orderBy: options.orderBy || DEFAULT_TASK_CONFIG.searchOrderBy,
      order: options.order || DEFAULT_TASK_CONFIG.searchOrder,
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'tasks';

    const {
      limit: rawLimit,
      offset: rawOffset,
      status,
      graphId,
      orderBy = 'createdAt',
      order = 'desc',
    } = options;

    // Use ?? for numeric values that could be 0
    const limit = rawLimit ?? 100;
    const offset = rawOffset ?? 0;

    const orderColumn =
      orderBy === 'createdAt'
        ? 'created_at'
        : orderBy === 'updatedAt'
          ? 'updated_at'
          : orderBy === 'completedAt'
            ? 'completed_at'
            : 'created_at';

    let query = this.getKnex()(tableName)
      .where({ agentId: this.agent.id })
      .orderBy(orderColumn, order)
      .limit(limit)
      .offset(offset);

    if (status) {
      query = query.andWhere({ status });
    }

    if (graphId !== undefined) {
      query = query.andWhere({ graphId });
    }

    const tasks = await query;

    // Decrypt tasks using centralized decryption
    const decryptedTasks = await Promise.all(
      tasks.map(async (task) => {
        try {
          const decrypted = await decryptSensitiveFields(
            task as Record<string, string | number | boolean | null>,
            'tasks'
          );
          return this.formatTask(decrypted as unknown as TaskDbRow);
        } catch {
          // Handle unencrypted data gracefully
          this.logger.debug('Failed to decrypt task during list', { taskId: task.id });
          return this.formatTask(task);
        }
      })
    );
    return decryptedTasks;
  }

  async updateTask(id: string, updates: Partial<TaskType>): Promise<TaskType | null> {
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
    const encryptedUpdateData = await encryptSensitiveFields(updateData, 'tasks');

    const [task] = await this.getKnex()(tableName)
      .where({ id, agentId: this.agent.id })
      .update(encryptedUpdateData)
      .returning('*');

    if (!task) return null;

    // Decrypt for response
    const decryptedTask = await decryptSensitiveFields(
      task as Record<string, string | number | boolean | null>,
      'tasks'
    );
    return this.formatTask(decryptedTask as unknown as TaskDbRow);
  }

  private async updateTaskStatus(id: string, status: TaskStatus): Promise<TaskType | null> {
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

  async deleteTask(id: string): Promise<boolean> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    const deleted = await this.getKnex()(tableName).where({ id, agentId: this.agent.id }).delete();

    return deleted > 0;
  }

  async clearTasks(): Promise<number> {
    await this.ensureDatabase();
    const tableName = 'tasks';

    return await this.getKnex()(tableName).where({ agentId: this.agent.id }).delete();
  }

  private formatTask(task: TaskDbRow): TaskType {
    // Safe JSON parse for metadata
    let metadata: MetadataObject | undefined;
    try {
      if (task.metadata) {
        metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      }
    } catch {
      this.logger?.warn('Failed to parse task metadata', { taskId: task.id });
      metadata = undefined;
    }

    // Safe JSON parse for executionContext
    let executionContext: Record<string, unknown> | undefined;
    try {
      const execCtx = (task as unknown as Record<string, unknown>).executionContext;
      if (execCtx) {
        executionContext = typeof execCtx === 'string' ? JSON.parse(execCtx) : execCtx;
      }
    } catch {
      this.logger?.warn('Failed to parse execution context', { taskId: task.id });
      executionContext = undefined;
    }

    return {
      id: task.id,
      agentId: task.agentId,
      graphId: (task as unknown as Record<string, unknown>).graphId as string | undefined,
      graphNodeId: (task as unknown as Record<string, unknown>).graphNodeId as string | undefined,
      prompt: task.prompt,
      response: task.response ?? undefined,
      status: task.status,
      metadata,
      executionContext,
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
