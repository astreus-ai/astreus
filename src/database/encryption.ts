import { createCipheriv, createDecipheriv, randomBytes, scrypt, pbkdf2 } from 'crypto';
import { promisify } from 'util';
import { getLogger } from '../logger';

const scryptAsync = promisify(scrypt);
const pbkdf2Async = promisify(pbkdf2);

export interface EncryptionConfig {
  enabled: boolean;
  masterKey: string;
  algorithm: string;
}

export interface EncryptedData {
  iv: string;
  encrypted: string;
  tag: string;
  version: number;
}

/**
 * Encryption service for database field-level encryption
 * Uses AES-256-GCM for authenticated encryption
 */
export class EncryptionService {
  private config: EncryptionConfig;
  private keyCache: Map<string, Buffer> = new Map();
  private static readonly MAX_CACHE_SIZE = 100; // Prevent unbounded memory growth

  // Current encryption version for future key rotation support
  private readonly CURRENT_VERSION = 1;
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly IV_LENGTH = 12; // 12 bytes for GCM
  private readonly TAG_LENGTH = 16; // 16 bytes for GCM auth tag
  private readonly SALT_LENGTH = 32; // 32 bytes for salt
  private readonly PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum

  constructor(config: EncryptionConfig) {
    this.config = config;

    if (config.enabled && !config.masterKey) {
      throw new Error('ENCRYPTION_MASTER_KEY is required when encryption is enabled');
    }

    if (config.enabled && config.masterKey.length < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must be at least 32 characters long');
    }
  }

  /**
   * Check if encryption is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Derive a field-specific encryption key using secure salt generation
   * Uses LRU (Least Recently Used) cache eviction strategy
   */
  private async deriveKey(fieldName: string): Promise<Buffer> {
    const cacheKey = `${fieldName}_v${this.CURRENT_VERSION}`;

    if (this.keyCache.has(cacheKey)) {
      // LRU: Move accessed key to end by deleting and re-adding
      const cachedKey = this.keyCache.get(cacheKey)!;
      this.keyCache.delete(cacheKey);
      this.keyCache.set(cacheKey, cachedKey);
      return cachedKey;
    }

    // Generate deterministic but secure salt from field name and master key
    // This ensures same field gets same key while being cryptographically secure
    const fieldBuffer = Buffer.from(fieldName, 'utf8');
    const versionBuffer = Buffer.from(this.CURRENT_VERSION.toString(), 'utf8');
    const contextBuffer = Buffer.concat([fieldBuffer, versionBuffer]);

    // Use PBKDF2 to create a secure salt from the context
    const salt = await pbkdf2Async(
      this.config.masterKey,
      contextBuffer,
      this.PBKDF2_ITERATIONS,
      this.SALT_LENGTH,
      'sha256'
    );

    // Derive the actual encryption key using scrypt with the secure salt
    const derivedKey = (await scryptAsync(this.config.masterKey, salt, 32)) as Buffer;

    // Enforce cache size limit to prevent memory leaks (LRU eviction)
    if (this.keyCache.size >= EncryptionService.MAX_CACHE_SIZE) {
      // Remove least recently used entry (first key in Map iteration order)
      const keysIterator = this.keyCache.keys().next();
      if (!keysIterator.done && keysIterator.value !== undefined) {
        this.keyCache.delete(keysIterator.value);
      }
    }
    this.keyCache.set(cacheKey, derivedKey);
    return derivedKey;
  }

  /**
   * Encrypt a string value
   */
  async encrypt(value: string, fieldName: string): Promise<string> {
    if (!this.config.enabled) {
      return value; // Return original value if encryption is disabled
    }

    if (value === null || value === undefined || value === '') {
      return value; // Don't encrypt empty values
    }

    // Check if value is already encrypted
    if (this.isEncrypted(value)) {
      return value; // Already encrypted, return as is
    }

    try {
      const key = await this.deriveKey(fieldName);
      const iv = randomBytes(this.IV_LENGTH);

      const cipher = createCipheriv(this.ALGORITHM, key, iv);

      let encrypted = cipher.update(value, 'utf8', 'base64');
      encrypted += cipher.final('base64');

      const tag = cipher.getAuthTag();

      const encryptedData: EncryptedData = {
        iv: iv.toString('base64'),
        encrypted,
        tag: tag.toString('base64'),
        version: this.CURRENT_VERSION,
      };

      // Format: enc:version:iv:encrypted:tag
      return `enc:${encryptedData.version}:${encryptedData.iv}:${encryptedData.encrypted}:${encryptedData.tag}`;
    } catch (error) {
      throw new Error(
        `Encryption failed for field ${fieldName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Decrypt a string value
   */
  async decrypt(value: string, fieldName: string): Promise<string> {
    if (!this.config.enabled) {
      return value; // Return original value if encryption is disabled
    }

    if (value === null || value === undefined || value === '') {
      return value; // Return empty values as is
    }

    // Check if value is encrypted
    if (!this.isEncrypted(value)) {
      return value; // Not encrypted, return as is
    }

    try {
      const encryptedData = this.parseEncryptedData(value);
      const key = await this.deriveKey(fieldName);

      const decipher = createDecipheriv(
        this.ALGORITHM,
        key,
        Buffer.from(encryptedData.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));

      let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(
        `Decryption failed for field ${fieldName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if a value appears to be encrypted
   */
  isEncrypted(value: string): boolean {
    if (typeof value !== 'string') return false;
    return value.startsWith('enc:') && value.split(':').length === 5;
  }

  /**
   * Parse encrypted data string into components
   */
  private parseEncryptedData(encryptedString: string): EncryptedData {
    const parts = encryptedString.split(':');
    if (parts.length !== 5 || parts[0] !== 'enc') {
      throw new Error('Invalid encrypted data format');
    }

    return {
      version: parseInt(parts[1], 10),
      iv: parts[2],
      encrypted: parts[3],
      tag: parts[4],
    };
  }

  /**
   * Encrypt JSON metadata
   */
  async encryptJSON(
    value: Record<string, string | number | boolean | null> | string | null,
    fieldName: string
  ): Promise<string | null> {
    if (!value) return null;

    const jsonString = typeof value === 'string' ? value : JSON.stringify(value);
    return this.encrypt(jsonString, fieldName);
  }

  /**
   * Decrypt JSON metadata
   */
  async decryptJSON(
    value: string | null,
    fieldName: string
  ): Promise<string | Record<string, unknown> | null> {
    if (!value) return null;

    const decrypted = await this.decrypt(value, fieldName);
    if (!decrypted) return null;

    try {
      const parsed = JSON.parse(decrypted);
      // Validate parsed result is a valid object or primitive
      if (typeof parsed !== 'object' || parsed === null) {
        // Return primitives as-is (string, number, boolean)
        if (
          typeof parsed === 'string' ||
          typeof parsed === 'number' ||
          typeof parsed === 'boolean'
        ) {
          return decrypted; // Return original string for primitive types
        }
        throw new Error('Invalid decrypted data format: expected object or valid primitive');
      }
      return parsed;
    } catch (error) {
      // If parsing fails, return the decrypted string as-is
      // But log the error for debugging
      if (error instanceof SyntaxError) {
        return decrypted;
      }
      // Re-throw validation errors
      throw error;
    }
  }

  /**
   * Clear the key cache (useful for testing or key rotation)
   */
  clearCache(): void {
    this.keyCache.clear();
  }
}

// Singleton state management with proper mutex protection
class EncryptionServiceSingleton {
  private static instance: EncryptionService | null = null;
  private static cachedConfig: EncryptionConfig | null = null;
  private static initializationPromise: Promise<EncryptionService> | null = null;
  private static initializationLock = false;
  private static waitingResolvers: Array<(instance: EncryptionService) => void> = [];

  /**
   * Get current encryption config from environment
   */
  private static getCurrentConfig(): EncryptionConfig {
    return {
      enabled: process.env.ENCRYPTION_ENABLED === 'true',
      masterKey: process.env.ENCRYPTION_MASTER_KEY || '',
      algorithm: process.env.ENCRYPTION_ALGORITHM || 'aes-256-gcm',
    };
  }

  /**
   * Check if config has changed
   */
  private static hasConfigChanged(newConfig: EncryptionConfig): boolean {
    if (!this.cachedConfig) return true;
    return (
      this.cachedConfig.enabled !== newConfig.enabled ||
      this.cachedConfig.masterKey !== newConfig.masterKey ||
      this.cachedConfig.algorithm !== newConfig.algorithm
    );
  }

  /**
   * Get or create the encryption service instance
   * Thread-safe singleton with proper mutex pattern for JavaScript async
   */
  static getInstance(): EncryptionService {
    const currentConfig = this.getCurrentConfig();

    // Fast path: return existing instance if config hasn't changed
    if (this.instance && !this.hasConfigChanged(currentConfig)) {
      return this.instance;
    }

    // If initialization is in progress, wait for it or return existing instance
    if (this.initializationLock) {
      // If we have an existing instance (config change in progress), return it
      if (this.instance) {
        return this.instance;
      }
      // Create instance synchronously as fallback - this ensures we always return something
      // This handles the race condition where isInitializing is true but instance is null
      const fallbackInstance = new EncryptionService(currentConfig);
      return fallbackInstance;
    }

    // Acquire lock
    this.initializationLock = true;
    try {
      // Double-check after acquiring lock
      if (this.instance && !this.hasConfigChanged(currentConfig)) {
        return this.instance;
      }

      this.instance = new EncryptionService(currentConfig);
      this.cachedConfig = { ...currentConfig }; // Clone config to prevent mutations

      // Log encryption status using proper logger
      const logger = getLogger();
      const status = currentConfig.enabled ? 'ENABLED' : 'DISABLED';
      const keyStatus = currentConfig.masterKey ? '(key configured)' : '(no key)';
      logger.debug(`Encryption service initialized: ${status} ${keyStatus}`);

      // Notify any waiting callers
      for (const resolver of this.waitingResolvers) {
        resolver(this.instance);
      }
      this.waitingResolvers = [];

      return this.instance;
    } finally {
      this.initializationLock = false;
    }
  }

  /**
   * Initialize encryption service with custom config (useful for testing)
   * Replaces the singleton instance atomically
   */
  static initializeWithConfig(config: EncryptionConfig): EncryptionService {
    // Wait if another initialization is in progress
    while (this.initializationLock) {
      // Spin-wait is safe here as initialization is synchronous and fast
    }
    this.initializationLock = true;
    try {
      this.instance = new EncryptionService(config);
      this.cachedConfig = { ...config }; // Clone config to prevent mutations
      return this.instance;
    } finally {
      this.initializationLock = false;
    }
  }

  /**
   * Reset the singleton (useful for testing)
   */
  static reset(): void {
    this.instance = null;
    this.cachedConfig = null;
    this.initializationLock = false;
    this.initializationPromise = null;
    this.waitingResolvers = [];
  }
}

/**
 * Get or create the encryption service instance
 * Automatically reinitializes if environment variables change
 */
export function getEncryptionService(): EncryptionService {
  return EncryptionServiceSingleton.getInstance();
}

/**
 * Initialize encryption service with custom config (useful for testing)
 */
export function initializeEncryptionService(config: EncryptionConfig): EncryptionService {
  return EncryptionServiceSingleton.initializeWithConfig(config);
}

/**
 * Reset the encryption service singleton (useful for testing)
 */
export function resetEncryptionService(): void {
  EncryptionServiceSingleton.reset();
}
