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
  data: Record<string, string | number | boolean | null>,
  tableName: string
): Promise<Record<string, string | number | boolean | null>> {
  const encryption = getEncryptionService();

  if (!encryption.isEnabled() || !data) {
    return data;
  }

  const encrypted = { ...data };

  // Get sensitive fields from centralized configuration
  const fieldsToEncrypt = getSensitiveFields(tableName);

  for (const field of fieldsToEncrypt) {
    if (encrypted[field] !== undefined && encrypted[field] !== null) {
      if (field === 'metadata' && typeof encrypted[field] === 'object') {
        // Handle JSON metadata fields
        encrypted[field] = await encryption.encryptJSON(encrypted[field], `${tableName}.${field}`);
      } else if (field === 'contextData' && typeof encrypted[field] === 'string') {
        // Handle JSON contextData field (special case for contexts table)
        encrypted[field] = await encryption.encryptJSON(encrypted[field], `${tableName}.${field}`);
      } else {
        // Handle string fields
        encrypted[field] = await encryption.encrypt(
          String(encrypted[field]),
          `${tableName}.${field}`
        );
      }
    }
  }

  return encrypted;
}

/**
 * Centralized decryption utility for database fields
 * Decrypts sensitive fields based on centralized configuration
 */
export async function decryptSensitiveFields(
  data: Record<string, string | number | boolean | null>,
  tableName: string
): Promise<Record<string, string | number | boolean | null>> {
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
          // Handle JSON metadata fields
          decrypted[field] = await encryption.decryptJSON(
            String(decrypted[field]),
            `${tableName}.${field}`
          );
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
