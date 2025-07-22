export interface ContextConfig {
  layerWeights?: {
    immediate: number;    // Recent interactions
    summarized: number;   // Compressed summaries  
    persistent: number;   // Important long-term facts
  };
}

export interface ContextLayer {
  content: string;
  tokenCount: number;
  priority: number;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface ContextLayers {
  immediate: ContextLayer[];    // Last N messages
  summarized: ContextLayer[];   // Compressed summaries
  persistent: ContextLayer[];   // Important facts/preferences
}

export interface ContextWindow {
  layers: ContextLayers;
  totalTokens: number;
  maxTokens: number;
  config: ContextConfig;
}

export interface CompressionResult {
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  keyPoints: string[];
}

export interface ContextMemoryEntry {
  id?: number;
  agentId: number;
  layer: 'immediate' | 'summarized' | 'persistent';
  content: string;
  tokenCount: number;
  priority: number;
  metadata?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}