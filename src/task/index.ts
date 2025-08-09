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
  LLMStreamChunk,
  LLMMessage,
  LLMMessageContent,
  LLMMessageContentPart,
} from '../llm';
import { Memory } from '../memory';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';
import { Logger } from '../logger/types';
import { getEncryptionService } from '../database/encryption';
import * as fs from 'fs/promises';
import * as path from 'path';

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

interface AgentDbRow {
  id: number;
  name: string;
  systemPrompt?: string;
  model?: string;
  embeddingModel?: string;
  visionModel?: string;
  temperature?: number;
  maxTokens?: number;
  useTools?: boolean;
  memory?: boolean;
}

export class Task implements IAgentModule {
  readonly name = 'task';
  private knex: Knex | null = null;
  private logger: Logger;
  private encryption = getEncryptionService();

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
  private async encryptTaskData(data: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      encrypted.metadata = await this.encryption.encryptJSON(encrypted.metadata, 'tasks.metadata');
    }

    return encrypted;
  }

  /**
   * Decrypt sensitive task fields after retrieving
   */
  private async decryptTaskData(data: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      decrypted.metadata = await this.encryption.decryptJSON(
        String(decrypted.metadata),
        'tasks.metadata'
      );
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
    const decryptedTask = await this.decryptTaskData(task as Record<string, unknown>);
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
    options?: { model?: string; stream?: boolean }
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
      // Get agent info for system prompt
      const agentData: AgentDbRow | undefined = await this.knex!('agents')
        .where({ id: this.agent.id })
        .first();

      // Check if tools should be used for this specific task
      const taskUseTools = task.metadata?.useTools;
      const agentUseTools = agentData?.useTools;
      const shouldUseTools = taskUseTools !== undefined ? taskUseTools : agentUseTools !== false;

      let llmResponse: LLMResponse;

      // Add memory context if agent has memory enabled
      const agentHasMemory = agentData?.memory || false;

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
          model: options?.model || agentData?.model || 'gpt-4o',
        };
      } else if (
        shouldUseTools &&
        this.agent &&
        'executeTaskWithTools' in this.agent &&
        typeof this.agent.executeTaskWithTools === 'function'
      ) {
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

        // Execute task with tools
        const result = await this.agent.executeTaskWithTools(contextualPrompt, {
          enableTools: true,
          stream: options?.stream || false,
        });

        llmResponse = {
          content: result.response,
          model: result.model || options?.model || agentData?.model || 'gpt-4o',
          usage: result.usage,
          toolCalls: result.toolCalls,
        };
      } else {
        // Fallback to standard LLM execution without tools
        const llm = getLLM(this.logger);

        // Prepare messages for LLM
        const llmMessages: LLMMessage[] = [];

        if (agentHasMemory) {
          const memory = new Memory(this.agent);
          const recentMemories = await memory.listMemories({
            limit: 20,
            orderBy: 'createdAt',
            order: 'asc',
          });

          // Add memories as conversation history
          for (const mem of recentMemories) {
            if (mem.metadata?.type === 'user_message') {
              llmMessages.push({ role: 'user', content: mem.content });
            } else if (mem.metadata?.type === 'assistant_response') {
              llmMessages.push({ role: 'assistant', content: mem.content });
            }
          }
        }

        // Process attachments if present
        let userMessageContent: LLMMessageContent = task.prompt;

        if (task.metadata?.attachments) {
          try {
            const attachments = JSON.parse(task.metadata.attachments as string);
            const imageAttachments = attachments.filter(
              (att: { type: string; path: string }) => att.type === 'image'
            );

            if (imageAttachments.length > 0) {
              // Use visionModel if specified, otherwise fall back to main model
              const visionModel =
                agentData?.visionModel || options?.model || agentData?.model || 'gpt-4o';
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
          hasImages && agentData?.visionModel
            ? agentData.visionModel
            : options?.model || agentData?.model || 'gpt-4o';

        this.logger.debug('Model selection for task execution', {
          hasImages: !!hasImages,
          agentVisionModel: agentData?.visionModel || 'none',
          agentMainModel: agentData?.model || 'none',
          optionsModel: options?.model || 'none',
          modelToUse: modelToUse,
          taskId: taskId,
        });

        const llmOptions = {
          model: modelToUse,
          messages: llmMessages,
          temperature: agentData?.temperature || 0.7,
          maxTokens: agentData?.maxTokens || 4096,
          systemPrompt: agentData?.systemPrompt,
        };

        if (options?.stream) {
          // Stream response
          let fullContent = '';
          const chunks: LLMStreamChunk[] = [];

          for await (const chunk of llm.generateStreamResponse(llmOptions)) {
            fullContent += chunk.content;
            chunks.push(chunk);
          }

          llmResponse = {
            content: fullContent,
            model: chunks[0]?.model || options?.model || agentData?.model || 'gpt-4o',
          };
        } else {
          // Generate response using LLM
          llmResponse = await llm.generateResponse(llmOptions);
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

      // Add to memory if agent has memory enabled
      if (agentHasMemory) {
        const memory = new Memory(this.agent);

        // Store user prompt
        await memory.addMemory(task.prompt, {
          type: 'user_message',
          taskId: taskId,
        });

        // Store assistant response
        await memory.addMemory(llmResponse.content, {
          type: 'assistant_response',
          taskId: taskId,
          model: llmResponse.model,
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
    const decryptedTask = await this.decryptTaskData(task as Record<string, unknown>);
    return this.formatTask(decryptedTask as unknown as TaskDbRow);
  }

  async listTasks(options: TaskSearchOptions = {}): Promise<TaskType[]> {
    this.logger.info('Listing tasks');

    this.logger.debug('Listing tasks with options', {
      limit: options.limit || 100,
      offset: options.offset || 0,
      status: options.status || 'all',
      orderBy: options.orderBy || 'createdAt',
      order: options.order || 'desc',
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
            const decrypted = await this.decryptTaskData(task as Record<string, unknown>);
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
    const decryptedTask = await this.decryptTaskData(task as Record<string, unknown>);
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
      metadata: task.metadata ? JSON.parse(task.metadata) : undefined,
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

  return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
}

// Export types
export type {
  Task as TaskType,
  TaskRequest,
  TaskResponse,
  TaskSearchOptions,
  TaskStatus,
} from './types';
