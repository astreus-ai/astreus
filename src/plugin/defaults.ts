/**
 * Default configuration values for plugin module
 */
export const DEFAULT_PLUGIN_CONFIG = {
  defaultVersion: 'unknown',
  defaultDescription: 'none',
  missingName: '[missing]',
  defaultTimeout: 30000, // 30 seconds
} as const;

/**
 * Get default value for a plugin config property
 */
export function getPluginDefaultValue<K extends keyof typeof DEFAULT_PLUGIN_CONFIG>(
  key: K
): (typeof DEFAULT_PLUGIN_CONFIG)[K] {
  return DEFAULT_PLUGIN_CONFIG[key];
}
