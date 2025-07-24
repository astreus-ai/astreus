import { IAgentModule, IAgent } from '../agent/types';
import { Task as TaskType, TaskSearchOptions, TaskStatus, TaskRequest, TaskResponse } from './types';
import { getDatabase } from '../database';
import { getLLM } from '../llm';
import { Memory } from '../memory';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';

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
  temperature?: number;
  maxTokens?: number;
  useTools?: boolean;
  memory?: boolean;
}

interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: Record<string, string | number | boolean | null>;
    };
  }>;
}

interface LLMStreamChunk {
  content: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}


export class Task implements IAgentModule {
  readonly name = 'task';
  private knex: Knex | null = null;

  constructor(private agent: IAgent) {}

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

  async createTask(request: TaskRequest): Promise<TaskType> {
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
              const fs = await import('fs/promises');
              const content = await fs.readFile(attachment.path, 'utf-8');
              const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
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

    const [task] = await this.knex!(tableName)
      .insert({
        agentId: this.agent.id,
        prompt: enhancedPrompt,
        response: null,
        status: 'pending',
        metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
      })
      .returning('*');
    
    return this.formatTask(task);
  }

  async executeTask(taskId: number, options?: { model?: string; stream?: boolean }): Promise<TaskResponse> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
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
      const shouldUseTools = taskUseTools !== undefined ? taskUseTools : (agentUseTools !== false);

      let llmResponse: LLMResponse;
      
      // Add memory context if agent has memory enabled
      const agentHasMemory = agentData?.memory || false;

      // Add task-level MCP servers if specified
      if (task.metadata?.mcpServers && this.agent && 'addMCPServers' in this.agent && typeof this.agent.addMCPServers === 'function') {
        await this.agent.addMCPServers(task.metadata.mcpServers);
      }

      // Add task-level plugins if specified
      if (task.metadata?.plugins && typeof task.metadata.plugins === 'string' && this.agent && 'registerPlugin' in this.agent && typeof this.agent.registerPlugin === 'function') {
        try {
          const parsedPlugins = JSON.parse(task.metadata.plugins);
          if (Array.isArray(parsedPlugins)) {
            for (const pluginData of parsedPlugins) {
              await this.agent.registerPlugin(pluginData.plugin, pluginData.config);
            }
          }
        } catch (error) {
          console.warn('Failed to parse plugins metadata:', error);
        }
      }

      // If agent has tools support and this task should use tools
      if (shouldUseTools && this.agent && 'executeTaskWithTools' in this.agent && typeof this.agent.executeTaskWithTools === 'function') {
        
        // Build the prompt with memory context if needed
        let contextualPrompt = task.prompt;
        
        if (agentHasMemory) {
          const memory = new Memory(this.agent);
          const recentMemories = await memory.listMemories({
            limit: 20,
            orderBy: 'createdAt',
            order: 'asc'
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
          stream: options?.stream || false
        });

        llmResponse = {
          content: result.response,
          model: result.model || options?.model || agentData?.model || 'gpt-4o',
          usage: result.usage,
          toolCalls: result.toolCalls
        };

      } else {
        // Fallback to standard LLM execution without tools
        const llm = getLLM();
        
        // Prepare messages for LLM
        const llmMessages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
        
        if (agentHasMemory) {
          const memory = new Memory(this.agent);
          const recentMemories = await memory.listMemories({
            limit: 20,
            orderBy: 'createdAt',
            order: 'asc'
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
        
        // Add current prompt
        llmMessages.push({ role: 'user', content: task.prompt });

        const llmOptions = {
          model: options?.model || agentData?.model || 'gpt-4o',
          messages: llmMessages,
          temperature: agentData?.temperature || 0.7,
          maxTokens: agentData?.maxTokens || 4096,
          systemPrompt: agentData?.systemPrompt
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
            usage: chunks[chunks.length - 1]?.usage
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
        completedAt: new Date()
      });

      // Add to memory if agent has memory enabled
      if (agentHasMemory) {
        const memory = new Memory(this.agent);
        
        // Store user prompt
        await memory.addMemory(task.prompt, {
          type: 'user_message',
          taskId: taskId
        });
        
        // Store assistant response
        await memory.addMemory(llmResponse.content, {
          type: 'assistant_response',
          taskId: taskId,
          model: llmResponse.model
        });
      }

      return {
        task: updatedTask!,
        response: llmResponse.content,
        model: llmResponse.model,
        usage: llmResponse.usage
      };

    } catch (error) {
      // Mark task as failed
      await this.updateTaskStatus(taskId, 'failed');
      throw error;
    }
  }


  async getTask(id: number): Promise<TaskType | null> {
    await this.ensureDatabase();
    const tableName = 'tasks';
    
    const task = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .first();
    
    return task ? this.formatTask(task) : null;
  }

  async listTasks(options: TaskSearchOptions = {}): Promise<TaskType[]> {
    await this.ensureDatabase();
    const tableName = 'tasks';
    
    const {
      limit = 100,
      offset = 0,
      status,
      orderBy = 'createdAt',
      order = 'desc'
    } = options;

    const orderColumn = orderBy === 'createdAt' ? 'created_at' : 
                       orderBy === 'updatedAt' ? 'updated_at' : 
                       orderBy === 'completedAt' ? 'completedAt' : 'created_at';

    let query = this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .orderBy(orderColumn, order)
      .limit(limit)
      .offset(offset);

    if (status) {
      query = query.andWhere({ status });
    }

    const tasks = await query;
    return tasks.map(task => this.formatTask(task));
  }

  async updateTask(id: number, updates: Partial<TaskType>): Promise<TaskType | null> {
    await this.ensureDatabase();
    const tableName = 'tasks';
    
    const updateData: Partial<TaskDbRow> = {};
    
    if (updates.prompt !== undefined) updateData.prompt = updates.prompt;
    if (updates.response !== undefined) updateData.response = updates.response;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata);
    if (updates.completedAt !== undefined) updateData.completedAt = updates.completedAt instanceof Date ? updates.completedAt.toISOString() : updates.completedAt;
    
    if (Object.keys(updateData).length === 0) {
      return this.getTask(id);
    }
    
    const [task] = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .update(updateData)
      .returning('*');
    
    return task ? this.formatTask(task) : null;
  }

  private async updateTaskStatus(id: number, status: TaskStatus): Promise<TaskType | null> {
    const updateData: Partial<TaskDbRow> = { status };
    
    if (status === 'completed') {
      updateData.completedAt = new Date().toISOString();
    }
    
    // Convert TaskDbRow format to TaskType format for the updateTask method
    const taskTypeUpdate: Partial<TaskType> = {
      status: updateData.status,
      ...(updateData.completedAt && { completedAt: new Date(updateData.completedAt) })
    };
    
    return this.updateTask(id, taskTypeUpdate);
  }

  async deleteTask(id: number): Promise<boolean> {
    await this.ensureDatabase();
    const tableName = 'tasks';
    
    const deleted = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .delete();
    
    return deleted > 0;
  }

  async clearTasks(): Promise<number> {
    await this.ensureDatabase();
    const tableName = 'tasks';
    
    return await this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .delete();
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
      completedAt: task.completedAt ? new Date(task.completedAt) : undefined
    };
  }
}

// Export types
export type { Task as TaskType, TaskRequest, TaskResponse, TaskSearchOptions, TaskStatus } from './types';