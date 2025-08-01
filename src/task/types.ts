import { MCPServerDefinition } from '../mcp/types';
import { Plugin, PluginConfig } from '../plugin/types';
import { MetadataObject } from '../types';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  id?: number;
  agentId: number;
  prompt: string;
  response?: string;
  status: TaskStatus;
  metadata?: MetadataObject;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
}

export interface TaskSearchOptions {
  limit?: number;
  offset?: number;
  status?: TaskStatus;
  orderBy?: 'createdAt' | 'updatedAt' | 'completedAt';
  order?: 'asc' | 'desc';
}

export interface TaskRequest {
  prompt: string;
  useTools?: boolean;
  mcpServers?: MCPServerDefinition[]; // Task-level MCP servers
  plugins?: Array<{ plugin: Plugin; config?: PluginConfig }>; // Task-level plugins
  attachments?: Array<{
    type: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'json' | 'file';
    path: string;
    name?: string;
    language?: string; // For code files
  }>;
  metadata?: MetadataObject;
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