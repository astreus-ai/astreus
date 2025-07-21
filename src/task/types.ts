export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  id?: number;
  agentId: number;
  prompt: string;
  response?: string;
  status: TaskStatus;
  metadata?: Record<string, any>;
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
  metadata?: Record<string, any>;
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