/**
 * Default configuration values for agents
 */
export const DEFAULT_AGENT_CONFIG = {
  model: process.env.ASTREUS_DEFAULT_MODEL || 'gpt-4o-mini',
  temperature: parseFloat(process.env.ASTREUS_TEMPERATURE || '0.7'),
  maxTokens: 2000,
  useTools: true,
  memory: false,
  knowledge: false,
  vision: false,
  autoContextCompression: false,
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
