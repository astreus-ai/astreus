/**
 * Default configuration values for agents
 */
export const DEFAULT_AGENT_CONFIG = {
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2000,
  useTools: true,
  memory: false,
  knowledge: false,
  vision: false,
  contextCompression: false,
  debug: false,
} as const;

/**
 * Get default value for an agent config property
 */
export function getDefaultValue<K extends keyof typeof DEFAULT_AGENT_CONFIG>(
  key: K
): (typeof DEFAULT_AGENT_CONFIG)[K] {
  return DEFAULT_AGENT_CONFIG[key];
}
