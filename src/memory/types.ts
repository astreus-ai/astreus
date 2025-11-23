import { MetadataObject } from '../types';

export interface Memory {
  id: string; // UUID
  agentId: string; // UUID
  graphId?: string; // UUID - Graph this memory belongs to
  taskId?: string; // UUID - Task that created this memory
  sessionId?: string; // Conversation session ID
  content: string;
  embedding?: number[];
  metadata?: MetadataObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchOptions {
  limit?: number;
  offset?: number;
  graphId?: string; // UUID - Filter by graph ID
  taskId?: string; // UUID - Filter by task ID
  sessionId?: string; // Filter by session ID
  orderBy?: 'createdAt' | 'updatedAt' | 'relevance';
  order?: 'asc' | 'desc';
  startDate?: Date;
  endDate?: Date;
  // Vector similarity search options
  similarityThreshold?: number;
  useEmbedding?: boolean;
}

// Export Memory as MemoryType for backward compatibility
export type MemoryType = Memory;
