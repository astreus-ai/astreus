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
  pageSize?: number; // Page size for paginated queries (prevents memory leaks)
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
