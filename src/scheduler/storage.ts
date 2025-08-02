import { Knex } from 'knex';
import { getDatabase } from '../database/index';
import { ScheduledItem, Schedule } from './types';

// Database row interface for scheduled_items table
interface ScheduledItemDbRow {
  id: string;
  type: string;
  schedule: string; // JSON string
  target_id: string;
  agent_id: number;
  status: string;
  execution_count: number;
  last_executed_at: string | null;
  next_execution_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null; // JSON string
}

export class SchedulerStorage {
  private knex: Knex;
  private initialized: boolean = false;

  constructor() {
    // Note: knex will be initialized in initialize() method
    this.knex = null!; // Will be initialized in initialize()
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const db = await getDatabase();
    this.knex = db.getKnex();
    await this.createTables();
    this.initialized = true;
  }

  async initializeTables(): Promise<void> {
    await this.initialize();
  }

  private async createTables(): Promise<void> {
    // Create scheduled_items table
    const hasScheduledItemsTable = await this.knex.schema.hasTable('scheduled_items');
    if (!hasScheduledItemsTable) {
      await this.knex.schema.createTable('scheduled_items', (table) => {
        table.string('id').primary();
        table.enu('type', ['task', 'graph', 'graph_node']).notNullable();
        table.text('schedule').notNullable(); // JSON string containing schedule configuration
        table.string('target_id').notNullable(); // Task ID, Graph ID, or Node ID (format: graph_id:node_id for nodes)
        table.integer('agent_id').notNullable();
        table.enu('status', ['pending', 'running', 'completed', 'failed', 'cancelled']).notNullable().defaultTo('pending');
        table.integer('execution_count').defaultTo(0);
        table.timestamp('last_executed_at').nullable();
        table.timestamp('next_execution_at').nullable();
        table.timestamps(true, true);
        table.text('metadata').nullable(); // JSON string for additional options
        
        // Create indexes for efficient querying
        table.index(['agent_id', 'status']);
        table.index(['next_execution_at']);
        table.index(['type', 'target_id']);
        table.index(['status', 'next_execution_at']);
      });
    }
  }

  async saveScheduledItem(item: ScheduledItem): Promise<void> {
    await this.initialize();
    
    await this.knex('scheduled_items').insert({
      id: item.id,
      type: item.type,
      schedule: JSON.stringify(item.schedule),
      target_id: item.targetId.toString(),
      agent_id: item.agentId,
      status: item.status,
      execution_count: item.executionCount,
      last_executed_at: item.lastExecutedAt?.toISOString() || null,
      next_execution_at: item.nextExecutionAt?.toISOString() || null,
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
      metadata: item.metadata ? JSON.stringify(item.metadata) : null
    });
  }

  async getScheduledItem(id: string, agentId: number): Promise<ScheduledItem | null> {
    await this.initialize();
    
    const row = await this.knex('scheduled_items')
      .where({ id, agent_id: agentId })
      .first();

    return row ? this.formatScheduledItem(row) : null;
  }

  async updateScheduledItem(id: string, agentId: number, updates: Partial<ScheduledItem>): Promise<void> {
    await this.initialize();
    
    const updateData: Partial<ScheduledItemDbRow> = {};
    
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.executionCount !== undefined) updateData.execution_count = updates.executionCount;
    if (updates.lastExecutedAt !== undefined) updateData.last_executed_at = updates.lastExecutedAt?.toISOString() || null;
    if (updates.nextExecutionAt !== undefined) updateData.next_execution_at = updates.nextExecutionAt?.toISOString() || null;
    if (updates.updatedAt !== undefined) updateData.updated_at = updates.updatedAt.toISOString();
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;

    await this.knex('scheduled_items')
      .where({ id, agent_id: agentId })
      .update(updateData);
  }

  async listScheduledItems(agentId: number, status?: string): Promise<ScheduledItem[]> {
    await this.initialize();
    
    let query = this.knex('scheduled_items')
      .where({ agent_id: agentId });

    if (status) {
      query = query.where({ status });
    }

    const rows = await query.select('*').orderBy('next_execution_at', 'asc');
    return rows.map(this.formatScheduledItem);
  }

  async getDueScheduledItems(agentId: number, beforeTime: Date, limit: number): Promise<ScheduledItem[]> {
    await this.initialize();
    
    const rows = await this.knex('scheduled_items')
      .where({ agent_id: agentId, status: 'pending' })
      .where('next_execution_at', '<=', beforeTime.toISOString())
      .limit(limit)
      .select('*')
      .orderBy('next_execution_at', 'asc');

    return rows.map(this.formatScheduledItem);
  }

  async deleteScheduledItem(id: string, agentId: number): Promise<boolean> {
    await this.initialize();
    
    const deleted = await this.knex('scheduled_items')
      .where({ id, agent_id: agentId })
      .delete();

    return deleted > 0;
  }

  async getScheduledItemsByType(agentId: number, type: string): Promise<ScheduledItem[]> {
    await this.initialize();
    
    const rows = await this.knex('scheduled_items')
      .where({ agent_id: agentId, type })
      .select('*')
      .orderBy('created_at', 'desc');

    return rows.map(this.formatScheduledItem);
  }

  async getScheduledItemsByTarget(agentId: number, targetId: string): Promise<ScheduledItem[]> {
    await this.initialize();
    
    const rows = await this.knex('scheduled_items')
      .where({ agent_id: agentId, target_id: targetId })
      .select('*')
      .orderBy('created_at', 'desc');

    return rows.map(this.formatScheduledItem);
  }

  async getScheduledItemsStats(agentId: number): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  }> {
    await this.initialize();
    
    const stats = await this.knex('scheduled_items')
      .where({ agent_id: agentId })
      .select('status')
      .count('* as count')
      .groupBy('status');

    const result = {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };

    for (const stat of stats) {
      const count = parseInt(stat.count as string);
      result.total += count;
      result[stat.status as keyof typeof result] = count;
    }

    return result;
  }

  async cleanupCompletedItems(agentId: number, olderThanDays = 30): Promise<number> {
    await this.initialize();
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const deleted = await this.knex('scheduled_items')
      .where({ agent_id: agentId })
      .whereIn('status', ['completed', 'failed', 'cancelled'])
      .where('updated_at', '<', cutoffDate.toISOString())
      .delete();

    return deleted;
  }

  private formatScheduledItem(row: ScheduledItemDbRow): ScheduledItem {
    return {
      id: row.id,
      type: row.type as 'task' | 'graph' | 'graph_node',
      schedule: JSON.parse(row.schedule) as Schedule,
      targetId: row.target_id,
      agentId: row.agent_id,
      status: row.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
      executionCount: row.execution_count,
      lastExecutedAt: row.last_executed_at ? new Date(row.last_executed_at) : undefined,
      nextExecutionAt: row.next_execution_at ? new Date(row.next_execution_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }
}

let storage: SchedulerStorage | null = null;

export function getSchedulerStorage(): SchedulerStorage {
  if (!storage) {
    storage = new SchedulerStorage();
  }
  return storage;
}

export async function initializeSchedulerStorage(): Promise<void> {
  const storage = getSchedulerStorage();
  await storage.initializeTables();
}