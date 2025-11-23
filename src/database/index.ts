import knex, { Knex } from 'knex';
import { DatabaseConfig } from './types';
import { AgentConfig, AgentConfigInput } from '../agent/types';
import { DEFAULT_DATABASE_CONFIG } from './defaults';
import { createKnexConfig } from './knex';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { getEncryptionService } from './encryption';
import { encryptSensitiveFields, decryptSensitiveFields } from './utils';
import { validateEncryptionConsistency } from './sensitive-fields';

interface AgentDbRow {
  id: string; // UUID
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
  autoContextCompression: boolean;
  // Context compression options
  maxContextLength?: number;
  preserveLastN?: number;
  compressionRatio?: number;
  compressionStrategy?: string;
  debug: boolean;
  created_at: string;
  updated_at: string;
}

export class Database {
  protected knex: Knex;
  protected config: DatabaseConfig;
  private logger: Logger;
  private _encryption?: ReturnType<typeof getEncryptionService>;

  private get encryption() {
    if (!this._encryption) {
      this._encryption = getEncryptionService();
    }
    return this._encryption;
  }

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
      type: config.connectionString ? 'postgresql' : 'sqlite',
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
        hasStack: error instanceof Error && !!error.stack,
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
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async initialize(): Promise<void> {
    // User-facing info log
    this.logger.info('Initializing database schema');

    this.logger.debug('Starting database schema initialization');

    // Validate encryption configuration
    const encryptionValidation = validateEncryptionConsistency();
    if (!encryptionValidation.isValid) {
      this.logger.error('Encryption configuration validation failed');
      this.logger.debug('Encryption validation errors', {
        errors: encryptionValidation.errors,
      });
      throw new Error(`Encryption validation failed: ${encryptionValidation.errors.join(', ')}`);
    }

    if (encryptionValidation.warnings.length > 0) {
      this.logger.warn('Encryption configuration warnings');
      this.logger.debug('Encryption validation warnings', {
        warnings: encryptionValidation.warnings,
      });
    }

    // Initialize agents table
    const hasAgentsTable = await this.knex.schema.hasTable('agents');

    this.logger.debug('Checking agents table', { exists: hasAgentsTable });

    if (!hasAgentsTable) {
      this.logger.info('Creating agents table');

      this.logger.debug('Creating agents table with full schema');

      // Enable UUID extension for PostgreSQL
      if (this.config.driver === 'pg' || this.config.driver === 'postgres') {
        await this.knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      }

      await this.knex.schema.createTable('agents', (table) => {
        table.uuid('id').primary().defaultTo(this.knex.raw('gen_random_uuid()'));
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
        table.boolean('autoContextCompression').defaultTo(false);
        // Context compression options
        table.integer('maxContextLength');
        table.integer('preserveLastN');
        table.float('compressionRatio');
        table.string('compressionStrategy');
        table.boolean('debug').defaultTo(false);
        table.timestamps(true, true);
      });

      this.logger.info('Agents table created');
      this.logger.debug('Agents table created successfully');
    } else {
      // Check and add missing columns
      const hasVision = await this.knex.schema.hasColumn('agents', 'vision');
      const hasAutoContextCompression = await this.knex.schema.hasColumn(
        'agents',
        'autoContextCompression'
      );
      const hasDebug = await this.knex.schema.hasColumn('agents', 'debug');
      const hasEmbeddingModel = await this.knex.schema.hasColumn('agents', 'embeddingModel');
      const hasVisionModel = await this.knex.schema.hasColumn('agents', 'visionModel');
      // Check for new context compression columns
      const hasMaxContextLength = await this.knex.schema.hasColumn('agents', 'maxContextLength');
      const hasPreserveLastN = await this.knex.schema.hasColumn('agents', 'preserveLastN');
      const hasCompressionRatio = await this.knex.schema.hasColumn('agents', 'compressionRatio');
      const hasCompressionStrategy = await this.knex.schema.hasColumn(
        'agents',
        'compressionStrategy'
      );

      this.logger.debug('Checking agents table columns', {
        hasVision,
        hasAutoContextCompression,
        hasDebug,
        hasEmbeddingModel,
        hasVisionModel,
        hasMaxContextLength,
        hasPreserveLastN,
        hasCompressionRatio,
        hasCompressionStrategy,
      });

      if (
        !hasVision ||
        !hasAutoContextCompression ||
        !hasDebug ||
        !hasEmbeddingModel ||
        !hasVisionModel ||
        !hasMaxContextLength ||
        !hasPreserveLastN ||
        !hasCompressionRatio ||
        !hasCompressionStrategy
      ) {
        this.logger.info('Updating agents table schema');

        this.logger.debug('Adding missing columns to agents table', {
          needsVision: !hasVision,
          needsAutoContextCompression: !hasAutoContextCompression,
          needsDebug: !hasDebug,
          needsEmbeddingModel: !hasEmbeddingModel,
          needsVisionModel: !hasVisionModel,
        });

        await this.knex.schema.alterTable('agents', (table) => {
          if (!hasVision) {
            table.boolean('vision').defaultTo(false);
          }
          if (!hasAutoContextCompression) {
            table.boolean('autoContextCompression').defaultTo(false);
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
          // Add new context compression columns
          if (!hasMaxContextLength) {
            table.integer('maxContextLength');
          }
          if (!hasPreserveLastN) {
            table.integer('preserveLastN');
          }
          if (!hasCompressionRatio) {
            table.float('compressionRatio');
          }
          if (!hasCompressionStrategy) {
            table.string('compressionStrategy');
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
        table.uuid('id').primary().defaultTo(this.knex.raw('gen_random_uuid()'));
        table.uuid('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.uuid('graphId').nullable();
        table.uuid('graphNodeId').nullable();
        table.text('prompt').notNullable();
        table.text('response').nullable();
        table.enu('status', ['pending', 'in_progress', 'completed', 'failed']).defaultTo('pending');
        table.json('metadata');
        table.json('executionContext');
        table.timestamps(true, true);
        table.timestamp('completedAt').nullable();
        table.index(['agentId']);
        table.index(['graphId']);
        table.index(['graphNodeId']);
        table.index(['status']);
        table.index(['created_at']);
      });

      this.logger.info('Tasks table created');
      this.logger.debug('Tasks table created successfully');
    } else {
      // Check and add graph relationship columns
      const hasGraphId = await this.knex.schema.hasColumn('tasks', 'graphId');
      const hasGraphNodeId = await this.knex.schema.hasColumn('tasks', 'graphNodeId');
      const hasExecutionContext = await this.knex.schema.hasColumn('tasks', 'executionContext');

      this.logger.debug('Checking tasks table columns', {
        hasGraphId,
        hasGraphNodeId,
        hasExecutionContext,
      });

      if (!hasGraphId || !hasGraphNodeId || !hasExecutionContext) {
        this.logger.info('Updating tasks table schema with graph relationships');

        await this.knex.schema.alterTable('tasks', (table) => {
          if (!hasGraphId) {
            table.integer('graphId').nullable();
            this.logger.debug('Adding graphId column to tasks table');
          }
          if (!hasGraphNodeId) {
            table.bigInteger('graphNodeId').nullable();
            this.logger.debug('Adding graphNodeId column (BIGINT) to tasks table');
          }
          if (!hasExecutionContext) {
            table.json('executionContext').nullable();
            this.logger.debug('Adding executionContext column to tasks table');
          }
        });

        // Add indexes for new columns
        if (hasGraphId) {
          await this.knex.schema.alterTable('tasks', (table) => {
            table.index('graphId');
          });
        }
        if (hasGraphNodeId) {
          await this.knex.schema.alterTable('tasks', (table) => {
            table.index('graphNodeId');
          });
        }

        // Add composite indexes
        await this.knex.schema.alterTable('tasks', (table) => {
          table.index(['agentId', 'status']);
        });

        this.logger.info('Tasks table updated with graph relationships');
        this.logger.debug('Tasks table schema updated successfully');
      }
    }

    // Initialize shared memories table
    const hasMemoriesTable = await this.knex.schema.hasTable('memories');
    this.logger.debug('Checking memories table', { exists: hasMemoriesTable });

    if (!hasMemoriesTable) {
      this.logger.info('Creating memories table');

      this.logger.debug('Creating memories table with schema');

      await this.knex.schema.createTable('memories', (table) => {
        table.uuid('id').primary().defaultTo(this.knex.raw('gen_random_uuid()'));
        table.uuid('agentId').notNullable().references('id').inTable('agents').onDelete('CASCADE');
        table.uuid('graphId').nullable();
        table.uuid('taskId').nullable();
        table.string('sessionId', 255).nullable();
        table.text('content').notNullable();
        table.text('embedding').nullable(); // For vector similarity search
        table.json('metadata');
        table.timestamps(true, true);
        table.index(['agentId']);
        table.index(['graphId']);
        table.index(['taskId']);
        table.index(['sessionId']);
        table.index(['created_at']);
      });

      this.logger.info('Memories table created');
      this.logger.debug('Memories table created successfully');
    } else {
      // Check and add missing columns for memories
      const hasEmbedding = await this.knex.schema.hasColumn('memories', 'embedding');
      const hasGraphId = await this.knex.schema.hasColumn('memories', 'graphId');
      const hasTaskId = await this.knex.schema.hasColumn('memories', 'taskId');
      const hasSessionId = await this.knex.schema.hasColumn('memories', 'sessionId');

      this.logger.debug('Checking memories table columns', {
        hasEmbedding,
        hasGraphId,
        hasTaskId,
        hasSessionId,
      });

      if (!hasEmbedding || !hasGraphId || !hasTaskId || !hasSessionId) {
        this.logger.info('Updating memories table schema');

        await this.knex.schema.alterTable('memories', (table) => {
          if (!hasEmbedding) {
            // Add embedding column for vector similarity search
            // Note: For SQLite, we'll store as TEXT (JSON array),
            // for PostgreSQL, this should be vector type
            table.text('embedding').nullable();
            this.logger.debug('Adding embedding column to memories table');
          }
          if (!hasGraphId) {
            table.integer('graphId').nullable();
            this.logger.debug('Adding graphId column to memories table');
          }
          if (!hasTaskId) {
            table.integer('taskId').nullable();
            this.logger.debug('Adding taskId column to memories table');
          }
          if (!hasSessionId) {
            table.string('sessionId', 255).nullable();
            this.logger.debug('Adding sessionId column to memories table');
          }
        });

        // Add indexes for new columns
        if (hasGraphId) {
          await this.knex.schema.alterTable('memories', (table) => {
            table.index('graphId');
          });
        }
        if (hasTaskId) {
          await this.knex.schema.alterTable('memories', (table) => {
            table.index('taskId');
          });
        }
        if (hasSessionId) {
          await this.knex.schema.alterTable('memories', (table) => {
            table.index('sessionId');
          });
        }

        // Add composite index for agent + session queries
        await this.knex.schema.alterTable('memories', (table) => {
          table.index(['agentId', 'sessionId']);
        });

        this.logger.info('Memories table updated with embedding and relationship columns');
        this.logger.debug('Memories table schema updated successfully');
      }
    }

    // Initialize contexts table
    const hasContextsTable = await this.knex.schema.hasTable('contexts');

    this.logger.debug('Checking contexts table', { exists: hasContextsTable });

    if (!hasContextsTable) {
      this.logger.info('Creating contexts table');

      this.logger.debug('Creating contexts table with full schema');

      await this.knex.schema.createTable('contexts', (table) => {
        table.uuid('id').primary().defaultTo(this.knex.raw('gen_random_uuid()'));
        table.uuid('agentId').notNullable();
        table.uuid('graphId').nullable();
        table.string('sessionId', 255).nullable();
        table.json('contextData').nullable(); // Compressed context messages
        table.text('summary').nullable(); // Context summary for very large contexts
        table.integer('tokensUsed').defaultTo(0);
        table.string('compressionVersion').nullable(); // Track compression strategy version
        table.timestamp('lastCompressed').nullable();
        table.timestamps(true, true); // created_at, updated_at

        // Add foreign key constraint to agents table
        table.foreign('agentId').references('id').inTable('agents').onDelete('CASCADE');

        // Add indexes
        table.index('agentId');
        table.index('graphId');
        table.index('sessionId');
      });

      this.logger.info('Contexts table created');
      this.logger.debug('Contexts table created successfully');
    } else {
      // Check and add graph relationship columns
      const hasGraphId = await this.knex.schema.hasColumn('contexts', 'graphId');
      const hasSessionId = await this.knex.schema.hasColumn('contexts', 'sessionId');

      this.logger.debug('Checking contexts table columns', {
        hasGraphId,
        hasSessionId,
      });

      if (!hasGraphId || !hasSessionId) {
        this.logger.info('Updating contexts table schema with graph relationships');

        await this.knex.schema.alterTable('contexts', (table) => {
          if (!hasGraphId) {
            table.integer('graphId').nullable();
            this.logger.debug('Adding graphId column to contexts table');
          }
          if (!hasSessionId) {
            table.string('sessionId', 255).nullable();
            this.logger.debug('Adding sessionId column to contexts table');
          }
        });

        // Add indexes for new columns
        if (hasGraphId) {
          await this.knex.schema.alterTable('contexts', (table) => {
            table.index('graphId');
          });
        }
        if (hasSessionId) {
          await this.knex.schema.alterTable('contexts', (table) => {
            table.index('sessionId');
          });
        }

        // Add composite index for agent + session queries
        await this.knex.schema.alterTable('contexts', (table) => {
          table.index(['agentId', 'sessionId']);
        });

        this.logger.info('Contexts table updated with graph relationships');
        this.logger.debug('Contexts table schema updated successfully');
      }
    }

    // User-facing completion message
    this.logger.info('Database schema initialized');

    this.logger.debug('Database schema initialization completed', {
      tablesChecked: ['agents', 'tasks', 'memories', 'contexts'],
    });
  }

  async createAgent(data: AgentConfigInput): Promise<AgentConfig> {
    // User-facing info log
    this.logger.info(`Creating agent: ${data.name}`);

    this.logger.debug('Creating agent with data', {
      name: data.name,
      description: data.description || 'none',
      model: data.model || 'default',
      embeddingModel: data.embeddingModel || 'none',
      visionModel: data.visionModel || 'none',
      temperature: data.temperature || DEFAULT_DATABASE_CONFIG.defaultTemperature,
      maxTokens: data.maxTokens || DEFAULT_DATABASE_CONFIG.defaultMaxTokens,
      memory: !!data.memory,
      knowledge: !!data.knowledge,
      vision: !!data.vision,
      useTools: data.useTools !== false,
      autoContextCompression: !!data.autoContextCompression,
      debug: !!data.debug,
      hasSystemPrompt: !!data.systemPrompt,
    });

    // Prepare data for insertion with encryption
    const insertData = {
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
      autoContextCompression: data.autoContextCompression || false,
      // Context compression options
      maxContextLength: data.maxContextLength,
      preserveLastN: data.preserveLastN,
      compressionRatio: data.compressionRatio,
      compressionStrategy: data.compressionStrategy,
      debug: data.debug || false,
    };

    // Remove undefined values before encryption
    const cleanedData = Object.fromEntries(
      Object.entries(insertData).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean | null>;

    // Encrypt sensitive fields
    const encryptedData = await encryptSensitiveFields(cleanedData, 'agents');

    const [agent] = await this.knex('agents').insert(encryptedData).returning('*');

    // Decrypt for response
    const decryptedAgent = await decryptSensitiveFields(
      agent as Record<string, string | number | boolean | null>,
      'agents'
    );
    const formattedAgent = this.formatAgent(decryptedAgent as unknown as AgentDbRow);

    // User-facing success message
    this.logger.info(`Agent created with ID: ${formattedAgent.id}`);

    this.logger.debug('Agent created successfully', {
      id: formattedAgent.id || 0,
      name: formattedAgent.name,
    });

    return formattedAgent;
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    this.logger.debug('Retrieving agent by ID', { id });

    const agent = await this.knex('agents').where({ id }).first();

    this.logger.debug('Agent retrieval by ID result', {
      id,
      found: !!agent,
      name: agent?.name,
    });

    if (!agent) return null;

    // Decrypt sensitive fields
    const decryptedAgent = await decryptSensitiveFields(
      agent as Record<string, string | number | boolean | null>,
      'agents'
    );
    return this.formatAgent(decryptedAgent as unknown as AgentDbRow);
  }

  async getAgentByName(name: string): Promise<AgentConfig | null> {
    this.logger.debug('Retrieving agent by name', { name });

    const agent = await this.knex('agents').where({ name }).first();

    this.logger.debug('Agent retrieval by name result', {
      name,
      found: !!agent,
      id: agent?.id,
    });

    if (!agent) return null;

    // Decrypt sensitive fields
    const decryptedAgent = await decryptSensitiveFields(
      agent as Record<string, string | number | boolean | null>,
      'agents'
    );
    return this.formatAgent(decryptedAgent as unknown as AgentDbRow);
  }

  async listAgents(): Promise<AgentConfig[]> {
    this.logger.debug('Listing all agents');

    const agents = await this.knex('agents').orderBy('id', 'desc');

    this.logger.debug('Agents list retrieved', {
      count: agents.length,
      names: agents.map((a) => a.name).slice(0, 10), // First 10 names
    });

    // Decrypt sensitive fields for each agent
    const decryptedAgents = await Promise.all(
      agents.map(async (agent) => {
        const decrypted = await decryptSensitiveFields(
          agent as Record<string, string | number | boolean | null>,
          'agents'
        );
        return this.formatAgent(decrypted as unknown as AgentDbRow);
      })
    );

    return decryptedAgents;
  }

  async updateAgent(id: string, data: Partial<AgentConfig>): Promise<AgentConfig | null> {
    // User-facing info log
    this.logger.info(`Updating agent: ${id}`);

    this.logger.debug('Updating agent with data', {
      id,
      updateFields: Object.keys(data),
      fieldCount: Object.keys(data).length,
      hasSystemPrompt: !!data.systemPrompt,
    });

    const updateData: Partial<AgentDbRow> = {};
    const allowedFields = [
      'name',
      'description',
      'model',
      'embeddingModel',
      'visionModel',
      'temperature',
      'maxTokens',
      'systemPrompt',
      'memory',
      'knowledge',
      'vision',
      'useTools',
      'autoContextCompression',
      // Context compression options
      'maxContextLength',
      'preserveLastN',
      'compressionRatio',
      'compressionStrategy',
      'debug',
    ] as const;

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
          case 'autoContextCompression':
            updateData.autoContextCompression = data.autoContextCompression ?? false;
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

    // Encrypt sensitive fields in update data
    const encryptedUpdateData = await encryptSensitiveFields(updateData, 'agents');

    const [agent] = await this.knex('agents')
      .where({ id })
      .update(encryptedUpdateData)
      .returning('*');

    if (agent) {
      // Decrypt for response
      const decryptedAgent = await decryptSensitiveFields(
        agent as Record<string, string | number | boolean | null>,
        'agents'
      );
      const formattedAgent = this.formatAgent(decryptedAgent as unknown as AgentDbRow);

      // User-facing success message
      this.logger.info(`Agent ${id} updated successfully`);

      this.logger.debug('Agent updated successfully', {
        id: formattedAgent.id || 0,
        name: formattedAgent.name,
        updatedFieldCount: Object.keys(updateData).length,
      });

      return formattedAgent;
    }

    this.logger.debug('Agent update failed - agent not found', { id });
    return null;
  }

  async deleteAgent(id: string): Promise<boolean> {
    // User-facing info log
    this.logger.info(`Deleting agent: ${id}`);

    this.logger.debug('Deleting agent', { id });

    const deleted = await this.knex('agents').where({ id }).delete();

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
      autoContextCompression: Boolean(agent.autoContextCompression), // Convert SQLite 0/1 to boolean
      // Context compression options
      maxContextLength: agent.maxContextLength,
      preserveLastN: agent.preserveLastN,
      compressionRatio: agent.compressionRatio,
      compressionStrategy: agent.compressionStrategy as
        | 'summarize'
        | 'selective'
        | 'hybrid'
        | undefined,
      debug: Boolean(agent.debug), // Convert SQLite 0/1 to boolean
      createdAt: new Date(agent.created_at),
      updatedAt: new Date(agent.updated_at),
    };
  }
}

let database: Database | null = null;
let isInitializing: Promise<Database> | null = null;

export async function initializeDatabase(
  config: DatabaseConfig,
  logger?: Logger
): Promise<Database> {
  if (database) {
    await database.disconnect();
  }

  database = new Database(config, logger);
  await database.connect();
  await database.initialize();

  return database;
}

async function ensureDatabaseInitialized(): Promise<Database> {
  // Race condition fix: check database again after potential initialization
  if (database) {
    return database;
  }

  // Check if initialization is already in progress
  if (isInitializing) {
    return isInitializing;
  }

  // Double-check pattern to prevent race conditions
  if (database) {
    return database;
  }

  // Try to initialize from environment variable or use default SQLite
  const dbUrl = process.env.DB_URL || 'sqlite://./astreus.db';

  // Start initialization with error handling
  isInitializing = initializeDatabase({ connectionString: dbUrl });

  try {
    database = await isInitializing;
    // Clear initialization promise after successful completion
    isInitializing = null;
    return database;
  } catch (error) {
    // Reset state on failure to allow retry
    isInitializing = null;
    database = null;
    throw error;
  }
}

export async function getDatabase(): Promise<Database> {
  return ensureDatabaseInitialized();
}

export * from './types';
export * from './sensitive-fields';
export default getDatabase;
