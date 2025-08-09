/**
 * Default configuration values for vision module
 */
export const DEFAULT_VISION_CONFIG = {
  defaultModel: 'gpt-4o-mini',
  fallbackModel: 'llava',
  defaultDetail: 'auto',
  defaultMaxTokens: 4096,
  defaultProvider: 'ollama',
  ollamaBaseURL: 'http://localhost:11434',
} as const;

/**
 * Get default value for a vision config property
 */
export function getVisionDefaultValue<K extends keyof typeof DEFAULT_VISION_CONFIG>(
  key: K
): (typeof DEFAULT_VISION_CONFIG)[K] {
  return DEFAULT_VISION_CONFIG[key];
}
