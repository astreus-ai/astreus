import { PersonalityConfig, PersonalityInstance, PersonalityManagerInstance } from "./types";
import { Personality } from "./personality";
import { DatabaseInstance } from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { DEFAULT_PERSONALITIES } from "./config";

export class PersonalityManager implements PersonalityManagerInstance {
  private database: DatabaseInstance;
  private personalities: Map<string, PersonalityInstance> = new Map();

  constructor(database: DatabaseInstance) {
    validateRequiredParam(database, "database", "PersonalityManager constructor");
    
    this.database = database;
    logger.info("System", "PersonalityManager", "Initialized personality manager");
    
    // Initialize default personalities
    this.initializeDefaults();
  }

  private async initializeDefaults(): Promise<void> {
    try {
      // Create table if it doesn't exist
      await this.createTableIfNotExists();
      
      // Check if we already have personalities
      const existingPersonalities = await this.list();
      if (existingPersonalities.length === 0) {
        logger.info("System", "PersonalityManager", "Creating default personalities");
        
        for (const defaultConfig of DEFAULT_PERSONALITIES) {
          try {
            await this.create(defaultConfig);
            logger.debug("System", "PersonalityManager", `Created default personality: ${defaultConfig.name}`);
          } catch (error) {
            logger.warn("System", "PersonalityManager", `Failed to create default personality ${defaultConfig.name}: ${error}`);
          }
        }
        
        logger.success("System", "PersonalityManager", `Created ${DEFAULT_PERSONALITIES.length} default personalities`);
      }
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to initialize defaults: ${error}`);
    }
  }

  private async createTableIfNotExists(): Promise<void> {
    try {
      await this.database.ensureTable('personalities', (table) => {
        table.string('id').primary();
        table.string('name').notNullable();
        table.text('description').nullable();
        table.text('prompt').notNullable();
        table.text('metadata').nullable();
        table.timestamps(true, true);
      });
      logger.debug("System", "PersonalityManager", "Ensured personalities table exists");
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to create personalities table: ${error}`);
      throw error;
    }
  }

  async create(config: Omit<PersonalityConfig, 'id'>): Promise<PersonalityInstance> {
    validateRequiredParam(config, "config", "create");
    validateRequiredParams(
      config,
      ["name", "prompt"],
      "create"
    );

    const personality = new Personality(config);
    
    try {
      // Save to database
      const personalitiesTable = this.database.getTable('personalities');
      await personalitiesTable.insert({
        id: personality.id,
        name: personality.config.name,
        description: personality.config.description || null,
        prompt: personality.config.prompt,
        metadata: JSON.stringify(personality.config.metadata || {}),
        created_at: personality.config.createdAt?.toISOString(),
        updated_at: personality.config.updatedAt?.toISOString()
      });

      // Cache in memory
      this.personalities.set(personality.id, personality);
      
      logger.success("System", "PersonalityManager", `Created personality: ${personality.config.name} (${personality.id})`);
      return personality;
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to create personality: ${error}`);
      throw error;
    }
  }

  async get(id: string): Promise<PersonalityInstance | null> {
    validateRequiredParam(id, "id", "get");

    // Check cache first
    if (this.personalities.has(id)) {
      return this.personalities.get(id)!;
    }

    try {
      const personalitiesTable = this.database.getTable('personalities');
      const result = await personalitiesTable.findOne({ id });
      
      if (!result) {
        return null;
      }

      const personality = new Personality({
        id: result.id,
        name: result.name,
        description: result.description,
        prompt: result.prompt,
        metadata: result.metadata ? JSON.parse(result.metadata) : {},
        createdAt: result.created_at ? new Date(result.created_at) : undefined,
        updatedAt: result.updated_at ? new Date(result.updated_at) : undefined
      });

      // Cache the personality
      this.personalities.set(personality.id, personality);
      
      return personality;
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to get personality ${id}: ${error}`);
      throw error;
    }
  }

  async list(limit?: number): Promise<PersonalityInstance[]> {
    try {
      const personalitiesTable = this.database.getTable('personalities');
      // Use knex directly for ordering and limiting
      let query = this.database.knex('personalities').orderBy('created_at', 'desc');
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const results = await query;
      
      const personalities: PersonalityInstance[] = [];
      
      for (const result of results) {
        const personality = new Personality({
          id: result.id,
          name: result.name,
          description: result.description,
          prompt: result.prompt,
          metadata: result.metadata ? JSON.parse(result.metadata) : {},
          createdAt: result.created_at ? new Date(result.created_at) : undefined,
          updatedAt: result.updated_at ? new Date(result.updated_at) : undefined
        });
        
        // Cache the personality
        this.personalities.set(personality.id, personality);
        personalities.push(personality);
      }
      
      return personalities;
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to list personalities: ${error}`);
      throw error;
    }
  }

  async update(id: string, updates: Partial<PersonalityConfig>): Promise<void> {
    validateRequiredParam(id, "id", "update");
    validateRequiredParam(updates, "updates", "update");

    try {
      // Get existing personality
      const personality = await this.get(id);
      if (!personality) {
        throw new Error(`Personality with id ${id} not found`);
      }

      // Update the personality instance
      await personality.update(updates);

      // Update in database
      const personalitiesTable = this.database.getTable('personalities');
      await personalitiesTable.update(
        { id },
        {
          name: personality.config.name,
          description: personality.config.description || null,
          prompt: personality.config.prompt,
          metadata: JSON.stringify(personality.config.metadata || {}),
          updated_at: personality.config.updatedAt?.toISOString()
        }
      );

      logger.success("System", "PersonalityManager", `Updated personality: ${personality.config.name} (${id})`);
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to update personality ${id}: ${error}`);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    validateRequiredParam(id, "id", "delete");

    try {
      const personalitiesTable = this.database.getTable('personalities');
      await personalitiesTable.delete({ id });
      
      // Remove from cache
      this.personalities.delete(id);
      
      logger.success("System", "PersonalityManager", `Deleted personality: ${id}`);
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to delete personality ${id}: ${error}`);
      throw error;
    }
  }

  async search(query: string): Promise<PersonalityInstance[]> {
    validateRequiredParam(query, "query", "search");

    try {
      const searchTerm = `%${query}%`;
      const results = await this.database.knex('personalities')
        .where('name', 'like', searchTerm)
        .orWhere('description', 'like', searchTerm)
        .orderBy('created_at', 'desc');
      
      const personalities: PersonalityInstance[] = [];
      
      for (const result of results) {
        const personality = new Personality({
          id: result.id,
          name: result.name,
          description: result.description,
          prompt: result.prompt,
          metadata: result.metadata ? JSON.parse(result.metadata) : {},
          createdAt: result.created_at ? new Date(result.created_at) : undefined,
          updatedAt: result.updated_at ? new Date(result.updated_at) : undefined
        });
        
        personalities.push(personality);
      }
      
      return personalities;
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to search personalities: ${error}`);
      throw error;
    }
  }

  // Utility method to get a personality by name
  async getByName(name: string): Promise<PersonalityInstance | null> {
    validateRequiredParam(name, "name", "getByName");

    try {
      const personalitiesTable = this.database.getTable('personalities');
      const result = await personalitiesTable.findOne({ name });
      
      if (!result) {
        return null;
      }

      const personality = new Personality({
        id: result.id,
        name: result.name,
        description: result.description,
        prompt: result.prompt,
        metadata: result.metadata ? JSON.parse(result.metadata) : {},
        createdAt: result.created_at ? new Date(result.created_at) : undefined,
        updatedAt: result.updated_at ? new Date(result.updated_at) : undefined
      });

      // Cache the personality
      this.personalities.set(personality.id, personality);
      
      return personality;
    } catch (error) {
      logger.error("System", "PersonalityManager", `Failed to get personality by name ${name}: ${error}`);
      throw error;
    }
  }
}