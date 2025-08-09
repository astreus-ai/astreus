/**
 * Default configuration values for database module
 */
export const DEFAULT_DATABASE_CONFIG = {
  defaultTemperature: 0.7,
  defaultMaxTokens: 2000,
  defaultModel: 'gpt-4o-mini',
  defaultBooleanValue: false,
} as const;

/**
 * Get default value for a database config property
 */
export function getDatabaseDefaultValue<K extends keyof typeof DEFAULT_DATABASE_CONFIG>(
  key: K
): (typeof DEFAULT_DATABASE_CONFIG)[K] {
  return DEFAULT_DATABASE_CONFIG[key];
}
