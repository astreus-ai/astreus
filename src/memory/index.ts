import { Knex } from 'knex';
import { getDatabase } from '../database';
import { Memory as MemoryType, MemorySearchOptions } from './types';

class Memory {
  private agentId: number;
  private knex: Knex;

  constructor(agentId: number) {
    this.agentId = agentId;
    const db = getDatabase();
    this.knex = (db as any).knex;
  }

  private getMemoryTableName(): string {
    return `agent_${this.agentId}_memories`;
  }

  async initializeMemoryTable(): Promise<void> {
    const memoryTableName = this.getMemoryTableName();
    
    // Create memories table
    const hasMemoryTable = await this.knex.schema.hasTable(memoryTableName);
    if (!hasMemoryTable) {
      await this.knex.schema.createTable(memoryTableName, (table) => {
        table.increments('id').primary();
        table.integer('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.text('content').notNullable();
        table.specificType('embedding', 'float[]');
        table.json('metadata');
        table.timestamps(true, true);
        table.index(['agentId']);
        table.index(['created_at']);
      });
    }
  }

  async addMemory(content: string, metadata?: Record<string, any>): Promise<MemoryType> {
    const tableName = this.getMemoryTableName();
    
    const [memory] = await this.knex(tableName)
      .insert({
        agentId: this.agentId,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null
      })
      .returning('*');
    
    return this.formatMemory(memory);
  }

  async getMemory(id: number): Promise<MemoryType | null> {
    const tableName = this.getMemoryTableName();
    
    const memory = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .first();
    
    return memory ? this.formatMemory(memory) : null;
  }

  async listMemories(options: MemorySearchOptions = {}): Promise<MemoryType[]> {
    const tableName = this.getMemoryTableName();
    
    const {
      limit = 100,
      offset = 0,
      orderBy = 'createdAt',
      order = 'desc'
    } = options;

    const orderColumn = orderBy === 'createdAt' ? 'created_at' : 
                       orderBy === 'updatedAt' ? 'updated_at' : 'created_at';

    const memories = await this.knex(tableName)
      .where({ agentId: this.agentId })
      .orderBy(orderColumn, order)
      .limit(limit)
      .offset(offset);
    
    return memories.map(memory => this.formatMemory(memory));
  }

  async updateMemory(id: number, updates: Partial<MemoryType>): Promise<MemoryType | null> {
    const tableName = this.getMemoryTableName();
    
    const updateData: any = {};
    
    if (updates.content !== undefined) updateData.content = updates.content;
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata);
    if (updates.embedding !== undefined) updateData.embedding = updates.embedding;
    
    if (Object.keys(updateData).length === 0) {
      return this.getMemory(id);
    }
    
    const [memory] = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .update(updateData)
      .returning('*');
    
    return memory ? this.formatMemory(memory) : null;
  }

  async deleteMemory(id: number): Promise<boolean> {
    const tableName = this.getMemoryTableName();
    
    const deleted = await this.knex(tableName)
      .where({ id, agentId: this.agentId })
      .delete();
    
    return deleted > 0;
  }

  async clearMemories(): Promise<number> {
    const tableName = this.getMemoryTableName();
    
    return await this.knex(tableName)
      .where({ agentId: this.agentId })
      .delete();
  }

  async searchMemories(query: string, limit: number = 10): Promise<MemoryType[]> {
    const tableName = this.getMemoryTableName();
    
    const memories = await this.knex(tableName)
      .where({ agentId: this.agentId })
      .andWhere('content', 'ilike', `%${query}%`)
      .orderBy('created_at', 'desc')
      .limit(limit);
    
    return memories.map(memory => this.formatMemory(memory));
  }

  private formatMemory(memory: any): MemoryType {
    return {
      id: memory.id,
      agentId: memory.agentId,
      content: memory.content,
      embedding: memory.embedding,
      metadata: memory.metadata ? JSON.parse(memory.metadata) : undefined,
      createdAt: new Date(memory.created_at),
      updatedAt: new Date(memory.updated_at)
    };
  }
}

// Static function for initializing memory table
export async function initializeMemoryTable(agentId: number): Promise<void> {
  const memory = new Memory(agentId);
  await memory.initializeMemoryTable();
}

export { Memory };
export * from './types';