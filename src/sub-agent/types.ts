/**
 * Types for the SubAgent system
 */
import { IAgent } from '../agent/types';
import { RunOptions } from '../agent/types';

/**
 * Context isolation strategy for sub-agents
 * - 'isolated': SubAgent executes in its own context, changes don't affect parent Agent
 * - 'shared': SubAgent shares context with parent Agent (changes propagate to parent)
 * - 'merge': SubAgent context changes are merged back to parent after execution
 */
export type ContextIsolationStrategy = 'isolated' | 'shared' | 'merge';

/**
 * Options for running main agent with sub-agents
 */
export interface SubAgentRunOptions extends RunOptions {
  useSubAgents?: boolean;
  delegation?: 'auto' | 'manual' | 'sequential';
  taskAssignment?: Record<string, string>; // agentId -> task mapping
  coordination?: 'parallel' | 'sequential'; // How to coordinate sub-agent execution
  contextIsolation?: ContextIsolationStrategy; // How to handle context between agents (default: 'isolated')
}

/**
 * Sub-agent task assignment
 */
export interface SubAgentTask {
  taskId?: string; // Unique task identifier for dependency resolution
  agentId: string; // UUID of the agent to execute the task
  task: string;
  priority?: number;
  dependencies?: string[]; // Task IDs or agent UUIDs this task depends on
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
