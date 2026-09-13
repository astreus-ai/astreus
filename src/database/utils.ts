import * as fs from 'fs';
import { getEncryptionService } from './encryption';
import { getSensitiveFields } from './sensitive-fields';
import { getLogger } from '../logger';

/**
 * Validate table name to prevent injection attacks
 * Only allows alphanumeric characters and underscores
 */
function isValidTableName(tableName: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName);
}

/**
 * Simple token counting utility
 * This is a rough approximation - for production use, consider using tiktoken
 */
export function countTokens(text: string): number {
  // Input validation
  if (typeof text !== 'string') {
    throw new TypeError('countTokens: text must be a string');
  }

  // Handle empty string case
  if (text.length === 0) {
    return 0;
  }

  // Check for potential overflow - text.length is already bounded by string max length
  // but we add explicit check for safety with division result
  const rawTokenCount = text.length / 4;

  // Ensure we don't exceed safe integer bounds
  if (rawTokenCount > Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }

  // Simple estimation: 1 token ≈ 4 characters for English text
  // This is a rough approximation - actual tokenization depends on the model
  return Math.ceil(rawTokenCount);
}

/**
 * More accurate word-based token estimation
 */
export function countTokensWordBased(text: string): number {
  // Input validation
  if (typeof text !== 'string') {
    throw new TypeError('countTokensWordBased: text must be a string');
  }

  const trimmed = text.trim();

  // Handle empty string case
  if (trimmed.length === 0) {
    return 0;
  }

  const words = trimmed.split(/\s+/);
  // Rough estimation: 1 token ≈ 0.75 words
  return Math.ceil(words.length / 0.75);
}

/**
 * Get file size from file path (async version - preferred)
 */
export async function getFileSizeAsync(filePath: string): Promise<number> {
  // Input validation
  if (typeof filePath !== 'string') {
    throw new TypeError('getFileSizeAsync: filePath must be a string');
  }

  if (filePath.trim().length === 0) {
    throw new Error('getFileSizeAsync: filePath cannot be empty');
  }

  // Prevent path traversal attacks
  if (filePath.includes('\0')) {
    throw new Error('getFileSizeAsync: filePath contains invalid characters');
  }

  try {
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  } catch (error) {
    // Return 0 for non-existent files
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return 0;
    }
    // Re-throw other errors (permission issues, etc.)
    throw error;
  }
}

type DecryptedFields<T> = { [K in keyof T]: T[K] | string | null };

/** Normalize driver-decoded JSON and SQLite JSON text without exposing data in errors. */
export function parseStoredJson(value: unknown, fieldName: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid JSON in field ${fieldName}`);
  }
}

export function validateContextJson(value: unknown): void {
  if (
    value !== null &&
    (!Array.isArray(value) ||
      value.some(
        (message: unknown) =>
          !message ||
          typeof message !== 'object' ||
          Array.isArray(message) ||
          !('role' in message) ||
          typeof message.role !== 'string' ||
          !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
          !('content' in message) ||
          typeof message.content !== 'string'
      ))
  ) {
    throw new Error('Invalid contexts.contextData: expected an array of message objects or null');
  }
}

function validateJsonValue(value: unknown, fieldName: string): void {
  if (fieldName === 'contexts.contextData') validateContextJson(value);
  if (JSON.stringify(value) === undefined) throw new Error(`Invalid JSON in field ${fieldName}`);
}

/** Both JSON columns use the same authenticated envelope. Text fields remain text. */
export async function decryptJsonField(value: unknown, fieldName: string): Promise<string | null> {
  let parsed = parseStoredJson(value, fieldName);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && '_encrypted' in parsed) {
    const encryption = getEncryptionService();
    if (
      Object.keys(parsed).length !== 1 ||
      typeof parsed._encrypted !== 'string' ||
      !encryption.isEncrypted(parsed._encrypted)
    ) {
      throw new Error(`Invalid encrypted JSON envelope in field ${fieldName}`);
    }
    if (!encryption.isEnabled()) {
      throw new Error(`Encryption must be enabled to decrypt field ${fieldName}`);
    }
    parsed = parseStoredJson(await encryption.decrypt(parsed._encrypted, fieldName), fieldName);
  }
  validateJsonValue(parsed, fieldName);
  return parsed === null ? null : JSON.stringify(parsed);
}

async function encryptJsonField(value: unknown, fieldName: string): Promise<string | null> {
  const plaintext = await decryptJsonField(value, fieldName);
  if (plaintext === null) return null;
  const encryption = getEncryptionService();
  if (!encryption.isEnabled()) return plaintext;
  return JSON.stringify({ _encrypted: await encryption.encrypt(plaintext, fieldName) });
}

/**
 * Centralized encryption utility for database fields
 * Encrypts sensitive fields based on centralized configuration
 */
export async function encryptSensitiveFields(
  data: Record<string, string | number | boolean | null | undefined | Date>,
  tableName: string
): Promise<Record<string, string | number | boolean | null | undefined | Date>> {
  // Input validation
  if (typeof tableName !== 'string' || tableName.trim().length === 0) {
    throw new Error('encryptSensitiveFields: tableName must be a non-empty string');
  }

  if (!isValidTableName(tableName)) {
    throw new Error('encryptSensitiveFields: tableName contains invalid characters');
  }

  // Handle null/undefined data gracefully
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    throw new TypeError('encryptSensitiveFields: data must be an object');
  }

  const encryption = getEncryptionService();

  const encrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToEncrypt = getSensitiveFields(tableName);

  const encryptedFields: string[] = [];
  for (const field of fieldsToEncrypt) {
    const fieldValue = encrypted[field];
    if (fieldValue !== undefined && fieldValue !== null) {
      try {
        if (field === 'metadata' || field === 'contextData') {
          encrypted[field] = await encryptJsonField(fieldValue, `${tableName}.${field}`);
          encryptedFields.push(field);
        } else {
          // Handle string fields
          encrypted[field] = await encryption.encrypt(String(fieldValue), `${tableName}.${field}`);
          encryptedFields.push(field);
        }
      } catch (error) {
        // Log error and re-throw with more context
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(
          `Failed to encrypt field '${field}' in table '${tableName}': ${errorMessage}`
        );
      }
    }
  }

  if (encryption.isEnabled() && encryptedFields.length > 0) {
    const logger = getLogger();
    logger.debug(`Encrypted ${encryptedFields.length} field(s) in ${tableName}`, {
      fields: encryptedFields,
    });
  }

  return encrypted;
}

/**
 * Centralized decryption utility for database fields
 * Decrypts sensitive fields based on centralized configuration
 */
export async function decryptSensitiveFields<T extends Record<string, unknown>>(
  data: T,
  tableName: string
): Promise<DecryptedFields<T>> {
  // Input validation
  if (typeof tableName !== 'string' || tableName.trim().length === 0) {
    throw new Error('decryptSensitiveFields: tableName must be a non-empty string');
  }

  if (!isValidTableName(tableName)) {
    throw new Error('decryptSensitiveFields: tableName contains invalid characters');
  }

  // Handle null/undefined data gracefully
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    throw new TypeError('decryptSensitiveFields: data must be an object');
  }

  const encryption = getEncryptionService();

  const decrypted: Record<string, unknown> = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToDecrypt = getSensitiveFields(tableName);

  for (const field of fieldsToDecrypt) {
    const fieldValue = decrypted[field];
    if (fieldValue !== undefined && fieldValue !== null) {
      try {
        if (field === 'metadata' || field === 'contextData') {
          const json = await decryptJsonField(fieldValue, `${tableName}.${field}`);
          // Validate either mode, but preserve plaintext driver types for existing callers.
          if (encryption.isEnabled()) decrypted[field] = json;
        } else if (encryption.isEnabled()) {
          decrypted[field] = await encryption.decrypt(String(fieldValue), `${tableName}.${field}`);
        }
      } catch (error) {
        // Log error with proper logger and throw to prevent silent data corruption
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const logger = getLogger();
        logger.error(
          `Decryption failed for field '${field}' in table '${tableName}': ${errorMessage}`
        );
        throw new Error(
          `Failed to decrypt field '${field}' in table '${tableName}': ${errorMessage}`
        );
      }
    }
  }

  return decrypted as DecryptedFields<T>;
}
