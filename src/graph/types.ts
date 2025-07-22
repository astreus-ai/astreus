import { Agent } from '../agent';

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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  priority: number;
  dependencies: string[]; // Node IDs that must complete first
  
  // Results
  result?: any;
  error?: string;
  
  // Metadata
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  condition?: string; // Optional condition for conditional execution
  metadata?: Record<string, any>;
}

export interface GraphConfig {
  id?: string;
  name: string;
  description?: string;
  defaultAgentId?: number; // Default agent for task nodes
  maxConcurrency?: number; // Max parallel execution
  timeout?: number; // Execution timeout in ms
  retryAttempts?: number;
  metadata?: Record<string, any>;
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
  metadata?: Record<string, any>;
}

export interface GraphExecutionResult {
  graph: Graph;
  success: boolean;
  completedNodes: number;
  failedNodes: number;
  duration: number;
  results: Record<string, any>; // Node ID -> result mapping
  errors: Record<string, string>; // Node ID -> error mapping
}

export interface AddNodeOptions {
  dependencies?: string[];
  priority?: number;
  metadata?: Record<string, any>;
}

export interface AddAgentNodeOptions extends AddNodeOptions {
  agentId: number;
}

export interface AddTaskNodeOptions extends AddNodeOptions {
  prompt: string;
  model?: string;
  agentId?: number; // Override default agent
  stream?: boolean; // Enable streaming for this task
}