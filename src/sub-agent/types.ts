/**
 * Types for the SubAgent system
 */
import { IAgent } from '../agent/types';
import { RunOptions } from '../agent/types';

/**
 * Options for running main agent with sub-agents
 */
export interface SubAgentRunOptions extends RunOptions {
  useSubAgents?: boolean;
  delegation?: 'auto' | 'manual' | 'sequential';
  taskAssignment?: Record<number, string>; // agentId -> task mapping
  coordination?: 'parallel' | 'sequential'; // How to coordinate sub-agent execution
}

/**
 * Sub-agent task assignment
 */
export interface SubAgentTask {
  agentId: string; // UUID
  task: string;
  priority?: number;
  dependencies?: string[]; // Other agent UUIDs this task depends on
}

/**
 * Sub-agent execution result
 */
export interface SubAgentResult {
  agentId: string; // UUID
  agentName: string;
  task: string;
  result: string;
  success: boolean;
  error?: string;
  executionTime: number;
}

/**
 * Delegation strategy interface
 */
export interface DelegationStrategy {
  name: 'auto' | 'manual' | 'sequential';
  delegate(
    prompt: string,
    subAgents: IAgent[],
    options?: SubAgentRunOptions,
    model?: string
  ): Promise<SubAgentTask[]>;
}

/**
 * Sub-agent coordination result
 */
export interface SubAgentCoordinationResult {
  success: boolean;
  results: SubAgentResult[];
  finalResult: string;
  totalExecutionTime: number;
  errors: string[];
}
