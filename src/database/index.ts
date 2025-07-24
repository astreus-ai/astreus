import knex, { Knex } from 'knex';
import { DatabaseConfig } from './types';
import { AgentConfig } from '../agent/types';
import { createKnexConfig } from './knex';

interface AgentDbRow {
  id: number;
  name: string;
  description?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  memory: boolean;
  knowledge: boolean;
  vision: boolean;
  useTools: boolean;
  contextCompression: boolean;
  debug: boolean;
  created_at: string;
  updated_at: string;
}

export class Database {
  protected knex: Knex;
  protected config: DatabaseConfig;

  /**
   * Get the knex instance for direct database operations
   */
  getKnex(): Knex {
    return this.knex;
  }

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
    // Initialize agents table
    const hasAgentsTable = await this.knex.schema.hasTable('agents');
    
    if (!hasAgentsTable) {
      await this.knex.schema.createTable('agents', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable().unique();
        table.text('description');
        table.string('model');
        table.float('temperature');
        table.integer('maxTokens');
        table.text('systemPrompt');
        // Use boolean type - Knex handles SQLite conversion automatically
        table.boolean('memory').defaultTo(false);
        table.boolean('knowledge').defaultTo(false);
        table.boolean('vision').defaultTo(false);
        table.boolean('useTools').defaultTo(true);
        table.boolean('contextCompression').defaultTo(false);
        table.boolean('debug').defaultTo(false);
        table.timestamps(true, true);
      });
    } else {
      // Check and add missing columns
      const hasVision = await this.knex.schema.hasColumn('agents', 'vision');
      const hasContextCompression = await this.knex.schema.hasColumn('agents', 'contextCompression');
      const hasDebug = await this.knex.schema.hasColumn('agents', 'debug');
      
      if (!hasVision || !hasContextCompression || !hasDebug) {
        await this.knex.schema.alterTable('agents', (table) => {
          if (!hasVision) {
            table.boolean('vision').defaultTo(false);
          }
          if (!hasContextCompression) {
            table.boolean('contextCompression').defaultTo(false);
          }
          if (!hasDebug) {
            table.boolean('debug').defaultTo(false);
          }
        });
      }
    }

    // Initialize shared tasks table
    const hasTasksTable = await this.knex.schema.hasTable('tasks');
    if (!hasTasksTable) {
      await this.knex.schema.createTable('tasks', (table) => {
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

    // Initialize shared memories table
    const hasMemoriesTable = await this.knex.schema.hasTable('memories');
    if (!hasMemoriesTable) {
      await this.knex.schema.createTable('memories', (table) => {
        table.increments('id').primary();
        table.integer('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.text('content').notNullable();
        table.json('metadata');
        table.timestamps(true, true);
        table.index(['agentId']);
        table.index(['created_at']);
      });
    }

    // Initialize shared contexts table
    const hasContextsTable = await this.knex.schema.hasTable('contexts');
    if (!hasContextsTable) {
      await this.knex.schema.createTable('contexts', (table) => {
        table.increments('id').primary();
        table.integer('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.enu('layer', ['immediate', 'summarized', 'persistent']).notNullable();
        table.text('content').notNullable();
        table.integer('tokenCount').notNullable();
        table.integer('priority').defaultTo(0);
        table.json('metadata');
        table.timestamps(true, true);
        table.index(['agentId', 'layer']);
        table.index(['priority']);
        table.index(['created_at']);
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
        memory: data.memory || false,
        knowledge: data.knowledge || false,
        vision: data.vision || false,
        useTools: data.useTools !== undefined ? data.useTools : true,
        contextCompression: data.contextCompression || false,
        debug: data.debug || false
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
    const updateData: Partial<AgentDbRow> = {};
    const allowedFields = ['name', 'description', 'model', 'temperature', 'maxTokens', 'systemPrompt', 'memory', 'knowledge', 'vision', 'useTools', 'contextCompression', 'debug'] as const;
    
    for (const field of allowedFields) {
      if (field in data) {
        // Type-safe field assignment
        switch (field) {
          case 'name':
            updateData.name = data.name;
            break;
          case 'description':
            updateData.description = data.description;
            break;
          case 'model':
            updateData.model = data.model;
            break;
          case 'temperature':
            updateData.temperature = data.temperature;
            break;
          case 'maxTokens':
            updateData.maxTokens = data.maxTokens;
            break;
          case 'systemPrompt':
            updateData.systemPrompt = data.systemPrompt;
            break;
          case 'memory':
            updateData.memory = data.memory ?? false;
            break;
          case 'knowledge':
            updateData.knowledge = data.knowledge ?? false;
            break;
          case 'vision':
            updateData.vision = data.vision ?? false;
            break;
          case 'useTools':
            updateData.useTools = data.useTools ?? false;
            break;
          case 'contextCompression':
            updateData.contextCompression = data.contextCompression ?? false;
            break;
          case 'debug':
            updateData.debug = data.debug ?? false;
            break;
        }
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

  private formatAgent(agent: AgentDbRow): AgentConfig {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      systemPrompt: agent.systemPrompt,
      memory: Boolean(agent.memory), // Convert SQLite 0/1 to boolean
      knowledge: Boolean(agent.knowledge), // Convert SQLite 0/1 to boolean
      vision: Boolean(agent.vision), // Convert SQLite 0/1 to boolean
      useTools: Boolean(agent.useTools), // Convert SQLite 0/1 to boolean
      contextCompression: Boolean(agent.contextCompression), // Convert SQLite 0/1 to boolean
      debug: Boolean(agent.debug), // Convert SQLite 0/1 to boolean
      createdAt: new Date(agent.created_at),
      updatedAt: new Date(agent.updated_at)
    };
  }
}

let database: Database | null = null;
let isInitializing: Promise<Database> | null = null;

export async function initializeDatabase(config: DatabaseConfig): Promise<Database> {
  if (database) {
    await database.disconnect();
  }
  
  database = new Database(config);
  await database.connect();
  await database.initialize();
  
  return database;
}

async function ensureDatabaseInitialized(): Promise<Database> {
  if (database) {
    return database;
  }

  // Check if initialization is already in progress
  if (isInitializing) {
    return isInitializing;
  }

  // Try to initialize from environment variable
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    throw new Error('DB_URL environment variable is not set. Please set it before using the database.');
  }

  // Start initialization
  isInitializing = initializeDatabase({ connectionString: dbUrl });
  
  try {
    database = await isInitializing;
    return database;
  } finally {
    isInitializing = null;
  }
}

export async function getDatabase(): Promise<Database> {
  return ensureDatabaseInitialized();
}

export * from './types';
export default getDatabase;