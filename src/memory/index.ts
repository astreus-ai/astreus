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
    // User-facing info log
    const memoryType = metadata?.type || 'general';
    this.logger.info(`Adding new ${memoryType} memory`);
    
    this.logger.debug('Adding memory', {
      contentLength: content.length,
      agentId: this.agent.id,
      contentPreview: content.slice(0, 100) + '...',
      type: metadata?.type ? String(metadata.type) : 'general',
      hasMetadata: !!metadata
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
    
    const formattedMemory = this.formatMemory(memory);
    
    this.logger.debug('Memory added successfully', {
      memoryId: formattedMemory.id || 0,
      type: String(memoryType)
    });
    
    return formattedMemory;
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
    // User-facing info log
    this.logger.info(`Searching memories for: "${query}"`);
    
    this.logger.debug('Searching memories', {
      query,
      ...(options?.limit && { limit: options.limit }),
      ...(options?.startDate && { startDate: options.startDate }),
      ...(options?.endDate && { endDate: options.endDate }),
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
    
    // User-facing result summary
    this.logger.info(`Found ${memories.length} matching ${memories.length === 1 ? 'memory' : 'memories'}`);
    
    this.logger.debug(`Found ${memories.length} memories`, {
      resultCount: memories.length,
      sampleIds: memories.slice(0, 3).map(m => Number(m.id)),
      hasResults: memories.length > 0
    });
    
    return memories.map(memory => this.formatMemory(memory));
  }

  /**
   * List memories
   */
  async listMemories(options?: MemorySearchOptions): Promise<MemoryType[]> {
    // User-facing info log
    this.logger.info('Listing memories');
    
    this.logger.debug('Listing memories', {
      ...(options?.limit && { limit: options.limit }),
      ...(options?.orderBy && { orderBy: options.orderBy }),
      ...(options?.startDate && { startDate: options.startDate }),
      ...(options?.endDate && { endDate: options.endDate }),
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
    this.logger.info(`Deleting memory: ${id}`);
    
    await this.ensureDatabase();
    const tableName = 'memories';

    const deleted = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .delete();
    
    const success = deleted > 0;
    
    if (success) {
      this.logger.info(`Memory ${id} deleted successfully`);
    } else {
      this.logger.warn(`Failed to delete memory ${id} - not found or unauthorized`);
    }
    
    this.logger.debug('Delete memory result', {
      memoryId: id,
      success,
      agentId: this.agent.id
    });
    
    return success;
  }

  /**
   * Clear all memories
   */
  async clearMemories(): Promise<number> {
    this.logger.info('Clearing all memories');
    
    await this.ensureDatabase();
    const tableName = 'memories';

    const deletedCount = await this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .delete();
    
    this.logger.info(`Cleared ${deletedCount} ${deletedCount === 1 ? 'memory' : 'memories'}`);
    
    this.logger.debug('Clear memories result', {
      deletedCount,
      agentId: this.agent.id
    });
    
    return deletedCount;
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