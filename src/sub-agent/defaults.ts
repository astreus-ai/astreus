/**
 * Default configuration values for sub-agent module
 */
export const DEFAULT_SUBAGENT_CONFIG = {
  fallbackModel: 'gpt-4o-mini',
  defaultDelegation: 'auto',
  defaultCoordination: 'parallel',
  defaultTimeout: 30000, // 30 seconds
} as const;

/**
 * Get default value for a sub-agent config property
 */
export function getSubAgentDefaultValue<K extends keyof typeof DEFAULT_SUBAGENT_CONFIG>(
  key: K
): (typeof DEFAULT_SUBAGENT_CONFIG)[K] {
  return DEFAULT_SUBAGENT_CONFIG[key];
}
