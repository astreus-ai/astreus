/**
 * Context storage for persistent context management
 * Handles saving/loading context windows to/from database
 */
import { Knex } from 'knex';
import { Logger } from '../logger/types';
import { ContextMessage } from './types';
import { getEncryptionService } from '../database/encryption';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';

export interface ContextStorageData {
  id: number;
  agentId: number;
  contextData: ContextMessage[];
  summary?: string;
  tokensUsed: number;
  compressionVersion?: string;
  lastCompressed?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextStorageOptions {
  agentId: number;
  contextData?: ContextMessage[];
  summary?: string;
  tokensUsed?: number;
  compressionVersion?: string;
}

// Database row interface
interface ContextDbRow {
  id: number;
  agentId: number;
  contextData: string | null;
  summary: string | null;
  tokensUsed: number;
  compressionVersion: string | null;
  lastCompressed: string | null;
  created_at: string;
  updated_at: string;
}

export class ContextStorage {
  private knex: Knex;
  private logger: Logger;
  private encryption = getEncryptionService();

  constructor(knex: Knex, logger: Logger) {
    this.knex = knex;
    this.logger = logger;
  }

  /**
   * Save context data for an agent
   */
  async saveContext(options: ContextStorageOptions): Promise<ContextStorageData> {
    this.logger.debug('Saving context to storage', {
      agentId: options.agentId,
      messagesCount: options.contextData?.length || 0,
      tokensUsed: options.tokensUsed || 0,
    });

    // Prepare data for storage
    const contextDataJson = options.contextData ? JSON.stringify(options.contextData) : null;

    const insertData = {
      agentId: options.agentId,
      contextData: contextDataJson,
      summary: options.summary || null,
      tokensUsed: options.tokensUsed || 0,
      compressionVersion: options.compressionVersion || null,
      lastCompressed: options.compressionVersion ? new Date().toISOString() : null,
    };

    // Encrypt sensitive fields using centralized system
    const encryptedData = await encryptSensitiveFields(insertData, 'contexts');

    // Check if context already exists for this agent
    const existingContext = await this.knex('contexts').where({ agentId: options.agentId }).first();

    let result: ContextDbRow;

    if (existingContext) {
      // Update existing context
      const [updated] = await this.knex('contexts')
        .where({ agentId: options.agentId })
        .update({
          ...encryptedData,
          updated_at: this.knex.fn.now(),
        })
        .returning('*');
      result = updated;
    } else {
      // Create new context
      const [created] = await this.knex('contexts').insert(encryptedData).returning('*');
      result = created;
    }

    // Decrypt for return using centralized system
    const decryptedResult = await decryptSensitiveFields(
      result as Record<string, string | number | boolean | null>,
      'contexts'
    );
    return this.formatContextData(decryptedResult as ContextDbRow);
  }

  /**
   * Load context data for an agent
   */
  async loadContext(agentId: number): Promise<ContextStorageData | null> {
    this.logger.debug('Loading context from storage', { agentId });

    const contextRow = await this.knex('contexts').where({ agentId }).first();

    if (!contextRow) {
      this.logger.debug('No context found in storage', { agentId });
      return null;
    }

    // Decrypt sensitive fields using centralized system
    const decryptedRow = await decryptSensitiveFields(
      contextRow as Record<string, string | number | boolean | null>,
      'contexts'
    );
    const formattedData = this.formatContextData(decryptedRow as ContextDbRow);

    this.logger.debug('Context loaded from storage', {
      agentId,
      messagesCount: formattedData.contextData.length,
      tokensUsed: formattedData.tokensUsed,
    });

    return formattedData;
  }

  /**
   * Delete context data for an agent
   */
  async deleteContext(agentId: number): Promise<boolean> {
    this.logger.debug('Deleting context from storage', { agentId });

    const deleted = await this.knex('contexts').where({ agentId }).delete();

    const success = deleted > 0;
    this.logger.debug('Context deletion result', { agentId, success });

    return success;
  }

  /**
   * Update context tokens and compression info
   */
  async updateContextMetadata(
    agentId: number,
    metadata: {
      tokensUsed?: number;
      compressionVersion?: string;
      summary?: string;
    }
  ): Promise<void> {
    this.logger.debug('Updating context metadata', { agentId, metadata });

    const updateData: Record<string, string | number | null> = {};

    if (metadata.tokensUsed !== undefined) {
      updateData.tokensUsed = metadata.tokensUsed;
    }

    if (metadata.compressionVersion !== undefined) {
      updateData.compressionVersion = metadata.compressionVersion;
      updateData.lastCompressed = new Date().toISOString();
    }

    if (metadata.summary !== undefined) {
      updateData.summary = metadata.summary;
    }

    if (Object.keys(updateData).length > 0) {
      // Encrypt sensitive fields using centralized system
      const encryptedData = await encryptSensitiveFields(updateData, 'contexts');

      await this.knex('contexts')
        .where({ agentId })
        .update({
          ...encryptedData,
          updated_at: this.knex.fn.now(),
        });
    }
  }

  /**
   * Format database row to ContextStorageData
   */
  private formatContextData(row: ContextDbRow): ContextStorageData {
    let contextData: ContextMessage[] = [];

    if (row.contextData) {
      try {
        contextData = JSON.parse(row.contextData);
      } catch (error) {
        this.logger.warn('Failed to parse context data', { error: String(error) });
        contextData = [];
      }
    }

    return {
      id: row.id,
      agentId: row.agentId,
      contextData,
      summary: row.summary || undefined,
      tokensUsed: row.tokensUsed,
      compressionVersion: row.compressionVersion || undefined,
      lastCompressed: row.lastCompressed ? new Date(row.lastCompressed) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
