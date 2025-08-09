/**
 * Default configuration values for task module
 */
export const DEFAULT_TASK_CONFIG = {
  searchLimit: 100,
  searchOffset: 0,
  searchOrderBy: 'createdAt',
  searchOrder: 'desc',
  defaultMimeType: 'image/jpeg',
  logMode: 'default',
  logStatus: 'all',
} as const;

/**
 * Get default value for a task config property
 */
export function getTaskDefaultValue<K extends keyof typeof DEFAULT_TASK_CONFIG>(
  key: K
): (typeof DEFAULT_TASK_CONFIG)[K] {
  return DEFAULT_TASK_CONFIG[key];
}
