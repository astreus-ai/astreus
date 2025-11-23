import * as fs from 'fs';
import { getEncryptionService } from './encryption';
import { getSensitiveFields } from './sensitive-fields';

/**
 * Simple token counting utility
 * This is a rough approximation - for production use, consider using tiktoken
 */
export function countTokens(text: string): number {
  // Simple estimation: 1 token ≈ 4 characters for English text
  // This is a rough approximation - actual tokenization depends on the model
  return Math.ceil(text.length / 4);
}

/**
 * More accurate word-based token estimation
 */
export function countTokensWordBased(text: string): number {
  const words = text.trim().split(/\s+/);
  // Rough estimation: 1 token ≈ 0.75 words
  return Math.ceil(words.length / 0.75);
}

/**
 * Get file size from file path
 */
export function getFileSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
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
  const encryption = getEncryptionService();

  if (!encryption.isEnabled() || !data) {
    if (!encryption.isEnabled()) {
      console.log(
        `\x1b[36mAstreus [System] Encryption\x1b[0m → \x1b[33mSkipping encryption for ${tableName} (disabled)\x1b[0m`
      );
    }
    return data;
  }

  const encrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToEncrypt = getSensitiveFields(tableName);

  const encryptedFields: string[] = [];
  for (const field of fieldsToEncrypt) {
    if (encrypted[field] !== undefined && encrypted[field] !== null) {
      if (field === 'metadata') {
        // Handle JSON metadata fields - wrap encrypted string in JSON
        const metadataStr =
          typeof encrypted[field] === 'string'
            ? encrypted[field]
            : JSON.stringify(encrypted[field]);
        const encryptedStr = await encryption.encrypt(metadataStr, `${tableName}.${field}`);
        // Wrap in JSON object for JSONB compatibility
        encrypted[field] = JSON.stringify({ _encrypted: encryptedStr });
        encryptedFields.push(field);
      } else if (field === 'contextData' && typeof encrypted[field] === 'string') {
        // Handle JSON contextData field (special case for contexts table)
        encrypted[field] = await encryption.encryptJSON(encrypted[field], `${tableName}.${field}`);
        encryptedFields.push(field);
      } else {
        // Handle string fields
        encrypted[field] = await encryption.encrypt(
          String(encrypted[field]),
          `${tableName}.${field}`
        );
        encryptedFields.push(field);
      }
    }
  }

  if (encryptedFields.length > 0) {
    console.log(
      `\x1b[36mAstreus [System] Encryption\x1b[0m → \x1b[32mEncrypted ${encryptedFields.length} field(s) in ${tableName}\x1b[0m: \x1b[90m${encryptedFields.join(', ')}\x1b[0m`
    );
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
  const encryption = getEncryptionService();

  if (!encryption.isEnabled() || !data) {
    return data;
  }

  const decrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToDecrypt = getSensitiveFields(tableName);

  for (const field of fieldsToDecrypt) {
    if (decrypted[field] !== undefined && decrypted[field] !== null) {
      try {
        if (field === 'metadata') {
          // Handle JSON metadata fields - check for wrapped encrypted format
          const fieldValue = decrypted[field];
          let parsedMetadata:
            | Record<string, unknown>
            | string
            | number
            | boolean
            | null
            | undefined;

          // Try to parse as JSON
          if (typeof fieldValue === 'string') {
            try {
              parsedMetadata = JSON.parse(fieldValue);
            } catch {
              parsedMetadata = fieldValue;
            }
          } else {
            parsedMetadata = fieldValue as
              | Record<string, unknown>
              | string
              | number
              | boolean
              | null
              | undefined;
          }

          // Check if it's our encrypted wrapper format
          if (
            parsedMetadata &&
            typeof parsedMetadata === 'object' &&
            '_encrypted' in parsedMetadata
          ) {
            const encryptedStr = String(parsedMetadata._encrypted);
            const decryptedStr = await encryption.decrypt(encryptedStr, `${tableName}.${field}`);
            // Parse the decrypted JSON string
            try {
              decrypted[field] = JSON.parse(decryptedStr);
            } catch {
              decrypted[field] = decryptedStr;
            }
          } else {
            // Not encrypted or old format - return as is
            decrypted[field] = parsedMetadata as
              | string
              | number
              | boolean
              | Date
              | null
              | undefined;
          }
        } else if (field === 'contextData') {
          // Handle JSON contextData field (special case for contexts table)
          const decryptedData = await encryption.decryptJSON(
            String(decrypted[field]),
            `${tableName}.${field}`
          );
          decrypted[field] =
            typeof decryptedData === 'string' ? decryptedData : JSON.stringify(decryptedData);
        } else {
          // Handle string fields
          decrypted[field] = await encryption.decrypt(
            String(decrypted[field]),
            `${tableName}.${field}`
          );
        }
      } catch (error) {
        // Log error but don't throw - return null for failed decryption
        console.warn(`Failed to decrypt field '${field}' in table '${tableName}':`, error);
        decrypted[field] = null;
      }
    }
  }

  return decrypted;
}
