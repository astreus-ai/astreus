import { LLMProvider } from '../llm/types';
import { MetadataObject } from '../types';

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  metadata?: MetadataObject;
  tokens?: number;
}

export interface CompressionResult {
  success: boolean;
  compressedMessages: ContextMessage[];
  tokensReduced: number;
  compressionRatio: number;
  strategy?: string; // Compression strategy used
  error?: string;
}

export interface ContextCompressorOptions {
  maxContextLength?: number;
  compressionRatio?: number;
  preserveLastN?: number;
  model?: string;
  provider?: LLMProvider;
  compressionStrategy?: 'summarize' | 'selective' | 'hybrid';
  enableSemanticCompression?: boolean;
  preserveImportantContext?: boolean;
}

export interface ContextAnalysis {
  totalTokens: number;
  messageCount: number;
  averageTokensPerMessage: number;
  contextUtilization: number;
  compressionNeeded: boolean;
  suggestedCompressionRatio?: number;
}

export interface ContextWindow {
  messages: ContextMessage[];
  totalTokens: number;
  maxTokens: number;
  utilizationPercentage: number;
}

export interface ContextManager {
  addMessage(message: ContextMessage): void;
  getMessages(): ContextMessage[];
  getContextWindow(): ContextWindow;
  analyzeContext(): ContextAnalysis;
  compressContext(): Promise<CompressionResult>;
  clearContext(): void;
  shouldCompress(): boolean;
  exportContext(): string;
  importContext(data: string): void;
  updateModel(model: string): void;
  loadFromMemory(
    memoryModule: {
      listMemories: (options: {
        limit: number;
        orderBy: string;
        orderDirection: string;
      }) => Promise<
        Array<{
          id: number;
          content: string;
          created_at: string;
          metadata?: MetadataObject;
        }>
      >;
    },
    limit?: number
  ): Promise<void>;
  saveToMemory(memoryModule: {
    addMemory: (
      content: string,
      metadata?: MetadataObject
    ) => Promise<{ id: number; content: string }>;
  }): Promise<void>;
  // New storage methods
  initializeForAgent(agentId: number): Promise<void>;
  saveToStorage(): Promise<void>;
}

export interface SemanticChunk {
  content: string;
  importance: number;
  topic?: string;
  entities?: string[];
  timestamp?: Date;
}

export interface ContextSummary {
  mainTopics: string[];
  keyEntities: string[];
  conversationFlow: string;
  importantFacts: string[];
  actionItems?: string[];
}

export interface CompressionStrategy {
  name: string;
  compress(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]>;
  estimateCompression(messages: ContextMessage[]): number;
}
