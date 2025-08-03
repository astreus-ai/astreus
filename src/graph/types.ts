import { Agent } from '../agent';
import { MetadataObject } from '../types';

/**
 * Primitive values that can be returned as node results
 */
export type GraphResultPrimitive = string | number | boolean | null | Date;

/**
 * Complex result data that can contain primitives, arrays, or nested objects
 */
export type GraphResultValue = 
  | GraphResultPrimitive
  | GraphResultPrimitive[]
  | { [key: string]: GraphResultValue };

export type GraphNodeType = 'agent' | 'task';
export type GraphExecutionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  description?: string;
  
  // Agent node properties
  agentId?: number;
  agent?: Agent;
  
  // Task node properties
  prompt?: string;
  model?: string;
  stream?: boolean;
  
  // Execution properties
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'scheduled';
  priority: number;
  dependencies: string[]; // Node IDs that must complete first
  
  // Scheduling properties
  schedule?: string; // Simple schedule string (e.g., 'daily@07:00')
  
  // Results
  result?: GraphResultValue;
  error?: string;
  
  // Metadata
  metadata?: MetadataObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  condition?: string; // Optional condition for conditional execution
  metadata?: MetadataObject;
}

export interface GraphConfig {
  id?: string;
  name: string;
  description?: string;
  defaultAgentId?: number; // Default agent for task nodes
  maxConcurrency?: number; // Max parallel execution
  timeout?: number; // Execution timeout in ms
  retryAttempts?: number;
  metadata?: MetadataObject;
}

export interface Graph {
  id?: string;
  config: GraphConfig;
  nodes: GraphNode[];
  edges: GraphEdge[];
  status: GraphExecutionStatus;
  
  // Execution tracking
  startedAt?: Date;
  completedAt?: Date;
  executionLog: GraphExecutionLogEntry[];
  
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphExecutionLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  nodeId?: string;
  metadata?: MetadataObject;
}

export interface GraphExecutionResult {
  graph: Graph;
  success: boolean;
  completedNodes: number;
  failedNodes: number;
  duration: number;
  results: Record<string, GraphResultValue>; // Node ID -> result mapping
  errors: Record<string, string>; // Node ID -> error mapping
}

export interface AddNodeOptions {
  dependencies?: string[];
  priority?: number;
  metadata?: MetadataObject;
}

export interface AddAgentNodeOptions extends AddNodeOptions {
  agentId: number;
}

export interface AddTaskNodeOptions extends AddNodeOptions {
  name?: string; // Optional name for the task
  prompt: string;
  model?: string;
  agentId?: number; // Override default agent
  stream?: boolean; // Enable streaming for this task
  schedule?: string; // Simple schedule string (e.g., 'daily@07:00', 'weekly@monday@09:00')
  dependsOn?: string[]; // Node names that must complete first (alternative to dependencies)
}


export interface GraphSchedulingOptions {
  respectSchedules?: boolean; // Whether to respect node schedules during execution
  waitForScheduled?: boolean; // Whether to wait for scheduled nodes or skip them
  schedulingCheckInterval?: number; // How often to check for scheduled nodes (ms)
}