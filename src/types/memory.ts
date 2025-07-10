import { DatabaseInstance } from "./database";

// Memory entry interface representing a single conversation message or context
export interface MemoryEntry {
  /** Unique identifier for the memory entry */
  id: string;
  /** ID of the agent that created this memory entry */
  agentId: string;
  /** Session ID for grouping related conversation entries */
  sessionId: string;
  /** Optional user ID for user-specific memory filtering */
  userId?: string;
  /** Role of the message sender */
  role: "system" | "user" | "assistant" | "task_context" | "task_event" | "task_tool" | "task_result";
  /** Content of the message or memory entry */
  content: string;
  /** Timestamp when the memory entry was created */
  timestamp: Date;
  /** Optional metadata for additional context */
  metadata?: Record<string, unknown>;
  /** Optional embedding vector for semantic search */
  embedding?: number[];
}

// Similarity search result with score
export interface SimilaritySearchResult extends MemoryEntry {
  /** Similarity score (0-1) where 1 is perfect match */
  similarity: number;
}

// Enhanced memory configuration interface
export interface MemoryConfig {
  /** Required: Database instance for storing memories */
  database: DatabaseInstance;
  /** Optional: Custom table name for storing memories, defaults to "memories" */
  tableName?: string;
  /** Optional: Maximum number of entries to retrieve at once, defaults to 100 */
  maxEntries?: number;
  /** Optional: Whether to enable embedding functionality for semantic search, defaults to false */
  enableEmbeddings?: boolean;
  
  /** Optional: Enable adaptive context window management */
  enableAdaptiveContext?: boolean;
  /** Optional: Token budget configuration */
  tokenBudget?: TokenBudgetConfig;
  /** Optional: Priority weights for content retention */
  priorityWeights?: PriorityWeights;
  /** Optional: Default compression strategy */
  defaultCompressionStrategy?: CompressionStrategy;
}

// Enhanced memory instance interface with hierarchical support
export interface MemoryInstance {
  /** Memory configuration */
  config: MemoryConfig;
  
  /** Context window manager for adaptive memory */
  contextManager?: ContextWindowManager;
  
  /**
   * Add a new memory entry
   * @param entry Memory entry to add (without id and timestamp)
   * @returns Promise resolving to the ID of the new entry
   */
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string>;
  
  /**
   * Get memory entries by session ID
   * @param sessionId The session ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  getBySession(sessionId: string, limit?: number): Promise<MemoryEntry[]>;
  
  /**
   * Get memory entries by agent ID
   * @param agentId The agent ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  getByAgent(agentId: string, limit?: number): Promise<MemoryEntry[]>;
  
  /**
   * Get memory entries by user ID (optional method)
   * @param userId The user ID to get entries for
   * @param limit Maximum number of entries to return
   * @returns Promise resolving to array of memory entries
   */
  getByUser?(userId: string, limit?: number): Promise<MemoryEntry[]>;
  
  /**
   * Get a memory entry by its ID
   * @param id The ID of the memory entry to retrieve
   * @returns Promise resolving to the memory entry or null if not found
   */
  getById(id: string): Promise<MemoryEntry | null>;
  
  /**
   * Delete a specific memory entry by ID
   * @param id The ID of the memory entry to delete
   * @returns Promise that resolves when deletion is complete
   */
  delete(id: string): Promise<void>;
  
  /**
   * Clear all entries for a session
   * @param sessionId The session ID to clear entries for
   * @returns Promise that resolves when clearing is complete
   */
  clear(sessionId: string): Promise<void>;
  
  /**
   * Generate a summary of the memory for a specific session
   * @param sessionId The session ID to summarize
   * @returns Promise resolving to text summary of the conversation
   */
  summarize(sessionId: string): Promise<string>;
  
  /**
   * Search memory entries by text content (optional method)
   * @param query Text to search for in memory content field
   * @param limit Maximum number of results to return
   * @returns Promise resolving to array of memory entries matching the query
   */
  searchByText?(query: string, limit?: number): Promise<MemoryEntry[]>;
  
  /**
   * Search memory entries by embedding similarity (optional method)
   * @param embedding The embedding vector to search for
   * @param limit Maximum number of results to return
   * @param threshold Minimum similarity threshold (0-1)
   * @returns Promise resolving to array of results with similarity scores
   */
  searchByEmbedding?(
    embedding: number[],
    limit?: number,
    threshold?: number
  ): Promise<SimilaritySearchResult[]>;
  
  /**
   * Add an entry with embedding in one step (optional method)
   * @param entry The memory entry without ID, timestamp, or embedding
   * @param embedding The embedding vector to add
   * @returns Promise resolving to the ID of the new entry
   */
  addWithEmbedding?(
    entry: Omit<MemoryEntry, "id" | "timestamp" | "embedding">,
    embedding: number[]
  ): Promise<string>;
  
  /**
   * List all sessions for a specific agent
   * @param agentId The agent ID to list sessions for
   * @param limit Maximum number of sessions to return
   * @returns Promise resolving to array of session summaries
   */
  listSessions(agentId: string, limit?: number): Promise<{
    sessionId: string;
    lastMessage?: string;
    messageCount: number;
    lastActivity: Date;
    metadata?: Record<string, unknown>;
  }[]>;
  
  /**
   * Get adaptive context for a session using hierarchical memory
   * @param sessionId The session ID to get context for
   * @param maxTokens Maximum tokens to use for context
   * @returns Promise resolving to context layers
   */
  getAdaptiveContext?(sessionId: string, maxTokens: number): Promise<ContextLayers>;
  
  /**
   * Update context layers based on new interaction
   * @param sessionId The session ID
   * @param newEntry The new memory entry
   * @returns Promise that resolves when context is updated
   */
  updateContextLayers?(sessionId: string, newEntry: MemoryEntry): Promise<void>;
  
  /**
   * Compress context layers to optimize token usage
   * @param sessionId The session ID
   * @param strategy The compression strategy to use
   * @returns Promise resolving to compression result
   */
  compressContext?(sessionId: string, strategy: CompressionStrategy): Promise<CompressionResult>;
  
  /**
   * Get formatted context for a session
   * @param sessionId The session ID
   * @param maxTokens Maximum tokens to use
   * @returns Promise resolving to formatted context string
   */
  getFormattedContext?(sessionId: string, maxTokens?: number): Promise<string>;
}

// Context layers for hierarchical memory system
export interface ContextLayers {
  immediate: RecentMessages;    // Last 5-10 messages
  summarized: ConversationSummary;  // Intelligent summarization
  persistent: LongTermMemory;   // Persistent knowledge store
}

// Recent messages context
export interface RecentMessages {
  messages: MemoryEntry[];
  tokenCount: number;
  lastUpdated: Date;
}

// Conversation summary context
export interface ConversationSummary {
  summary: string;
  keyPoints: string[];
  entities: Record<string, any>;
  tokenCount: number;
  lastUpdated: Date;
  sourceMessageIds: string[];
}

// Long-term memory context
export interface LongTermMemory {
  importantFacts: string[];
  userPreferences: Record<string, any>;
  conversationHistory: string[];
  tokenCount: number;
  lastUpdated: Date;
}

// Adaptive context window management
export interface ContextWindowManager {
  maxTokens: number;
  currentTokens: number;
  layers: ContextLayers;
  
  // Token budgeting
  allocateTokens(layer: keyof ContextLayers, tokens: number): boolean;
  getAvailableTokens(): number;
  optimizeTokenDistribution(): void | Promise<void>;
  
  // Priority-based retention (now supports async for LLM-based analysis)
  prioritizeContent(entries: MemoryEntry[]): MemoryEntry[] | Promise<MemoryEntry[]>;
  calculatePriority(entry: MemoryEntry, now?: Date): number | Promise<number>;
  
  // Context compression (now supports async for LLM-based compression)
  compressContext(layer: keyof ContextLayers): void | Promise<void>;
  expandContext(layer: keyof ContextLayers): void;
}

// Token budget configuration
export interface TokenBudgetConfig {
  total: number;
  immediate: number;    // 40% - recent messages
  summarized: number;   // 35% - summarized conversations
  persistent: number;   // 25% - persistent information
}

// Priority weights for content retention
export interface PriorityWeights {
  recency: number;      // Recent messages
  frequency: number;    // Frequently repeated topics
  importance: number;   // Important information (names, preferences, etc.)
  userInteraction: number; // User interaction level
  sentiment: number;    // Emotional intensity
}

// Context compression strategies
export enum CompressionStrategy {
  SUMMARIZE = 'summarize',
  KEYWORD_EXTRACT = 'keyword_extract',
  SEMANTIC_CLUSTER = 'semantic_cluster',
  TEMPORAL_COMPRESS = 'temporal_compress'
}

// Compression result
export interface CompressionResult {
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  strategy: CompressionStrategy;
  lossEstimate: number; // 0-1 scale
}

// Memory factory function type
export interface MemoryFactory {
  (config: MemoryConfig): Promise<MemoryInstance>;
}
