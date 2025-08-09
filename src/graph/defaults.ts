/**
 * Default configuration values for graph module
 */
export const DEFAULT_GRAPH_CONFIG = {
  defaultMaxConcurrency: 1,
  defaultTimeout: 300000, // 5 minutes
  defaultNodeTimeout: 60000, // 1 minute per node
  schedulingCheckInterval: 1000,
  defaultCoordination: 'sequential',
  defaultDelegation: 'auto',
  complexTaskThreshold: 100, // prompt length threshold for "complex" tasks
  optimizationThreshold: 200, // prompt length threshold for optimization
} as const;

/**
 * Get default value for a graph config property
 */
export function getGraphDefaultValue<K extends keyof typeof DEFAULT_GRAPH_CONFIG>(
  key: K
): (typeof DEFAULT_GRAPH_CONFIG)[K] {
  return DEFAULT_GRAPH_CONFIG[key];
}
