import { MCPServerDefinition } from '../mcp/types';
import { Plugin, PluginConfig } from '../plugin/types';
import { MetadataObject } from '../types';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  id: string; // UUID
  agentId: string; // UUID
  graphId?: string; // UUID - Graph this task belongs to
  graphNodeId?: string; // UUID - Graph node that created this task
  prompt: string;
  response?: string;
  status: TaskStatus;
  metadata?: MetadataObject;
  executionContext?: Record<string, unknown>; // Additional execution metadata
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface TaskSearchOptions {
  limit?: number;
  offset?: number;
  status?: TaskStatus;
  graphId?: string; // UUID - Filter by graph ID
  orderBy?: 'createdAt' | 'updatedAt' | 'completedAt';
  order?: 'asc' | 'desc';
}

export interface TaskRequest {
  prompt: string;
  graphId?: string; // UUID - Graph this task belongs to
  graphNodeId?: string; // UUID - Graph node creating this task
  useTools?: boolean;
  mcpServers?: MCPServerDefinition[]; // Task-level MCP servers
  plugins?: Array<{ plugin: Plugin; config?: PluginConfig }>; // Task-level plugins
  attachments?: Array<{
    type: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'json' | 'file';
    path: string;
    name?: string;
    language?: string; // For code files
  }>;
  schedule?: string; // Simple schedule string (e.g., 'daily@07:00', 'weekly@monday@09:00')
  metadata?: MetadataObject;
  executionContext?: Record<string, unknown>; // Additional execution metadata

  // Sub-agent delegation options
  useSubAgents?: boolean; // Enable sub-agent delegation for this task
  subAgentDelegation?: 'auto' | 'manual' | 'sequential'; // Delegation strategy
  subAgentCoordination?: 'parallel' | 'sequential'; // How sub-agents coordinate
  taskAssignment?: Record<number, string>; // Manual task assignment (agentId -> task)
}

export interface TaskResponse {
  task: Task;
  response: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
