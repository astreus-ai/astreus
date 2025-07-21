export interface Memory {
  id?: number;
  agentId: number;
  content: string;
  embedding?: number[];
  metadata?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MemorySearchOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt' | 'relevance';
  order?: 'asc' | 'desc';
}