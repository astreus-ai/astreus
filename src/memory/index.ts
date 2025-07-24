import { IAgentModule, IAgent } from '../agent/types';
import { Memory as MemoryType, MemorySearchOptions } from './types';
import { getDatabase } from '../database';
import { MetadataObject } from '../types';
import { Logger } from '../logger/types';
import { Knex } from 'knex';


interface MemoryDbRow {
  id: number;
  agentId: number;
  content: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Memory module for agent conversation memory
 */
export class Memory implements IAgentModule {
  readonly name = 'memory';
  private knex: Knex | null = null;
  private logger: Logger;

  constructor(private agent: IAgent) {
    this.logger = agent.logger;
  }

  async initialize(): Promise<void> {
    await this.ensureDatabase();
    await this.initializeMemoryTable();
  }

  private async ensureDatabase(): Promise<void> {
    if (!this.knex) {
      const db = await getDatabase();
      this.knex = db.getKnex();
    }
  }


  private async initializeMemoryTable(): Promise<void> {
    // Memories table is now shared and initialized in the main database module
    // This method is kept for compatibility but does nothing
  }

  /**
   * Add a memory
   */
  async addMemory(content: string, metadata?: MetadataObject): Promise<MemoryType> {
    this.logger.debug('Adding memory', {
      contentLength: content.length,
      agentId: this.agent.id,
      ...(metadata?.type && { type: metadata.type as string })
    });
    
    await this.ensureDatabase();
    const tableName = 'memories';

    const [memory] = await this.knex!(tableName)
      .insert({
        agentId: this.agent.id,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null
      })
      .returning('*');
    
    return this.formatMemory(memory);
  }

  /**
   * Remember a conversation (alias for add with conversation metadata)
   */
  async rememberConversation(content: string, role: 'user' | 'assistant' = 'user'): Promise<MemoryType> {
    return this.addMemory(content, { type: 'conversation', role });
  }

  /**
   * Get a memory by ID
   */
  async getMemory(id: number): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';
    
    const memory = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .first();
    
    return memory ? this.formatMemory(memory) : null;
  }

  /**
   * Search memories
   */
  async searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryType[]> {
    this.logger.debug('Searching memories', {
      query,
      ...(options?.limit && { limit: options.limit }),
      agentId: this.agent.id
    });
    
    await this.ensureDatabase();
    const tableName = 'memories';
    
    const limit = options?.limit || 10;
    const offset = options?.offset || 0;

    let dbQuery = this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .where('content', 'like', `%${query}%`)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    if (options?.startDate) {
      dbQuery = dbQuery.where('created_at', '>=', options.startDate);
    }

    if (options?.endDate) {
      dbQuery = dbQuery.where('created_at', '<=', options.endDate);
    }

    const memories = await dbQuery;
    
    this.logger.debug(`Found ${memories.length} memories`);
    
    return memories.map(memory => this.formatMemory(memory));
  }

  /**
   * List memories
   */
  async listMemories(options?: MemorySearchOptions): Promise<MemoryType[]> {
    this.logger.debug('Listing memories', {
      ...(options?.limit && { limit: options.limit }),
      ...(options?.orderBy && { orderBy: options.orderBy }),
      agentId: this.agent.id
    });
    
    await this.ensureDatabase();
    const tableName = 'memories';
    
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    let query = this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    if (options?.startDate) {
      query = query.where('created_at', '>=', options.startDate);
    }

    if (options?.endDate) {
      query = query.where('created_at', '<=', options.endDate);
    }

    const memories = await query;
    return memories.map(memory => this.formatMemory(memory));
  }

  /**
   * Update a memory
   */
  async updateMemory(id: number, updates: { content?: string; metadata?: MetadataObject }): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';

    const updateData: Partial<MemoryDbRow> = {};
    if (updates.content !== undefined) {
      updateData.content = updates.content;
    }
    if (updates.metadata !== undefined) {
      updateData.metadata = JSON.stringify(updates.metadata);
    }

    if (Object.keys(updateData).length === 0) {
      return this.getMemory(id);
    }

    const [memory] = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .update(updateData)
      .returning('*');
    
    return memory ? this.formatMemory(memory) : null;
  }

  /**
   * Delete a memory
   */
  async deleteMemory(id: number): Promise<boolean> {
    await this.ensureDatabase();
    const tableName = 'memories';

    const deleted = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .delete();
    
    return deleted > 0;
  }

  /**
   * Clear all memories
   */
  async clearMemories(): Promise<number> {
    await this.ensureDatabase();
    const tableName = 'memories';

    return await this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .delete();
  }

  /**
   * Format memory from database
   */
  private formatMemory(memory: MemoryDbRow): MemoryType {
    return {
      id: memory.id,
      agentId: memory.agentId,
      content: memory.content,
      metadata: memory.metadata ? JSON.parse(memory.metadata) : undefined,
      createdAt: new Date(memory.created_at),
      updatedAt: new Date(memory.updated_at)
    };
  }
}

// Export types  
export type { Memory as MemoryType, MemorySearchOptions } from './types';