import { MetadataObject } from '../types';
import { Plugin, PluginConfig } from '../plugin/types';

export type ScheduleType = 'once' | 'recurring';
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export interface RecurrenceConfig {
  pattern: RecurrencePattern;
  interval?: number; // Every N days/weeks/months/years
  endDate?: Date; // End date for recurring schedules
  maxExecutions?: number; // Maximum number of executions
  daysOfWeek?: number[]; // For weekly: 0=Sunday, 1=Monday, etc.
  dayOfMonth?: number; // For monthly: day of month (1-31)
  monthOfYear?: number; // For yearly: month of year (1-12)
  customCron?: string; // For custom: cron expression
}

export interface Schedule {
  type: ScheduleType;
  executeAt: Date; // When to first execute
  recurrence?: RecurrenceConfig;
  timezone?: string; // Timezone for execution (e.g., 'America/New_York')
  metadata?: MetadataObject;
}

export interface ScheduledItem {
  id: string;
  type: 'task' | 'graph' | 'graph_node';
  schedule: Schedule;
  targetId: string | number; // Task ID, Graph ID, or Node ID
  agentId: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  executionCount: number;
  lastExecutedAt?: Date;
  nextExecutionAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata?: MetadataObject;
}

export interface ScheduleOptions {
  respectDependencies?: boolean; // For graph nodes
  maxRetries?: number;
  retryDelay?: number; // Milliseconds
  timeout?: number; // Execution timeout in milliseconds
}

export interface ScheduledTaskRequest {
  prompt: string;
  schedule: Schedule;
  useTools?: boolean;
  mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string; cwd?: string }>;
  plugins?: Array<{ plugin: Plugin; config?: PluginConfig }>;
  attachments?: Array<{ type: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'json' | 'file'; path: string; name?: string; language?: string }>;
  metadata?: MetadataObject;
  options?: ScheduleOptions;
}

export interface ScheduledGraphRequest {
  graphId: string;
  schedule: Schedule;
  options?: ScheduleOptions;
}

export interface ScheduledNodeRequest {
  graphId: string;
  nodeId: string;
  schedule: Schedule;
  options?: ScheduleOptions;
}

export interface SchedulerConfig {
  checkInterval?: number; // How often to check for scheduled items (ms)
  maxConcurrentJobs?: number; // Maximum concurrent scheduled executions
  enableRecurring?: boolean; // Whether to process recurring schedules
  timezone?: string; // Default timezone
}

export interface ScheduleCalculationResult {
  nextExecution: Date | null;
  shouldContinue: boolean;
  reason?: string; // Why scheduling should stop (if applicable)
}