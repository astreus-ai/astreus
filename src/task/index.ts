import { Knex } from 'knex';
import { getDatabase } from '../database';
import { Task as TaskType, TaskSearchOptions, TaskStatus, TaskRequest, TaskResponse } from './types';
import { getLLM } from '../llm';
import { Memory } from '../memory';

class Task {
  private agentId: number;
  private knex: Knex;

  constructor(agentId: number) {
    this.agentId = agentId;
    const db = getDatabase();
    this.knex = (db as any).knex;
  }

  private getTaskTableName(): string {
    return `agent_${this.agentId}_tasks`;
  }

  async initializeTaskTable(): Promise<void> {
    const taskTableName = this.getTaskTableName();
    
    // Create tasks table
    const hasTaskTable = await this.knex.schema.hasTable(taskTableName);
    if (!hasTaskTable) {
      await this.knex.schema.createTable(taskTableName, (table) => {
        table.increments('id').primary();
        table.integer('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.text('prompt').notNullable();
        table.text('response').nullable();
        table.enu('status', ['pending', 'in_progress', 'completed', 'failed']).defaultTo('pending');
        table.json('metadata');
        table.timestamps(true, true);
        table.timestamp('completedAt').nullable();
        table.index(['agentId']);
        table.index(['status']);
        table.index(['created_at']);
      });
    }
  }

  async createTask(request: TaskRequest): Promise<TaskType> {
    const tableName = this.getTaskTableName();

    const [task] = await this.knex(tableName)
      .insert({
        agentId: this.agentId,
        prompt: request.prompt,
        response: null,
        status: 'pending',
        metadata: request.metadata ? JSON.stringify(request.metadata) : null
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
      const agentData = await this.knex('agents')
        .where({ id: this.agentId })
        .first();

      const llm = getLLM();
      
      // Prepare messages for LLM
      const llmMessages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
      
      // Add memory context if agent has memory enabled
      const agentHasMemory = agentData?.memory || false;
      if (agentHasMemory) {
        const memory = new Memory(this.agentId);
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

      let llmResponse: any;
      
      if (options?.stream) {
        // Stream response
        let fullContent = '';
        const chunks: any[] = [];
        
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

      // Update task with response and mark as completed
      const updatedTask = await this.updateTask(taskId, {
        response: llmResponse.content,
        status: 'completed',
        completedAt: new Date()
      });

      // Add to memory if agent has memory enabled
      const agentHasMemory = agentData?.memory || false;
      if (agentHasMemory) {
        const memory = new Memory(this.agentId);
        
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
    const tableName = this.getTaskTableName();
    
    const task = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .first();
    
    return task ? this.formatTask(task) : null;
  }

  async listTasks(options: TaskSearchOptions = {}): Promise<TaskType[]> {
    const tableName = this.getTaskTableName();
    
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

    let query = this.knex(tableName)
      .where({ agentId: this.agentId })
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
    const tableName = this.getTaskTableName();
    
    const updateData: any = {};
    
    if (updates.prompt !== undefined) updateData.prompt = updates.prompt;
    if (updates.response !== undefined) updateData.response = updates.response;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata);
    if (updates.completedAt !== undefined) updateData.completedAt = updates.completedAt;
    
    if (Object.keys(updateData).length === 0) {
      return this.getTask(id);
    }
    
    const [task] = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .update(updateData)
      .returning('*');
    
    return task ? this.formatTask(task) : null;
  }

  async updateTaskStatus(id: number, status: TaskStatus): Promise<TaskType | null> {
    const updateData: any = { status };
    
    if (status === 'completed') {
      updateData.completedAt = new Date();
    }
    
    return this.updateTask(id, updateData);
  }

  async deleteTask(id: number): Promise<boolean> {
    const tableName = this.getTaskTableName();
    
    const deleted = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .delete();
    
    return deleted > 0;
  }

  async clearTasks(): Promise<number> {
    const tableName = this.getTaskTableName();
    
    return await this.knex(tableName)
      .where({ agentId: this.agentId })
      .delete();
  }

  private formatTask(task: any): TaskType {
    return {
      id: task.id,
      agentId: task.agentId,
      prompt: task.prompt,
      response: task.response,
      status: task.status,
      metadata: task.metadata ? JSON.parse(task.metadata) : undefined,
      createdAt: new Date(task.created_at),
      updatedAt: new Date(task.updated_at),
      completedAt: task.completedAt ? new Date(task.completedAt) : undefined
    };
  }
}

// Static function for initializing task table
export async function initializeTaskTable(agentId: number): Promise<void> {
  const task = new Task(agentId);
  await task.initializeTaskTable();
}

export { Task };
export * from './types';