// Main exports  
export { Agent } from './agent';
export { AgentConfig } from './agent/types';
export { Memory } from './memory';
export { Task } from './task';

// Database exports
export { getDatabase, EmbeddingService } from './database';
export type { DatabaseConfig } from './database/types';
export type { EmbeddingConfig } from './database/embedding';

// Memory types
export type { Memory as MemoryType, MemorySearchOptions } from './memory/types';

// Task types
export type { Task as TaskType, TaskRequest, TaskResponse, TaskSearchOptions, TaskStatus } from './task/types';

// LLM exports
export { getLLM } from './llm';
export type { LLMProvider, LLMRequestOptions, LLMResponse } from './llm/types';

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

// Context exports
export { Context } from './context';
export type { ContextConfig, ContextLayer, ContextWindow } from './context/types';

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

// Knowledge exports
export { Knowledge, knowledgeSearchTool, knowledgeTools } from './knowledge';
export type { KnowledgeConfig } from './knowledge';

// Default export
export { default } from './agent';