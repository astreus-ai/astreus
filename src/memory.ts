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
      
      // Check if embeddings are enabled in the config
      if (fullConfig.enableEmbeddings) {
        logger.info("Initializing memory with embedding support");

        // Ensure the database has the embedding column
        const { database, tableName } = fullConfig;
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

      return new MemoryManager(fullConfig);
    } catch (error) {
      logger.error("Error creating memory instance:", error);
      throw error;
    }
  }

  /**
   * Add an entry to memory
   * @param entry The memory entry without ID or timestamp
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
      const { database, tableName } = this.config;

      // Generate ID and timestamp
      const id = uuidv4();
      const timestamp = new Date();

      // Create a copy to avoid modifying the original
      const entryToInsert = { ...entry };

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
      logger.debug(`Added memory entry ${id}`);

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
        .where({ sessionId })
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
        .where({ agentId })
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
        .where({ userId })
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
   * Clear memories for a specific session
   * @param sessionId The session ID to clear memories for
   */
  async clear(sessionId: string): Promise<void> {
    // Validate required parameters
    validateRequiredParam(sessionId, "sessionId", "clear");
    
    try {
      const { database, tableName } = this.config;
      const count = await database.knex(tableName!).where({ sessionId }).delete();
      logger.info(`Cleared ${count} memories for session ${sessionId}`);
    } catch (error) {
      logger.error(`Error clearing memories for session ${sessionId}:`, error);
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
      const summary = `Conversation with ${
        memories.length
      } messages starting at ${memories[0].timestamp.toISOString()}.`;
      
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
    const validRoles: MemoryEntry['role'][] = ['system', 'user', 'assistant', 'task_context'];
    return validRoles.includes(role as MemoryEntry['role']) 
      ? (role as MemoryEntry['role']) 
      : 'system'; // Default to system if invalid
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