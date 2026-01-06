/**
 * Context storage for persistent context management
 * Handles saving/loading context windows to/from database
 */
import { Knex } from 'knex';
import { Logger } from '../logger/types';
import { ContextMessage } from './types';
import { getEncryptionService } from '../database/encryption';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';

/**
 * Custom error class for context data corruption
 * Includes agentId for better debugging and error tracking
 */
export class ContextDataCorruptionError extends Error {
  public readonly agentId: string;
  public readonly cause?: Error;

  constructor(message: string, agentId: string, cause?: Error) {
    super(message);
    this.name = 'ContextDataCorruptionError';
    this.agentId = agentId;
    this.cause = cause;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ContextDataCorruptionError);
    }
  }
}

export interface ContextStorageData {
  id: string;
  agentId: string;
  contextData: ContextMessage[];
  summary?: string;
  tokensUsed: number;
  compressionVersion?: string;
  lastCompressed?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextStorageOptions {
  agentId: string; // UUID
  graphId?: string; // Graph UUID context belongs to
  sessionId?: string; // Conversation session ID
  contextData?: ContextMessage[];
  summary?: string;
  tokensUsed?: number;
  compressionVersion?: string;
}

// Database row interface
interface ContextDbRow {
  id: string; // UUID
  agentId: string; // UUID
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
  private _encryption?: ReturnType<typeof getEncryptionService>;

  private get encryption() {
    if (!this._encryption) {
      this._encryption = getEncryptionService();
    }
    return this._encryption;
  }

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
      id: crypto.randomUUID(), // Generate UUID for context
      agentId: options.agentId,
      graphId: options.graphId || null, // Graph relationship
      sessionId: options.sessionId || null, // Session ID
      contextData: contextDataJson,
      summary: options.summary || null,
      tokensUsed: options.tokensUsed || 0,
      compressionVersion: options.compressionVersion || null,
      lastCompressed: options.compressionVersion ? new Date().toISOString() : null,
    };

    // Encrypt sensitive fields using centralized system
    const encryptedData = await encryptSensitiveFields(insertData, 'contexts');

    // Retry mechanism for handling concurrent modifications
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Use transaction with optimistic locking to prevent race conditions
        const result = await this.knex.transaction(async (trx) => {
          // Check if context already exists for this agent (within transaction)
          const existingContext = await trx('contexts')
            .where({ agentId: options.agentId })
            .forUpdate() // Lock the row to prevent concurrent updates
            .first();

          let dbResult: ContextDbRow;

          if (existingContext) {
            // Update existing context - preserve the existing ID, don't regenerate UUID
            const { id: _, ...updateData } = encryptedData;
            void _; // Intentionally unused - we discard the new ID to keep existing

            // Optimistic locking: check if row was modified since we read it
            const [updated] = await trx('contexts')
              .where({ agentId: options.agentId })
              .where({ updated_at: existingContext.updated_at }) // Ensure row hasn't changed
              .update({
                ...updateData,
                updated_at: trx.fn.now(),
              })
              .returning('*');

            if (!updated) {
              // Row was modified by another process, will retry
              throw new Error(
                `Concurrent modification detected for context ${options.agentId}. Retrying...`
              );
            }
            dbResult = updated;
          } else {
            // Create new context
            const [created] = await trx('contexts').insert(encryptedData).returning('*');
            dbResult = created;
          }

          return dbResult;
        });

        // Decrypt for return using centralized system
        const decryptedResult = await decryptSensitiveFields(
          result as unknown as Record<string, string | number | boolean | null | undefined | Date>,
          'contexts'
        );
        return this.formatContextData(decryptedResult as unknown as ContextDbRow);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Log retry attempt
        if (attempt < MAX_RETRIES - 1) {
          this.logger.warn('Context save failed, retrying...', {
            agentId: options.agentId,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            error: lastError.message,
          });
          // Exponential backoff: 100ms, 200ms, 300ms
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }

    // All retries exhausted
    this.logger.error('Context save failed after all retries', lastError ?? undefined, {
      agentId: options.agentId,
      maxRetries: MAX_RETRIES,
    });
    throw lastError ?? new Error('Context save failed after all retries');
  }

  /**
   * Load context data for an agent
   */
  async loadContext(agentId: string): Promise<ContextStorageData | null> {
    // UUID
    this.logger.debug('Loading context from storage', { agentId });

    const contextRow = await this.knex('contexts').where({ agentId }).first();

    if (!contextRow) {
      this.logger.debug('No context found in storage', { agentId });
      return null;
    }

    // Decrypt sensitive fields using centralized system
    const decryptedRow = await decryptSensitiveFields(
      contextRow as unknown as Record<string, string | number | boolean | null | undefined | Date>,
      'contexts'
    );
    const formattedData = this.formatContextData(decryptedRow as unknown as ContextDbRow);

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
  async deleteContext(agentId: string): Promise<boolean> {
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
    agentId: string, // UUID
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
        // Handle both string and object (PostgreSQL returns JSON as object)
        contextData =
          typeof row.contextData === 'string' ? JSON.parse(row.contextData) : row.contextData;
        // Validate parsed data is an array
        if (!Array.isArray(contextData)) {
          this.logger.error('Context data is not an array after parsing', undefined, {
            agentId: row.agentId,
            dataType: typeof contextData,
          });
          throw new ContextDataCorruptionError(
            `Context data corruption: expected array but got ${typeof contextData}`,
            row.agentId
          );
        }
      } catch (error) {
        // If it's already our custom error, just re-throw without double logging
        if (error instanceof ContextDataCorruptionError) {
          throw error;
        }

        // Log and re-throw to prevent silent data loss
        // Preserve the original error stack trace using cause option
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          'Failed to parse context data - DATA CORRUPTION',
          error instanceof Error ? error : undefined,
          {
            agentId: row.agentId,
            errorMessage,
            dataPreview:
              typeof row.contextData === 'string'
                ? row.contextData.substring(0, 100)
                : 'non-string',
          }
        );
        throw new ContextDataCorruptionError(
          `Context data parsing failed: ${errorMessage}`,
          row.agentId,
          error instanceof Error ? error : undefined
        );
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
