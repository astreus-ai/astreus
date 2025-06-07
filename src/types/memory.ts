import { DatabaseInstance } from "./database";

// Memory entry for storing conversation
export interface MemoryEntry {
  id: string;
  agentId: string;
  sessionId: string;
  userId?: string; // Optional user ID
  role: "system" | "user" | "assistant" | "task_context" | "task_event" | "task_tool" | "task_result";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  embedding?: number[]; // Optional embedding vector
}

// Result with similarity score for semantic search
export interface SimilaritySearchResult extends MemoryEntry {
  similarity: number; // Similarity score (0-1)
}

// Memory configuration
export interface MemoryConfig {
  /** Required: Database instance for storing memories */
  database: DatabaseInstance;
  /** Optional: Table name for storing memories, defaults to "memories" */
  tableName?: string;
  /** Optional: Maximum number of entries to retrieve at once, defaults to 100 */
  maxEntries?: number;
  /** Optional: Whether to enable embedding functionality, defaults to false */
  enableEmbeddings?: boolean;
}

// Memory instance
export interface MemoryInstance {
  config: MemoryConfig;
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string>;
  getBySession(sessionId: string, limit?: number): Promise<MemoryEntry[]>;
  getByAgent(agentId: string, limit?: number): Promise<MemoryEntry[]>;
  getByUser?(userId: string, limit?: number): Promise<MemoryEntry[]>; // Optional: get memories by user
  /** Get a memory entry by its ID */
  getById(id: string): Promise<MemoryEntry | null>;
  /** Delete a specific memory entry by ID */
  delete(id: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
  summarize(sessionId: string): Promise<string>;
  searchByText?(query: string, limit?: number): Promise<MemoryEntry[]>; // Optional text search
  searchByEmbedding?(
    embedding: number[],
    limit?: number,
    threshold?: number // Minimum similarity threshold (0-1)
  ): Promise<SimilaritySearchResult[]>; // Return results with similarity scores
  /** List all sessions for a specific agent */
  listSessions(agentId: string, limit?: number): Promise<{
    sessionId: string;
    lastMessage?: string;
    messageCount: number;
    lastActivity: Date;
    metadata?: Record<string, unknown>;
  }[]>;
}

// Memory factory function type
export interface MemoryFactory {
  (config: MemoryConfig): Promise<MemoryInstance>;
}
