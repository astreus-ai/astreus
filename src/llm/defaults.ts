/**
 * Default configuration values for LLM module
 */
export const DEFAULT_LLM_CONFIG = {
  defaultTemperature: 0.7,
  defaultMaxTokens: 2000,
  visionMaxTokens: 1000,
  visionTemperature: 0.1,
  embeddingMaxTokens: 1000,
  fallbackModel: 'gpt-4o-mini',
} as const;

/**
 * Get default value for a LLM config property
 */
export function getLLMDefaultValue<K extends keyof typeof DEFAULT_LLM_CONFIG>(
  key: K
): (typeof DEFAULT_LLM_CONFIG)[K] {
  return DEFAULT_LLM_CONFIG[key];
}
