import { IAgentModule, IAgent } from '../agent/types';
import { Memory as MemoryType, MemorySearchOptions } from './types';
import { getDatabase } from '../database';
import { MetadataObject } from '../types';
import { Logger } from '../logger/types';
import { DEFAULT_MEMORY_CONFIG } from './defaults';
import { Knex } from 'knex';
import { getEncryptionService } from '../database/encryption';
import { getLLM } from '../llm';

interface MemoryDbRow {
  id: number;
  agentId: number;
  content: string;
  embedding: string | null;
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
  private encryption = getEncryptionService();

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
   * Encrypt sensitive memory fields before storing
   */
  private async encryptMemoryData(
    data: Record<string, string | number | boolean | null>
  ): Promise<Record<string, string | number | boolean | null>> {
    if (!this.encryption.isEnabled()) {
      return data;
    }

    const encrypted = { ...data };

    if (encrypted.content !== undefined && encrypted.content !== null) {
      encrypted.content = await this.encryption.encrypt(
        String(encrypted.content),
        'memories.content'
      );
    }

    if (encrypted.metadata !== undefined && encrypted.metadata !== null) {
      encrypted.metadata = await this.encryption.encryptJSON(
        String(encrypted.metadata),
        'memories.metadata'
      );
    }

    return encrypted;
  }

  /**
   * Decrypt sensitive memory fields after retrieving
   */
  private async decryptMemoryData(
    data: Record<string, string | number | boolean | null>
  ): Promise<Record<string, string | number | boolean | null>> {
    if (!this.encryption.isEnabled() || !data) {
      return data;
    }

    const decrypted = { ...data };

    if (decrypted.content !== undefined && decrypted.content !== null) {
      decrypted.content = await this.encryption.decrypt(
        String(decrypted.content),
        'memories.content'
      );
    }

    if (decrypted.metadata !== undefined && decrypted.metadata !== null) {
      const decryptedMetadata = await this.encryption.decryptJSON(
        String(decrypted.metadata),
        'memories.metadata'
      );
      decrypted.metadata = decryptedMetadata ? JSON.stringify(decryptedMetadata) : null;
    }

    return decrypted;
  }

  /**
   * Generate embedding for memory content
   */
  private async generateEmbedding(content: string): Promise<number[] | null> {
    try {
      // Import knowledge system to access embedding generation

      // Check if agent has knowledge/embedding capabilities
      if (!this.agent || typeof this.agent.config.embeddingModel !== 'string') {
        this.logger.debug('No embedding model configured for agent, skipping embedding generation');
        return null;
      }

      // Get embedding provider from knowledge system
      // This is a bit indirect but reuses existing embedding infrastructure
      const embeddingProvider = {
        name: this.agent.config.embeddingModel || DEFAULT_MEMORY_CONFIG.defaultEmbeddingModel,
        generateEmbedding: async (text: string) => {
          // Import and use the same embedding logic as knowledge system
          const llm = getLLM(this.logger);
          const result = await llm.generateEmbedding(text, this.agent.config.embeddingModel);
          return result;
        },
      };

      const result = await embeddingProvider.generateEmbedding(content);
      return result.embedding;
    } catch (error) {
      this.logger.debug('Failed to generate embedding for memory', {
        error: error instanceof Error ? error.message : String(error),
        contentLength: content.length,
      });
      return null;
    }
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
      hasMetadata: !!metadata,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    // Generate embedding for content (before encryption)
    const embedding = await this.generateEmbedding(content);

    // Prepare data for encryption
    const insertData = {
      agentId: this.agent.id,
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    // Encrypt sensitive fields (embedding stays unencrypted for search)
    const encryptedData = await this.encryptMemoryData(insertData);

    const [memory] = await this.knex!(tableName).insert(encryptedData).returning('*');

    // Decrypt for response
    const decryptedMemory = await this.decryptMemoryData(
      memory as Record<string, string | number | boolean | null>
    );
    const formattedMemory = this.formatMemory(decryptedMemory as unknown as MemoryDbRow);

    this.logger.debug('Memory added successfully', {
      memoryId: formattedMemory.id || 0,
      type: String(memoryType),
    });

    return formattedMemory;
  }

  /**
   * Remember a conversation (alias for add with conversation metadata)
   */
  async rememberConversation(
    content: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<MemoryType> {
    return this.addMemory(content, { type: 'conversation', role });
  }

  /**
   * Get a memory by ID
   */
  async getMemory(id: number): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';

    const memory = await this.knex!(tableName).where({ id, agentId: this.agent.id }).first();

    if (!memory) return null;

    // Decrypt sensitive fields
    const decryptedMemory = await this.decryptMemoryData(
      memory as Record<string, string | number | boolean | null>
    );
    return this.formatMemory(decryptedMemory as unknown as MemoryDbRow);
  }

  /**
   * Search memories
   */
  async searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryType[]> {
    // Check if we should use embedding search
    if (options?.useEmbedding !== false) {
      // Try embedding search first, fallback to text search if needed
      try {
        return await this.searchMemoriesBySimilarity(query, options);
      } catch (error) {
        this.logger.debug('Embedding search failed, falling back to text search', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // User-facing info log
    this.logger.info(`Searching memories for: "${query}"`);

    this.logger.debug('Searching memories', {
      query,
      ...(options?.limit && { limit: options.limit }),
      ...(options?.startDate && { startDate: options.startDate }),
      ...(options?.endDate && { endDate: options.endDate }),
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    const limit = options?.limit || 10;
    const offset = options?.offset || 0;

    let dbQuery = this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    // When encryption is enabled, we can't search encrypted content directly in SQL
    // We need to retrieve all memories and search after decryption
    if (this.encryption.isEnabled()) {
      // Remove the SQL LIKE search and do it in memory after decryption
      if (options?.startDate) {
        dbQuery = dbQuery.where('created_at', '>=', options.startDate);
      }

      if (options?.endDate) {
        dbQuery = dbQuery.where('created_at', '<=', options.endDate);
      }

      // Get all memories for this agent (with date filters if applicable)
      const allMemories = await dbQuery;

      // Decrypt and search in memory
      const matchingMemories: Record<string, string | number | boolean | null>[] = [];
      for (const memory of allMemories) {
        try {
          const decryptedMemory = await this.decryptMemoryData(memory);
          if (
            decryptedMemory.content &&
            typeof decryptedMemory.content === 'string' &&
            decryptedMemory.content.toLowerCase().includes(query.toLowerCase())
          ) {
            matchingMemories.push(decryptedMemory);
            if (matchingMemories.length >= limit) break;
          }
        } catch {
          // If decryption fails, skip this memory (might be unencrypted legacy data)
          this.logger.debug('Failed to decrypt memory during search', { memoryId: memory.id });
        }
      }

      // User-facing result summary
      this.logger.info(
        `Found ${matchingMemories.length} matching ${matchingMemories.length === 1 ? 'memory' : 'memories'}`
      );

      this.logger.debug(`Found ${matchingMemories.length} memories`, {
        resultCount: matchingMemories.length,
        sampleIds: matchingMemories.slice(0, 3).map((m) => Number(m.id)),
        hasResults: matchingMemories.length > 0,
      });

      return matchingMemories.map((memory) => this.formatMemory(memory as unknown as MemoryDbRow));
    } else {
      // Encryption not enabled, use traditional SQL search
      dbQuery = dbQuery.where('content', 'like', `%${query}%`);

      if (options?.startDate) {
        dbQuery = dbQuery.where('created_at', '>=', options.startDate);
      }

      if (options?.endDate) {
        dbQuery = dbQuery.where('created_at', '<=', options.endDate);
      }

      const memories = await dbQuery;

      // User-facing result summary
      this.logger.info(
        `Found ${memories.length} matching ${memories.length === 1 ? 'memory' : 'memories'}`
      );

      this.logger.debug(`Found ${memories.length} memories`, {
        resultCount: memories.length,
        sampleIds: memories.slice(0, 3).map((m) => Number(m.id)),
        hasResults: memories.length > 0,
      });

      return memories.map((memory) => this.formatMemory(memory));
    }
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
      agentId: this.agent.id,
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

    // Decrypt memories if encryption is enabled
    if (this.encryption.isEnabled()) {
      const decryptedMemories = await Promise.all(
        memories.map(async (memory) => {
          try {
            const decrypted = await this.decryptMemoryData(
              memory as Record<string, string | number | boolean | null>
            );
            return this.formatMemory(decrypted as unknown as MemoryDbRow);
          } catch {
            // If decryption fails, return original memory (might be unencrypted legacy data)
            this.logger.debug('Failed to decrypt memory during list', { memoryId: memory.id });
            return this.formatMemory(memory);
          }
        })
      );
      return decryptedMemories;
    } else {
      return memories.map((memory) => this.formatMemory(memory));
    }
  }

  /**
   * Update a memory
   */
  async updateMemory(
    id: number,
    updates: { content?: string; metadata?: MetadataObject }
  ): Promise<MemoryType | null> {
    await this.ensureDatabase();
    const tableName = 'memories';

    const updateData: Partial<MemoryDbRow> = {};

    // If content is being updated, regenerate embedding
    if (updates.content !== undefined) {
      updateData.content = updates.content;
      // Generate new embedding for updated content
      const embedding = await this.generateEmbedding(updates.content);
      updateData.embedding = embedding ? JSON.stringify(embedding) : null;
    }

    if (updates.metadata !== undefined) {
      updateData.metadata = JSON.stringify(updates.metadata);
    }

    if (Object.keys(updateData).length === 0) {
      return this.getMemory(id);
    }

    // Encrypt sensitive fields in update data (embedding stays unencrypted)
    const encryptedUpdateData = await this.encryptMemoryData(updateData);

    const [memory] = await this.knex!(tableName)
      .where({ id, agentId: this.agent.id })
      .update(encryptedUpdateData)
      .returning('*');

    if (!memory) return null;

    // Decrypt for response
    const decryptedMemory = await this.decryptMemoryData(
      memory as Record<string, string | number | boolean | null>
    );
    return this.formatMemory(decryptedMemory as unknown as MemoryDbRow);
  }

  /**
   * Delete a memory
   */
  async deleteMemory(id: number): Promise<boolean> {
    this.logger.info(`Deleting memory: ${id}`);

    await this.ensureDatabase();
    const tableName = 'memories';

    const deleted = await this.knex!(tableName).where({ id, agentId: this.agent.id }).delete();

    const success = deleted > 0;

    if (success) {
      this.logger.info(`Memory ${id} deleted successfully`);
    } else {
      this.logger.warn(`Failed to delete memory ${id} - not found or unauthorized`);
    }

    this.logger.debug('Delete memory result', {
      memoryId: id,
      success,
      agentId: this.agent.id,
    });

    return success;
  }

  /**
   * Search memories using vector similarity
   */
  async searchMemoriesBySimilarity(
    query: string,
    options?: MemorySearchOptions
  ): Promise<MemoryType[]> {
    // User-facing info log
    this.logger.info(`Searching memories by similarity for: "${query}"`);

    this.logger.debug('Vector similarity search for memories', {
      query,
      threshold: options?.similarityThreshold || 0.7,
      limit: options?.limit || 10,
      agentId: this.agent.id,
    });

    await this.ensureDatabase();
    const tableName = 'memories';

    // Generate embedding for search query
    const queryEmbedding = await this.generateEmbedding(query);

    if (!queryEmbedding) {
      this.logger.warn('Could not generate embedding for query, falling back to text search');
      return this.searchMemories(query, options);
    }

    const limit = options?.limit || 10;
    const threshold = options?.similarityThreshold || 0.7;

    // For SQLite: Calculate similarity in memory (less efficient but works)
    // For PostgreSQL: Use pgvector for efficient similarity search
    const memories = await this.knex!(tableName)
      .where({ agentId: this.agent.id })
      .whereNotNull('embedding')
      .orderBy('created_at', 'desc');

    // Calculate similarities and filter
    const memoriesWithSimilarity = memories
      .map((memory) => {
        if (!memory.embedding) return null;

        try {
          const memoryEmbedding = JSON.parse(memory.embedding);
          const similarity = this.cosineSimilarity(queryEmbedding, memoryEmbedding);

          return {
            ...memory,
            similarity,
          };
        } catch {
          this.logger.debug('Failed to parse embedding for memory', { memoryId: memory.id });
          return null;
        }
      })
      .filter(
        (item): item is NonNullable<typeof item> => item !== null && item.similarity >= threshold
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Decrypt and format results
    const decryptedMemories = await Promise.all(
      memoriesWithSimilarity.map(async (memory) => {
        try {
          const decrypted = await this.decryptMemoryData(
            memory as Record<string, string | number | boolean | null>
          );
          return this.formatMemory(decrypted as unknown as MemoryDbRow);
        } catch {
          this.logger.debug('Failed to decrypt memory during similarity search', {
            memoryId: memory.id,
          });
          return this.formatMemory(memory);
        }
      })
    );

    // User-facing result summary
    this.logger.info(
      `Found ${decryptedMemories.length} similar ${decryptedMemories.length === 1 ? 'memory' : 'memories'}`
    );

    this.logger.debug(`Vector similarity search completed`, {
      resultCount: decryptedMemories.length,
      sampleIds: decryptedMemories.slice(0, 3).map((m) => Number(m.id)),
      hasResults: decryptedMemories.length > 0,
    });

    return decryptedMemories;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Generate embedding for a specific memory
   */
  async generateEmbeddingForMemory(memoryId: number): Promise<{
    success: boolean;
    message: string;
    embedding?: number[];
  }> {
    this.logger.info(`Generating embedding for memory: ${memoryId}`);

    await this.ensureDatabase();
    const tableName = 'memories';

    // Get memory by ID
    const memory = await this.knex!(tableName)
      .where({ id: memoryId, agentId: this.agent.id })
      .first();

    if (!memory) {
      this.logger.debug('Memory not found for embedding generation', {
        memoryId,
        agentId: this.agent.id,
      });
      return {
        success: false,
        message: 'Memory not found',
      };
    }

    // Check if memory already has embedding
    if (memory.embedding) {
      this.logger.debug('Memory already has embedding', { memoryId });
      return {
        success: false,
        message: 'Memory already has embedding',
      };
    }

    // Decrypt content for embedding generation
    let content: string;
    try {
      const decryptedMemory = await this.decryptMemoryData(
        memory as Record<string, string | number | boolean | null>
      );
      content = String(decryptedMemory.content);
    } catch (error) {
      this.logger.debug('Failed to decrypt memory content', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: 'Failed to decrypt memory content',
      };
    }

    // Generate embedding for the content
    const embedding = await this.generateEmbedding(content);

    if (!embedding) {
      this.logger.debug('Failed to generate embedding', {
        memoryId,
        contentLength: content.length,
      });
      return {
        success: false,
        message: 'Failed to generate embedding',
      };
    }

    // Update memory with embedding
    try {
      await this.knex!(tableName)
        .where({ id: memoryId, agentId: this.agent.id })
        .update({ embedding: JSON.stringify(embedding) });

      this.logger.info(`Embedding generated successfully for memory: ${memoryId}`);

      this.logger.debug('Embedding generation completed', {
        memoryId,
        embeddingDimensions: embedding.length,
        contentLength: content.length,
      });

      return {
        success: true,
        message: 'Embedding generated successfully',
        embedding,
      };
    } catch (error) {
      this.logger.debug('Failed to update memory with embedding', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: 'Failed to store embedding',
      };
    }
  }

  /**
   * Clear all memories
   */
  async clearMemories(): Promise<number> {
    this.logger.info('Clearing all memories');

    await this.ensureDatabase();
    const tableName = 'memories';

    const deletedCount = await this.knex!(tableName).where({ agentId: this.agent.id }).delete();

    this.logger.info(`Cleared ${deletedCount} ${deletedCount === 1 ? 'memory' : 'memories'}`);

    this.logger.debug('Clear memories result', {
      deletedCount,
      agentId: this.agent.id,
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
      embedding: memory.embedding ? JSON.parse(memory.embedding) : undefined,
      metadata: memory.metadata ? JSON.parse(memory.metadata) : undefined,
      createdAt: new Date(memory.created_at),
      updatedAt: new Date(memory.updated_at),
    };
  }
}

// Export types
export type { Memory as MemoryType, MemorySearchOptions } from './types';
