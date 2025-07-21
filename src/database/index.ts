import knex, { Knex } from 'knex';
import { DatabaseConfig } from './types';
import { AgentConfig } from '../agent/types';
import { createKnexConfig } from './knex';

export class Database {
  protected knex: Knex;
  protected config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
    const knexConfig = createKnexConfig(config);
    this.knex = knex(knexConfig);
  }

  async connect(): Promise<void> {
    // Test connection
    await this.knex.raw('SELECT 1');
  }

  async disconnect(): Promise<void> {
    await this.knex.destroy();
  }

  async initialize(): Promise<void> {
    const hasTable = await this.knex.schema.hasTable('agents');
    
    if (!hasTable) {
      await this.knex.schema.createTable('agents', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable().unique();
        table.text('description');
        table.string('model');
        table.float('temperature');
        table.integer('maxTokens');
        table.text('systemPrompt');
        table.boolean('memory').defaultTo(false);
        table.timestamps(true, true);
      });
    }
  }

  async createAgent(data: AgentConfig): Promise<AgentConfig> {
    const [agent] = await this.knex('agents')
      .insert({
        name: data.name,
        description: data.description,
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        systemPrompt: data.systemPrompt,
        memory: data.memory || false
      })
      .returning('*');
    
    return this.formatAgent(agent);
  }

  async getAgent(id: number): Promise<AgentConfig | null> {
    const agent = await this.knex('agents')
      .where({ id })
      .first();
    
    return agent ? this.formatAgent(agent) : null;
  }

  async getAgentByName(name: string): Promise<AgentConfig | null> {
    const agent = await this.knex('agents')
      .where({ name })
      .first();
    
    return agent ? this.formatAgent(agent) : null;
  }

  async listAgents(): Promise<AgentConfig[]> {
    const agents = await this.knex('agents')
      .orderBy('id', 'desc');
    
    return agents.map(agent => this.formatAgent(agent));
  }

  async updateAgent(id: number, data: Partial<AgentConfig>): Promise<AgentConfig | null> {
    const updateData: any = {};
    const allowedFields = ['name', 'description', 'model', 'temperature', 'maxTokens', 'systemPrompt', 'memory'];
    
    for (const field of allowedFields) {
      if (field in data) {
        updateData[field] = (data as any)[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return this.getAgent(id);
    }
    
    const [agent] = await this.knex('agents')
      .where({ id })
      .update(updateData)
      .returning('*');
    
    return agent ? this.formatAgent(agent) : null;
  }

  async deleteAgent(id: number): Promise<boolean> {
    const deleted = await this.knex('agents')
      .where({ id })
      .delete();
    
    return deleted > 0;
  }

  private formatAgent(agent: any): AgentConfig {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      systemPrompt: agent.systemPrompt,
      memory: agent.memory,
      createdAt: new Date(agent.created_at),
      updatedAt: new Date(agent.updated_at)
    };
  }
}

let database: Database | null = null;

export async function initializeDatabase(config: DatabaseConfig): Promise<Database> {
  if (database) {
    await database.disconnect();
  }
  
  database = new Database(config);
  await database.connect();
  await database.initialize();
  
  return database;
}

export function getDatabase(): Database {
  if (!database) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return database;
}

export * from './types';
export default getDatabase;