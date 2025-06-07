import { v4 as uuidv4 } from "uuid";
import {
  MemoryConfig,
  MemoryInstance,
  MemoryEntry,
  MemoryFactory,
  SimilaritySearchResult,
} from "./types";
import { Embedding } from "./providers";
import { logger } from "./utils";
import { validateRequiredParam, validateRequiredParams } from "./utils/validation";
import { DEFAULT_MEMORY_SIZE } from "./constants";

/**
 * Memory manager implementation using database storage
 * Provides storage and retrieval of conversation history and vector embeddings
 */
export class MemoryManager implements MemoryInstance {
  public config: MemoryConfig;

  constructor(config: MemoryConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "MemoryManager constructor");
    validateRequiredParams(
      config,
      ["database"],
      "MemoryManager constructor"
    );
    
    // Apply defaults for optional config parameters
    this.config = {
      ...config,
      tableName: config.tableName || "memories",
      maxEntries: config.maxEntries || DEFAULT_MEMORY_SIZE,
      enableEmbeddings: config.enableEmbeddings || false
    };
    
    logger.debug("Memory manager initialized");
  }

  /**
   * Create a new memory instance with proper configuration
   * @param config Configuration object for memory
   * @returns Promise that resolves to the new memory instance
   */
  static async create(config: MemoryConfig): Promise<MemoryInstance> {
    // Validate required parameters
    validateRequiredParam(config, "config", "MemoryManager.create");
    validateRequiredParams(
      config,
      ["database"],
      "MemoryManager.create"
    );
    
    try {
      // Apply defaults
      const fullConfig = {
        ...config,
        tableName: config.tableName || "memories",
        maxEntries: config.maxEntries || DEFAULT_MEMORY_SIZE,
        enableEmbeddings: config.enableEmbeddings || false
      };
      
      // Ensure the memory table exists with proper schema
      const { database, tableName } = fullConfig;
      const hasTable = await database.knex.schema.hasTable(tableName);
      
      if (!hasTable) {
        // Create the memory table with full schema
        logger.info(`Creating memory table: ${tableName}`);
        await database.knex.schema.createTable(tableName, (table) => {
          table.string("id").primary();
          table.string("agentId").notNullable().index();
          table.string("sessionId").notNullable().index();
          table.string("userId").nullable().index();
          table.string("role").notNullable();
          table.text("content").notNullable();
          table.timestamp("timestamp").defaultTo(database.knex.fn.now());
          table.json("embedding").nullable();
          table.json("metadata");
        });
        logger.info(`Created memory table: ${tableName}`);
      } else {
        // Check if embeddings are enabled and ensure embedding column exists
        if (fullConfig.enableEmbeddings) {
          logger.info("Initializing memory with embedding support");

          const hasEmbeddingColumn = await database.knex.schema.hasColumn(
            tableName,
            "embedding"
          );

          if (!hasEmbeddingColumn) {
            logger.warn("Adding embedding column to memory table");
            await database.knex.schema.table(tableName, (table) => {
              table.json("embedding"); // Store as JSON to properly represent array structure
            });
          }
        }
      }

      return new MemoryManager(fullConfig);
    } catch (error) {
      logger.error("Error creating memory instance:", error);
      throw error;
    }
  }

  /**
   * Add a new memory entry
   * @param entry Memory entry to add (without id and timestamp)
   * @returns Promise resolving to the ID of the new entry
   */
  async add(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string> {
    // Validate required parameters
    validateRequiredParam(entry, "entry", "add");
    validateRequiredParams(
      entry,
      ["agentId", "sessionId", "role", "content"],
      "add"
    );
    
    try {
      const { database, tableName, enableEmbeddings } = this.config;

      // Generate ID and timestamp
      const id = uuidv4();
      const timestamp = new Date();

      // Create a copy to avoid modifying the original
      const entryToInsert = { ...entry };

      // Validate and normalize the role for OpenRouter compatibility
      entryToInsert.role = this.validateRole(entryToInsert.role);

      // Generate embedding if enabled and not provided
      if (enableEmbeddings && !entryToInsert.embedding && entryToInsert.content) {
        try {
          logger.debug(`Generating embedding for memory entry ${id}`);
          const generatedEmbedding = await Embedding.generateEmbedding(entryToInsert.content);
          entryToInsert.embedding = generatedEmbedding;
          logger.debug(`Generated embedding for memory entry ${id} (${generatedEmbedding.length} dimensions)`);
        } catch (embeddingError) {
          logger.warn(`Failed to generate embedding for memory entry ${id}:`, embeddingError);
          // Continue without embedding rather than failing the entire operation
        }
      }

      // Prepare entry for database insertion with proper JSON serialization
      const dbEntry = {
        ...entryToInsert,
        id,
        timestamp,
      };

      // Ensure embedding is properly serialized if it exists
      if (entryToInsert.embedding) {
        // If embedding is already a string but not JSON, handle special cases
        if (typeof entryToInsert.embedding === "string") {
          // Handle case where embedding is "[object Object]" (invalid)
          if (entryToInsert.embedding === "[object Object]") {
            (dbEntry as any).embedding = null;
          } else {
            // Keep it as is since it's already a string
            (dbEntry as any).embedding = entryToInsert.embedding;
          }
        } else if (Array.isArray(entryToInsert.embedding)) {
          // For database storage, convert arrays to JSON string
          (dbEntry as any).embedding = JSON.stringify(entryToInsert.embedding);
        } else {
          // For unexpected object types, store as null to avoid "[object Object]"
          logger.warn(
            `Unexpected embedding type for entry ${id}, setting to null`
          );
          (dbEntry as any).embedding = null;
        }
      }

      // Store in database
      await database.getTable(tableName!).insert(dbEntry);
      logger.debug(`Added memory entry ${id}${entryToInsert.embedding ? ' with embedding' : ''} with role: ${entryToInsert.role}`);

      return id;
    } catch (error) {
      logger.error("Error adding memory entry:", error);
      throw error;
    }
  }

  /**
   * Get entries by session ID
   * @param sessionId The session ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  async getBySession(
    sessionId: string,
    limit?: number
  ): Promise<MemoryEntry[]> {
    // Validate required parameters
    validateRequiredParam(sessionId, "sessionId", "getBySession");
    
    try {
      const { database, tableName, maxEntries } = this.config;

      // Query database - using non-null assertion since we set defaults in constructor
      const entries = await database
        .knex(tableName!)
        .where({ "sessionId": sessionId })
        .orderBy("timestamp", "asc")
        .limit(limit || maxEntries!);

      logger.debug(`Retrieved ${entries.length} entries for session ${sessionId}`);

      // Process embedding data for client use
      return this.processEntriesBeforeReturn(entries);
    } catch (error) {
      logger.error(`Error getting entries for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Get entries by agent ID
   * @param agentId The agent ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  async getByAgent(agentId: string, limit?: number): Promise<MemoryEntry[]> {
    // Validate required parameters
    validateRequiredParam(agentId, "agentId", "getByAgent");
    
    try {
      const { database, tableName, maxEntries } = this.config;

      // Query database - using non-null assertion since we set defaults in constructor
      const entries = await database
        .knex(tableName!)
        .where({ "agentId": agentId })
        .orderBy("timestamp", "asc")
        .limit(limit || maxEntries!);

      logger.debug(`Retrieved ${entries.length} entries for agent ${agentId}`);

      // Process embedding data for client use
      return this.processEntriesBeforeReturn(entries);
    } catch (error) {
      logger.error(`Error getting entries for agent ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Get entries by user ID
   * @param userId The user ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  async getByUser(userId: string, limit?: number): Promise<MemoryEntry[]> {
    // Validate required parameters
    validateRequiredParam(userId, "userId", "getByUser");
    
    try {
      const { database, tableName, maxEntries } = this.config;

      // Query database with userId - using non-null assertion since we set defaults in constructor
      const entries = await database
        .knex(tableName!)
        .where({ "userId": userId })
        .orderBy("timestamp", "desc") // Most recent first
        .limit(limit || maxEntries!);

      logger.debug(`Retrieved ${entries.length} entries for user ${userId}`);

      // Process embedding data for client use
      return this.processEntriesBeforeReturn(entries);
    } catch (error) {
      logger.error(`Error getting entries for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get a memory entry by its ID
   * @param id The ID of the memory entry to retrieve
   * @returns Promise resolving to the memory entry or null if not found
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    // Validate required parameters
    validateRequiredParam(id, "id", "getById");
    
    try {
      const { database, tableName } = this.config;

      // Query database to find entry by ID
      const entry = await database
        .knex(tableName!)
        .where({ id })
        .first();

      if (!entry) {
        logger.debug(`Memory entry with ID ${id} not found`);
        return null;
      }

      logger.debug(`Retrieved memory entry with ID ${id}`);

      // Process embedding data for client use
      const processedEntries = this.processEntriesBeforeReturn([entry]);
      return processedEntries[0];
    } catch (error) {
      logger.error(`Error getting memory entry by ID ${id}:`, error);
      throw error;
    }
  }

  /**
   * Delete a memory entry by its ID
   * @param id The ID of the memory entry to delete
   * @returns Promise that resolves when deletion is complete
   */
  async delete(id: string): Promise<void> {
    // Validate required parameters
    validateRequiredParam(id, "id", "delete");
    
    try {
      const { database, tableName } = this.config;

      // Delete entry from database
      const result = await database
        .knex(tableName!)
        .where({ id })
        .delete();

      if (result === 0) {
        logger.warn(`No memory entry found for deletion with ID ${id}`);
      } else {
        logger.debug(`Deleted memory entry with ID ${id}`);
      }
    } catch (error) {
      logger.error(`Error deleting memory entry with ID ${id}:`, error);
      throw error;
    }
  }

  /**
   * Helper method to process entries before returning to client
   * Parses JSON embedding strings back to arrays
   * @param entries Array of raw entries from database
   * @returns Processed entries with parsed embeddings
   */
  private processEntriesBeforeReturn(entries: unknown[]): MemoryEntry[] {
    return entries.map((entry) => {
      // We need to cast entry to a record type first since it comes from the database
      const dbEntry = entry as Record<string, unknown>;
      
      // Create a new entry to avoid modifying the original
      const processedEntry: Partial<MemoryEntry> = { 
        id: String(dbEntry.id || ''),
        agentId: String(dbEntry.agentId || ''),
        sessionId: String(dbEntry.sessionId || ''),
        role: this.validateRole(String(dbEntry.role || '')),
        content: String(dbEntry.content || ''),
        timestamp: dbEntry.timestamp instanceof Date ? dbEntry.timestamp : new Date(String(dbEntry.timestamp || '')),
        metadata: dbEntry.metadata as Record<string, unknown>
      };

      // Parse embedding if it exists and is a string
      if (dbEntry.embedding) {
        if (typeof dbEntry.embedding === "string") {
          // Skip "[object Object]" strings which aren't valid JSON
          if (dbEntry.embedding === "[object Object]") {
            processedEntry.embedding = undefined;
          } else {
            try {
              processedEntry.embedding = JSON.parse(dbEntry.embedding);
            } catch (error) {
              logger.error(
                `Error parsing embedding for entry ${String(dbEntry.id)}:`,
                error
              );
              // If parsing fails, remove the embedding
              processedEntry.embedding = undefined;
            }
          }
        } else if (Array.isArray(dbEntry.embedding)) {
          processedEntry.embedding = dbEntry.embedding;
        }
      }

      return processedEntry as MemoryEntry;
    });
  }

  /**
   * Search memories by text content
   * @param query Text to search for in memory content field
   * @param limit Maximum number of results to return
   * @returns Array of memory entries matching the query
   */
  async searchByText(
    query: string,
    limit: number = 10
  ): Promise<MemoryEntry[]> {
    // Validate required parameters
    validateRequiredParam(query, "query", "searchByText");
    
    try {
      const { database, tableName } = this.config;

      if (!query) return [];

      // Use case-insensitive search with LIKE
      const results = await database
        .knex(tableName!)
        .whereRaw("LOWER(content) LIKE ?", [`%${query.toLowerCase()}%`])
        .orderBy("timestamp", "desc")
        .limit(limit);

      logger.debug(`Text search for "${query}" found ${results.length} results`);
      
      return this.processEntriesBeforeReturn(results);
    } catch (error) {
      logger.error("Error searching memories by text:", error);
      return [];
    }
  }

  /**
   * Search memories by embedding similarity
   * @param embedding The embedding vector to search for
   * @param limit Maximum number of results to return
   * @param threshold Minimum similarity score (0-1) to include in results
   * @returns Array of memory entries with similarity scores
   */
  async searchByEmbedding(
    embedding: number[],
    limit: number = 5,
    threshold: number = 0 // Default to returning all results
  ): Promise<SimilaritySearchResult[]> {
    // Validate required parameters
    validateRequiredParam(embedding, "embedding", "searchByEmbedding");
    
    try {
      const { database, tableName } = this.config;

      if (!embedding || !embedding.length) {
        return [];
      }

      // Get all memories with embeddings
      const memories = await database
        .knex(tableName!)
        .whereNotNull("embedding")
        .orderBy("timestamp", "desc")
        .limit(100); // Reasonable upper limit for comparison

      // Process embeddings
      type EntryWithEmbedding = MemoryEntry & { embedding: number[] };
      const entriesWithEmbeddings = memories
        .map((entry) => {
          let parsedEmbedding: number[] | undefined;

          if (entry.embedding) {
            try {
              if (typeof entry.embedding === "string") {
                parsedEmbedding = JSON.parse(entry.embedding);
              } else if (Array.isArray(entry.embedding)) {
                parsedEmbedding = entry.embedding;
              }
            } catch (error) {
              logger.error(
                `Error parsing embedding for entry ${entry.id}:`,
                error
              );
            }
          }

          if (parsedEmbedding && Array.isArray(parsedEmbedding)) {
            const entryAsMemoryEntry = entry as unknown as MemoryEntry;
            return {
              ...entryAsMemoryEntry,
              embedding: parsedEmbedding,
            } as EntryWithEmbedding;
          }
          return null;
        })
        .filter(Boolean) as EntryWithEmbedding[];

      // Calculate similarity scores
      const entriesWithScores = entriesWithEmbeddings.map((entry) => {
        const similarity = Embedding.calculateSimilarity(
          embedding,
          entry.embedding
        );
        const result: SimilaritySearchResult = {
          ...this.processEntriesBeforeReturn([entry])[0],
          similarity,
        };
        return result;
      });

      // Filter by threshold and take top results
      const filteredResults = entriesWithScores
        .filter((item) => item.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
      
      logger.debug(`Found ${filteredResults.length} results in embedding search with threshold ${threshold}`);
      
      return filteredResults;
    } catch (error) {
      logger.error("Error searching memories by embedding:", error);
      return [];
    }
  }

  /**
   * Clear all entries for a session
   * @param sessionId The session ID to clear entries for
   * @returns Promise that resolves when clearing is complete
   */
  async clear(sessionId: string): Promise<void> {
    // Validate required parameters
    validateRequiredParam(sessionId, "sessionId", "clear");
    
    try {
      const { database, tableName } = this.config;

      // Delete all entries for the session
      const result = await database
        .knex(tableName!)
        .where({ "sessionId": sessionId })
        .delete();

      logger.debug(`Cleared ${result} entries for session ${sessionId}`);
    } catch (error) {
      logger.error(`Error clearing entries for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Generate a summary of the memory for a specific session
   * @param sessionId The session ID to summarize
   * @returns Text summary of the conversation
   */
  async summarize(sessionId: string): Promise<string> {
    // Validate required parameters
    validateRequiredParam(sessionId, "sessionId", "summarize");
    
    try {
      const memories = await this.getBySession(sessionId);
      if (!memories.length) {
        return "No conversation history available.";
      }

      // Just a simple summary for now - could be enhanced with AI summarization
      const summary = `Conversation with ${memories.length} messages starting at ${memories[0].timestamp.toISOString()}.`;
      
      logger.debug(`Generated summary for session ${sessionId}`);
      return summary;
    } catch (error) {
      logger.error(`Error summarizing session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Add an entry with embedding in one step
   * @param entry The memory entry without ID, timestamp, or embedding
   * @param embedding The embedding vector to add
   * @returns Promise resolving to the ID of the new entry
   */
  async addWithEmbedding(
    entry: Omit<MemoryEntry, "id" | "timestamp" | "embedding">,
    embedding: number[]
  ): Promise<string> {
    // Validate required parameters
    validateRequiredParam(entry, "entry", "addWithEmbedding");
    validateRequiredParam(embedding, "embedding", "addWithEmbedding");
    validateRequiredParams(
      entry,
      ["agentId", "sessionId", "role", "content"],
      "addWithEmbedding"
    );
    
    try {
      const id = await this.add({
        ...entry,
        embedding,
      });
      logger.debug(`Added memory entry ${id} with embedding`);
      return id;
    } catch (error) {
      logger.error("Error adding memory entry with embedding:", error);
      throw error;
    }
  }

  // Add a helper method to validate role values
  private validateRole(role: string): MemoryEntry['role'] {
    const validRoles: MemoryEntry['role'][] = ['system', 'user', 'assistant', 'task_context', 'task_event', 'task_tool', 'task_result'];
    
    // For OpenRouter compatibility, convert task_* roles to user
    if (role.startsWith('task_')) {
      return 'user';
    }
    
    return validRoles.includes(role as MemoryEntry['role']) 
      ? (role as MemoryEntry['role']) 
      : 'user'; // Default to user instead of system for better OpenRouter compatibility
  }

  /**
   * List all sessions for a specific agent
   * @param agentId The agent ID to list sessions for
   * @param limit Maximum number of sessions to return
   * @returns Promise resolving to array of session summaries
   */
  async listSessions(agentId: string, limit?: number): Promise<{
    sessionId: string;
    lastMessage?: string;
    messageCount: number;
    lastActivity: Date;
    metadata?: Record<string, unknown>;
  }[]> {
    validateRequiredParam(agentId, "agentId", "listSessions");
    
    try {
      const { database, tableName, maxEntries } = this.config;

      // Get session summaries with aggregated data
      const sessions = await database
        .knex(tableName!)
        .select('"sessionId"')
        .select(database.knex.raw('COUNT(*) as "messageCount"'))
        .select(database.knex.raw('MAX("timestamp") as "lastActivity"'))
        .select(database.knex.raw('(SELECT content FROM ' + tableName + ' WHERE "sessionId" = t."sessionId" AND "agentId" = ? ORDER BY "timestamp" DESC LIMIT 1) as "lastMessage"', [agentId]))
        .select(database.knex.raw('(SELECT metadata FROM ' + tableName + ' WHERE "sessionId" = t."sessionId" AND "agentId" = ? ORDER BY "timestamp" DESC LIMIT 1) as "metadata"', [agentId]))
        .from(tableName + ' as t')
        .where({ "agentId": agentId })
        .groupBy('"sessionId"')
        .orderBy('"lastActivity"', 'desc')
        .limit(limit || maxEntries!);

      logger.debug(`Retrieved ${sessions.length} sessions for agent ${agentId}`);

      return sessions.map((session: any) => ({
        sessionId: session.sessionId,
        lastMessage: session.lastMessage || undefined,
        messageCount: parseInt(session.messageCount) || 0,
        lastActivity: session.lastActivity instanceof Date ? session.lastActivity : new Date(session.lastActivity),
        metadata: session.metadata ? (typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata) : undefined
      }));
    } catch (error) {
      logger.error(`Error listing sessions for agent ${agentId}:`, error);
      throw error;
    }
  }
}

/**
 * Factory function to create a new memory instance
 * @param config Configuration for the memory instance
 * @returns Promise that resolves to the new memory instance
 */
export const createMemory: MemoryFactory = async (config: MemoryConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createMemory");
  validateRequiredParams(
    config,
    ["database"],
    "createMemory"
  );
  
  return MemoryManager.create(config);
};