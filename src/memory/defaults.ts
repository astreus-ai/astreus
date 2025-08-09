/**
 * Default configuration values for memory module
 */
export const DEFAULT_MEMORY_CONFIG = {
  searchLimit: 20,
  orderBy: 'createdAt',
  order: 'asc',
  defaultEmbeddingModel: 'text-embedding-ada-002',
} as const;

/**
 * Get default value for a memory config property
 */
export function getMemoryDefaultValue<K extends keyof typeof DEFAULT_MEMORY_CONFIG>(
  key: K
): (typeof DEFAULT_MEMORY_CONFIG)[K] {
  return DEFAULT_MEMORY_CONFIG[key];
}
