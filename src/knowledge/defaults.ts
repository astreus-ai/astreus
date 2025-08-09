/**
 * Default configuration values for knowledge module
 */
export const DEFAULT_KNOWLEDGE_CONFIG = {
  chunkSize: 1000,
  chunkOverlap: 200,
  searchLimit: 5,
  searchThreshold: 0.7,
  defaultTitle: 'Untitled Document',
} as const;

/**
 * Get default value for a knowledge config property
 */
export function getKnowledgeDefaultValue<K extends keyof typeof DEFAULT_KNOWLEDGE_CONFIG>(
  key: K
): (typeof DEFAULT_KNOWLEDGE_CONFIG)[K] {
  return DEFAULT_KNOWLEDGE_CONFIG[key];
}
