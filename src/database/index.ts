import knex, { Knex } from 'knex';
import { DatabaseConfig } from './types';
import { AgentConfig } from '../agent/types';
import { createKnexConfig } from './knex';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';

interface AgentDbRow {
  id: number;
  name: string;
  description?: string;
  model?: string;
  embeddingModel?: string;
  visionModel?: string;
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
  private logger: Logger;

  /**
   * Get the knex instance for direct database operations
   */
  getKnex(): Knex {
    return this.knex;
  }

  constructor(config: DatabaseConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger || getLogger();
    
    // User-facing info log
    this.logger.info('Initializing database connection');
    
    this.logger.debug('Creating database instance', {
      hasConnectionString: !!config.connectionString,
      sqliteFilename: config.filename || 'none',
      type: config.connectionString ? 'postgresql' : 'sqlite'
    });
    
    const knexConfig = createKnexConfig(config);
    this.knex = knex(knexConfig);
  }

  async connect(): Promise<void> {
    // User-facing info log
    this.logger.info('Connecting to database');
    
    this.logger.debug('Testing database connection');
    
    try {
      // Test connection
      await this.knex.raw('SELECT 1');
      
      // User-facing success message
      this.logger.info('Database connected successfully');
      
      this.logger.debug('Database connection test passed');
    } catch (error) {
      // User-facing error message
      this.logger.error('Failed to connect to database');
      
      this.logger.debug('Database connection failed', {
        error: error instanceof Error ? error.message : String(error),
        hasStack: error instanceof Error && !!error.stack
      });
      
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // User-facing info log
    this.logger.info('Disconnecting from database');
    
    this.logger.debug('Destroying database connection pool');
    
    try {
      await this.knex.destroy();
      
      // User-facing success message
      this.logger.info('Database disconnected');
      
      this.logger.debug('Database connection pool destroyed');
    } catch (error) {
      // User-facing error message
      this.logger.error('Error during database disconnect');
      
      this.logger.debug('Database disconnect failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  async initialize(): Promise<void> {
    // User-facing info log
    this.logger.info('Initializing database schema');
    
    this.logger.debug('Starting database schema initialization');
    
    // Initialize agents table
    const hasAgentsTable = await this.knex.schema.hasTable('agents');
    
    this.logger.debug('Checking agents table', { exists: hasAgentsTable });
    
    if (!hasAgentsTable) {
      this.logger.info('Creating agents table');
      
      this.logger.debug('Creating agents table with full schema');
      
      await this.knex.schema.createTable('agents', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable().unique();
        table.text('description');
        table.string('model');
        table.string('embeddingModel');
        table.string('visionModel');
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
      
      this.logger.info('Agents table created');
      this.logger.debug('Agents table created successfully');
    } else {
      // Check and add missing columns
      const hasVision = await this.knex.schema.hasColumn('agents', 'vision');
      const hasContextCompression = await this.knex.schema.hasColumn('agents', 'contextCompression');
      const hasDebug = await this.knex.schema.hasColumn('agents', 'debug');
      const hasEmbeddingModel = await this.knex.schema.hasColumn('agents', 'embeddingModel');
      const hasVisionModel = await this.knex.schema.hasColumn('agents', 'visionModel');
      
      this.logger.debug('Checking agents table columns', {
        hasVision,
        hasContextCompression,
        hasDebug,
        hasEmbeddingModel,
        hasVisionModel
      });
      
      if (!hasVision || !hasContextCompression || !hasDebug || !hasEmbeddingModel || !hasVisionModel) {
        this.logger.info('Updating agents table schema');
        
        this.logger.debug('Adding missing columns to agents table', {
          needsVision: !hasVision,
          needsContextCompression: !hasContextCompression,
          needsDebug: !hasDebug,
          needsEmbeddingModel: !hasEmbeddingModel,
          needsVisionModel: !hasVisionModel
        });
        
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
          if (!hasEmbeddingModel) {
            table.string('embeddingModel');
          }
          if (!hasVisionModel) {
            table.string('visionModel');
          }
        });
        
        this.logger.info('Agents table updated');
        this.logger.debug('Agents table schema updated successfully');
      }
    }

    // Initialize shared tasks table
    const hasTasksTable = await this.knex.schema.hasTable('tasks');
    this.logger.debug('Checking tasks table', { exists: hasTasksTable });
    
    if (!hasTasksTable) {
      this.logger.info('Creating tasks table');
      
      this.logger.debug('Creating tasks table with schema');
      
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
      
      this.logger.info('Tasks table created');
      this.logger.debug('Tasks table created successfully');
    }

    // Initialize shared memories table
    const hasMemoriesTable = await this.knex.schema.hasTable('memories');
    this.logger.debug('Checking memories table', { exists: hasMemoriesTable });
    
    if (!hasMemoriesTable) {
      this.logger.info('Creating memories table');
      
      this.logger.debug('Creating memories table with schema');
      
      await this.knex.schema.createTable('memories', (table) => {
        table.increments('id').primary();
        table.integer('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.text('content').notNullable();
        table.json('metadata');
        table.timestamps(true, true);
        table.index(['agentId']);
        table.index(['created_at']);
      });
      
      this.logger.info('Memories table created');
      this.logger.debug('Memories table created successfully');
    }

    
    // User-facing completion message
    this.logger.info('Database schema initialized');
    
    this.logger.debug('Database schema initialization completed', {
      tablesChecked: ['agents', 'tasks', 'memories']
    });
  }

  async createAgent(data: AgentConfig): Promise<AgentConfig> {
    // User-facing info log
    this.logger.info(`Creating agent: ${data.name}`);
    
    this.logger.debug('Creating agent with data', {
      name: data.name,
      description: data.description || 'none',
      model: data.model || 'default',
      embeddingModel: data.embeddingModel || 'none',
      visionModel: data.visionModel || 'none',
      temperature: data.temperature || 0.7,
      maxTokens: data.maxTokens || 2000,
      memory: !!data.memory,
      knowledge: !!data.knowledge,
      vision: !!data.vision,
      useTools: data.useTools !== false,
      contextCompression: !!data.contextCompression,
      debug: !!data.debug,
      hasSystemPrompt: !!data.systemPrompt
    });
    
    const [agent] = await this.knex('agents')
      .insert({
        name: data.name,
        description: data.description,
        model: data.model,
        embeddingModel: data.embeddingModel,
        visionModel: data.visionModel,
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
    
    const formattedAgent = this.formatAgent(agent);
    
    // User-facing success message
    this.logger.info(`Agent created with ID: ${formattedAgent.id}`);
    
    this.logger.debug('Agent created successfully', {
      id: formattedAgent.id || 0,
      name: formattedAgent.name
    });
    
    return formattedAgent;
  }

  async getAgent(id: number): Promise<AgentConfig | null> {
    this.logger.debug('Retrieving agent by ID', { id });
    
    const agent = await this.knex('agents')
      .where({ id })
      .first();
    
    this.logger.debug('Agent retrieval by ID result', { 
      id, 
      found: !!agent,
      name: agent?.name 
    });
    
    return agent ? this.formatAgent(agent) : null;
  }

  async getAgentByName(name: string): Promise<AgentConfig | null> {
    this.logger.debug('Retrieving agent by name', { name });
    
    const agent = await this.knex('agents')
      .where({ name })
      .first();
    
    this.logger.debug('Agent retrieval by name result', { 
      name, 
      found: !!agent,
      id: agent?.id 
    });
    
    return agent ? this.formatAgent(agent) : null;
  }

  async listAgents(): Promise<AgentConfig[]> {
    this.logger.debug('Listing all agents');
    
    const agents = await this.knex('agents')
      .orderBy('id', 'desc');
    
    this.logger.debug('Agents list retrieved', { 
      count: agents.length,
      names: agents.map(a => a.name).slice(0, 10) // First 10 names
    });
    
    return agents.map(agent => this.formatAgent(agent));
  }

  async updateAgent(id: number, data: Partial<AgentConfig>): Promise<AgentConfig | null> {
    // User-facing info log  
    this.logger.info(`Updating agent: ${id}`);
    
    this.logger.debug('Updating agent with data', {
      id,
      updateFields: Object.keys(data),
      fieldCount: Object.keys(data).length,
      hasSystemPrompt: !!data.systemPrompt
    });
    
    const updateData: Partial<AgentDbRow> = {};
    const allowedFields = ['name', 'description', 'model', 'embeddingModel', 'visionModel', 'temperature', 'maxTokens', 'systemPrompt', 'memory', 'knowledge', 'vision', 'useTools', 'contextCompression', 'debug'] as const;
    
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
          case 'embeddingModel':
            updateData.embeddingModel = data.embeddingModel;
            break;
          case 'visionModel':
            updateData.visionModel = data.visionModel;
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
      this.logger.debug('No update data provided, returning current agent', { id });
      return this.getAgent(id);
    }
    
    const [agent] = await this.knex('agents')
      .where({ id })
      .update(updateData)
      .returning('*');
    
    if (agent) {
      const formattedAgent = this.formatAgent(agent);
      
      // User-facing success message
      this.logger.info(`Agent ${id} updated successfully`);
      
      this.logger.debug('Agent updated successfully', {
        id: formattedAgent.id || 0,
        name: formattedAgent.name,
        updatedFieldCount: Object.keys(updateData).length
      });
      
      return formattedAgent;
    }
    
    this.logger.debug('Agent update failed - agent not found', { id });
    return null;
  }

  async deleteAgent(id: number): Promise<boolean> {
    // User-facing info log
    this.logger.info(`Deleting agent: ${id}`);
    
    this.logger.debug('Deleting agent', { id });
    
    const deleted = await this.knex('agents')
      .where({ id })
      .delete();
    
    const success = deleted > 0;
    
    if (success) {
      // User-facing success message
      this.logger.info(`Agent ${id} deleted successfully`);
      
      this.logger.debug('Agent deleted successfully', { id, deletedCount: deleted });
    } else {
      this.logger.debug('Agent deletion failed - agent not found', { id });
    }
    
    return success;
  }

  private formatAgent(agent: AgentDbRow): AgentConfig {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      embeddingModel: agent.embeddingModel,
      visionModel: agent.visionModel,
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

export async function initializeDatabase(config: DatabaseConfig, logger?: Logger): Promise<Database> {
  if (database) {
    await database.disconnect();
  }
  
  database = new Database(config, logger);
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