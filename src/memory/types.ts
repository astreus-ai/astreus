import { MetadataObject } from '../types';

export interface Memory {
  id: number;
  agentId: number;
  content: string;
  embedding?: number[];
  metadata?: MetadataObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchOptions {
  limit?: number;
  offset?: number;
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
