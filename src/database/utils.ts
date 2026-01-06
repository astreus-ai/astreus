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

  if (!encryption.isEnabled()) {
    const logger = getLogger();
    logger.debug(`Skipping encryption for ${tableName} (disabled)`);
    return data;
  }

  const encrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToEncrypt = getSensitiveFields(tableName);

  const encryptedFields: string[] = [];
  for (const field of fieldsToEncrypt) {
    const fieldValue = encrypted[field];
    if (fieldValue !== undefined && fieldValue !== null) {
      try {
        if (field === 'metadata') {
          // Handle JSON metadata fields - wrap encrypted string in JSON
          const metadataStr =
            typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue);
          const encryptedStr = await encryption.encrypt(
            metadataStr as string,
            `${tableName}.${field}`
          );
          // Wrap in JSON object for JSONB compatibility
          encrypted[field] = JSON.stringify({ _encrypted: encryptedStr });
          encryptedFields.push(field);
        } else if (field === 'contextData' && typeof fieldValue === 'string') {
          // Handle JSON contextData field (special case for contexts table)
          encrypted[field] = await encryption.encryptJSON(fieldValue, `${tableName}.${field}`);
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

  if (encryptedFields.length > 0) {
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
export async function decryptSensitiveFields(
  data: Record<string, string | number | boolean | null | undefined | Date>,
  tableName: string
): Promise<Record<string, string | number | boolean | null | undefined | Date>> {
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

  if (!encryption.isEnabled()) {
    return data;
  }

  const decrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToDecrypt = getSensitiveFields(tableName);

  for (const field of fieldsToDecrypt) {
    const fieldValue = decrypted[field];
    if (fieldValue !== undefined && fieldValue !== null) {
      try {
        if (field === 'metadata') {
          // Handle JSON metadata fields - check for wrapped encrypted format
          let parsedMetadata: unknown;

          // Try to parse as JSON
          if (typeof fieldValue === 'string') {
            try {
              parsedMetadata = JSON.parse(fieldValue);
            } catch {
              parsedMetadata = fieldValue;
            }
          } else {
            // fieldValue could be an object, number, boolean, or Date
            parsedMetadata = fieldValue;
          }

          // Check if it's our encrypted wrapper format
          if (
            parsedMetadata !== null &&
            parsedMetadata !== undefined &&
            typeof parsedMetadata === 'object' &&
            !Array.isArray(parsedMetadata) &&
            '_encrypted' in parsedMetadata
          ) {
            const encryptedWrapper = parsedMetadata as { _encrypted: unknown };
            const encryptedStr = String(encryptedWrapper._encrypted);
            const decryptedStr = await encryption.decrypt(encryptedStr, `${tableName}.${field}`);
            // Parse the decrypted JSON string
            try {
              const parsedResult = JSON.parse(decryptedStr);
              // Ensure the result is a valid field type
              if (
                typeof parsedResult === 'string' ||
                typeof parsedResult === 'number' ||
                typeof parsedResult === 'boolean' ||
                parsedResult === null
              ) {
                decrypted[field] = parsedResult;
              } else {
                // For objects/arrays, stringify back
                decrypted[field] = JSON.stringify(parsedResult);
              }
            } catch {
              decrypted[field] = decryptedStr;
            }
          } else {
            // Not encrypted or old format - convert to valid field type
            if (
              typeof parsedMetadata === 'string' ||
              typeof parsedMetadata === 'number' ||
              typeof parsedMetadata === 'boolean' ||
              parsedMetadata === null ||
              parsedMetadata === undefined ||
              parsedMetadata instanceof Date
            ) {
              decrypted[field] = parsedMetadata;
            } else {
              // For objects/arrays, stringify
              decrypted[field] = JSON.stringify(parsedMetadata);
            }
          }
        } else if (field === 'contextData') {
          // Handle JSON contextData field (special case for contexts table)
          const decryptedData = await encryption.decryptJSON(
            String(fieldValue),
            `${tableName}.${field}`
          );
          decrypted[field] =
            typeof decryptedData === 'string' ? decryptedData : JSON.stringify(decryptedData);
        } else {
          // Handle string fields
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

  return decrypted;
}
