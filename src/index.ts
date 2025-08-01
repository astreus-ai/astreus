// Main exports  
export { Agent } from './agent';
export type { AgentConfig } from './agent/types';

// Common types
export type { MetadataObject } from './types';
export { Memory } from './memory';
export { Task } from './task';

// Database exports
export { getDatabase } from './database';
export type { DatabaseConfig } from './database/types';

// Embedding exports (legacy compatibility)
export { EmbeddingService } from './knowledge';
export type { EmbeddingConfig } from './knowledge';

// Memory types
export type { Memory as MemoryType, MemorySearchOptions } from './memory/types';

// Task types
export type { Task as TaskType, TaskRequest, TaskResponse, TaskSearchOptions, TaskStatus } from './task/types';

// LLM exports
export { getLLM } from './llm';
export type { LLMProvider, LLMRequestOptions, LLMResponse } from './llm/types';

// Logger exports
export { getLogger, initializeLogger } from './logger';
export type { Logger, LoggerConfig, LogLevel } from './logger/types';

// Graph exports
export { Graph } from './graph';
export type { 
  Graph as GraphType, 
  GraphNode, 
  GraphEdge, 
  GraphConfig, 
  GraphExecutionResult,
  AddAgentNodeOptions,
  AddTaskNodeOptions 
} from './graph/types';


// Plugin exports
export { getPlugin, Plugin } from './plugin';
export type { 
  Plugin as PluginDefinition, 
  ToolDefinition, 
  ToolCall, 
  ToolResult, 
  ToolContext,
  ToolCallResult,
  PluginConfig 
} from './plugin/types';

// MCP exports
export { getMCP } from './mcp';
export type {
  MCPServerConfig,
  MCPTool,
  MCPToolCall,
  MCPToolResult,
  MCPServerDefinition
} from './mcp/types';

// Knowledge exports
export { Knowledge, knowledgeSearchTool, knowledgeTools } from './knowledge';
export type { KnowledgeConfig } from './knowledge';

// Scheduler exports
export { Scheduler } from './scheduler';
export type { 
  Schedule, 
  ScheduledItem, 
  SchedulerConfig, 
  ScheduledTaskRequest, 
  ScheduledGraphRequest, 
  ScheduledNodeRequest,
  ScheduleOptions 
} from './scheduler/types';

// Default export
export { default } from './agent';