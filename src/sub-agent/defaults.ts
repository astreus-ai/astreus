/**
 * Default configuration values for sub-agent module
 */
export const DEFAULT_SUBAGENT_CONFIG = {
  fallbackModel: 'gpt-4o-mini',
  defaultDelegation: 'auto',
  defaultCoordination: 'parallel',
  defaultTimeout: 5 * 60 * 1000, // 5 minutes - single source of truth for timeout
} as const;

/**
 * Sub-agent timeout configuration
 * Splitting total timeout between delegation and execution phases
 *
 * Problem solved: When node timeout is 1 minute and we split 40/60,
 * delegation gets only 24 seconds which is often too short.
 *
 * Solution: Use minimum values to ensure each phase has adequate time.
 */
export const SUB_AGENT_TIMEOUT_CONFIG = {
  /** Total timeout for sub-agent operations (5 minutes) */
  total: DEFAULT_SUBAGENT_CONFIG.defaultTimeout,
  /** Percentage of total timeout allocated to delegation phase */
  delegationRatio: 0.4,
  /** Percentage of total timeout allocated to execution phase */
  executionRatio: 0.6,
  /** Minimum timeout for delegation phase (30 seconds) */
  minDelegationTimeout: 30 * 1000,
  /** Minimum timeout for execution phase (30 seconds) */
  minExecutionTimeout: 30 * 1000,
} as const;

/**
 * Calculate timeout values with minimum guarantees
 * @param totalTimeout - Total available timeout in milliseconds
 * @returns Object with delegateTimeout and executeTimeout
 */
export function calculateSubAgentTimeouts(totalTimeout: number): {
  delegateTimeout: number;
  executeTimeout: number;
} {
  const calculatedDelegation = Math.floor(totalTimeout * SUB_AGENT_TIMEOUT_CONFIG.delegationRatio);
  const calculatedExecution = Math.floor(totalTimeout * SUB_AGENT_TIMEOUT_CONFIG.executionRatio);

  // Apply minimum values
  const delegateTimeout = Math.max(
    calculatedDelegation,
    SUB_AGENT_TIMEOUT_CONFIG.minDelegationTimeout
  );
  const executeTimeout = Math.max(
    calculatedExecution,
    SUB_AGENT_TIMEOUT_CONFIG.minExecutionTimeout
  );

  return { delegateTimeout, executeTimeout };
}

/**
 * Get default value for a sub-agent config property
 */
export function getSubAgentDefaultValue<K extends keyof typeof DEFAULT_SUBAGENT_CONFIG>(
  key: K
): (typeof DEFAULT_SUBAGENT_CONFIG)[K] {
  return DEFAULT_SUBAGENT_CONFIG[key];
}
