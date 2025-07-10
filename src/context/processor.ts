import { 
  ContextWindowManager, 
  ContextLayers, 
  TokenBudgetConfig, 
  PriorityWeights, 
  CompressionStrategy as _CompressionStrategy, 
  CompressionResult as _CompressionResult,
  MemoryEntry,
  RecentMessages as _RecentMessages,
  ConversationSummary as _ConversationSummary,
  LongTermMemory
} from "../types/memory";
import { logger } from "../utils";
import { DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS } from "./config";

/**
 * Adaptive Context Window Manager Implementation
 * Manages hierarchical memory layers with intelligent token budgeting
 */
export class AdaptiveContextManager implements ContextWindowManager {
  public maxTokens: number;
  public currentTokens: number;
  public layers: ContextLayers;
  
  private tokenBudget: TokenBudgetConfig;
  private priorityWeights: PriorityWeights;
  private sessionId: string;

  constructor(
    sessionId: string,
    maxTokens: number = 4000,
    tokenBudget: TokenBudgetConfig = DEFAULT_TOKEN_BUDGET,
    priorityWeights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS
  ) {
    this.sessionId = sessionId;
    this.maxTokens = maxTokens;
    this.currentTokens = 0;
    this.tokenBudget = tokenBudget;
    this.priorityWeights = priorityWeights;
    
    // Initialize empty layers
    this.layers = {
      immediate: {
        messages: [],
        tokenCount: 0,
        lastUpdated: new Date()
      },
      summarized: {
        summary: "",
        keyPoints: [],
        entities: {},
        tokenCount: 0,
        lastUpdated: new Date(),
        sourceMessageIds: []
      },
      persistent: {
        importantFacts: [],
        userPreferences: {},
        conversationHistory: [],
        tokenCount: 0,
        lastUpdated: new Date()
      }
    };
    
    logger.debug(`Context manager initialized for session ${sessionId} with ${maxTokens} tokens`);
  }

  /**
   * Allocate tokens to a specific layer
   */
  allocateTokens(layer: keyof ContextLayers, tokens: number): boolean {
    const layerBudget = this.tokenBudget[layer];
    const layerCurrent = this.layers[layer].tokenCount;
    
    if (layerCurrent + tokens <= layerBudget) {
      this.layers[layer].tokenCount += tokens;
      this.currentTokens += tokens;
      return true;
    }
    
    logger.warn(`Token allocation failed for layer ${layer}: ${layerCurrent + tokens} > ${layerBudget}`);
    return false;
  }

  /**
   * Get available tokens across all layers
   */
  getAvailableTokens(): number {
    return this.maxTokens - this.currentTokens;
  }

  /**
   * Optimize token distribution across layers
   */
  optimizeTokenDistribution(): void {
    logger.debug("Optimizing token distribution across layers");
    
    // Calculate total used tokens
    const totalUsed = Object.values(this.layers).reduce((sum, layer) => sum + layer.tokenCount, 0);
    
    if (totalUsed > this.maxTokens) {
      // Need to compress - start with least important layer
      this.compressContext('persistent');
      
      if (this.currentTokens > this.maxTokens) {
        this.compressContext('summarized');
      }
      
      if (this.currentTokens > this.maxTokens) {
        this.compressContext('immediate');
      }
    }
    
    // Recalculate current tokens
    this.currentTokens = Object.values(this.layers).reduce((sum, layer) => sum + layer.tokenCount, 0);
    
    logger.debug(`Token optimization complete: ${this.currentTokens}/${this.maxTokens} tokens used`);
  }

  /**
   * Prioritize content based on multiple factors
   */
  prioritizeContent(entries: MemoryEntry[]): MemoryEntry[] {
    const now = new Date();
    
    const entriesWithPriority = entries.map(entry => ({
      entry,
      priority: this.calculatePriority(entry, now)
    }));
    
    // Sort by priority (highest first)
    entriesWithPriority.sort((a, b) => b.priority - a.priority);
    
    return entriesWithPriority.map(item => item.entry);
  }

  /**
   * Calculate priority score for a memory entry
   */
  calculatePriority(entry: MemoryEntry, now: Date = new Date()): number {
    const weights = this.priorityWeights;
    
    // Recency score (0-1, higher for more recent)
    const ageMs = now.getTime() - entry.timestamp.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const recencyScore = Math.max(0, 1 - (ageHours / 24)); // Decay over 24 hours
    
    // Frequency score (placeholder - would need frequency tracking)
    const frequencyScore = 0.5;
    
    // Importance score based on content analysis
    const importanceScore = this.analyzeImportance(entry);
    
    // User interaction score based on role
    const userInteractionScore = entry.role === 'user' ? 1 : 0.5;
    
    // Sentiment score (placeholder - would need sentiment analysis)
    const sentimentScore = 0.5;
    
    return (
      weights.recency * recencyScore +
      weights.frequency * frequencyScore +
      weights.importance * importanceScore +
      weights.userInteraction * userInteractionScore +
      weights.sentiment * sentimentScore
    );
  }

  /**
   * Analyze importance of content (simplified)
   */
  private analyzeImportance(entry: MemoryEntry): number {
    const content = entry.content.toLowerCase();
    
    // High importance indicators
    const highImportanceKeywords = ['important', 'remember', 'preference', 'name', 'goal', 'objective'];
    const mediumImportanceKeywords = ['like', 'want', 'need', 'should', 'must'];
    
    let score = 0.3; // Base score
    
    // Check for high importance keywords
    for (const keyword of highImportanceKeywords) {
      if (content.includes(keyword)) {
        score += 0.2;
      }
    }
    
    // Check for medium importance keywords
    for (const keyword of mediumImportanceKeywords) {
      if (content.includes(keyword)) {
        score += 0.1;
      }
    }
    
    return Math.min(score, 1);
  }

  /**
   * Compress context in a specific layer
   */
  compressContext(layer: keyof ContextLayers): void {
    logger.debug(`Compressing context layer: ${layer}`);
    
    switch (layer) {
      case 'immediate':
        this.compressImmediateLayer();
        break;
      case 'summarized':
        this.compressSummarizedLayer();
        break;
      case 'persistent':
        this.compressPersistentLayer();
        break;
    }
    
    this.layers[layer].lastUpdated = new Date();
  }

  /**
   * Expand context in a specific layer (when tokens become available)
   */
  expandContext(layer: keyof ContextLayers): void {
    logger.debug(`Expanding context layer: ${layer}`);
    
    // Implementation would retrieve more detailed information
    // from the database when tokens become available
    
    this.layers[layer].lastUpdated = new Date();
  }

  /**
   * Compress immediate layer by removing oldest messages
   */
  private compressImmediateLayer(): void {
    const layer = this.layers.immediate;
    const targetTokens = this.tokenBudget.immediate;
    
    if (layer.tokenCount <= targetTokens) return;
    
    // Sort by priority and keep the most important messages
    const prioritizedMessages = this.prioritizeContent(layer.messages);
    
    let tokenCount = 0;
    const compressedMessages: MemoryEntry[] = [];
    
    for (const message of prioritizedMessages) {
      const messageTokens = this.estimateTokens(message.content);
      if (tokenCount + messageTokens <= targetTokens) {
        compressedMessages.push(message);
        tokenCount += messageTokens;
      }
    }
    
    layer.messages = compressedMessages;
    layer.tokenCount = tokenCount;
    
    logger.debug(`Immediate layer compressed: ${layer.messages.length} messages, ${tokenCount} tokens`);
  }

  /**
   * Compress summarized layer by condensing summaries
   */
  private compressSummarizedLayer(): void {
    const layer = this.layers.summarized;
    const targetTokens = this.tokenBudget.summarized;
    
    if (layer.tokenCount <= targetTokens) return;
    
    // Compress summary text
    const words = layer.summary.split(' ');
    const targetWords = Math.floor(targetTokens * 0.75); // Rough token-to-word ratio
    
    if (words.length > targetWords) {
      layer.summary = words.slice(0, targetWords).join(' ') + '...';
    }
    
    // Keep only the most important key points
    const maxKeyPoints = Math.floor(targetTokens * 0.1);
    if (layer.keyPoints.length > maxKeyPoints) {
      layer.keyPoints = layer.keyPoints.slice(0, maxKeyPoints);
    }
    
    layer.tokenCount = this.estimateTokens(layer.summary + layer.keyPoints.join(' '));
    
    logger.debug(`Summarized layer compressed: ${layer.tokenCount} tokens`);
  }

  /**
   * Compress persistent layer by keeping only the most important facts
   */
  private compressPersistentLayer(): void {
    const layer = this.layers.persistent;
    const targetTokens = this.tokenBudget.persistent;
    
    if (layer.tokenCount <= targetTokens) return;
    
    // Keep the most important facts
    const maxFacts = Math.floor(targetTokens * 0.3);
    if (layer.importantFacts.length > maxFacts) {
      layer.importantFacts = layer.importantFacts.slice(0, maxFacts);
    }
    
    // Keep essential user preferences
    const maxPreferences = Math.floor(targetTokens * 0.2);
    const preferenceKeys = Object.keys(layer.userPreferences);
    if (preferenceKeys.length > maxPreferences) {
      const keepKeys = preferenceKeys.slice(0, maxPreferences);
      const newPreferences: Record<string, any> = {};
      keepKeys.forEach(key => {
        newPreferences[key] = layer.userPreferences[key];
      });
      layer.userPreferences = newPreferences;
    }
    
    layer.tokenCount = this.estimateLayerTokens(layer);
    
    logger.debug(`Persistent layer compressed: ${layer.tokenCount} tokens`);
  }

  /**
   * Add a new message to the immediate layer
   */
  addToImmediate(entry: MemoryEntry): void {
    const tokens = this.estimateTokens(entry.content);
    
    if (this.allocateTokens('immediate', tokens)) {
      this.layers.immediate.messages.push(entry);
      this.layers.immediate.lastUpdated = new Date();
    } else {
      // Need to compress first
      this.compressContext('immediate');
      
      // Try again after compression
      if (this.allocateTokens('immediate', tokens)) {
        this.layers.immediate.messages.push(entry);
        this.layers.immediate.lastUpdated = new Date();
      }
    }
  }

  /**
   * Update summarized layer with new information
   */
  updateSummarized(summary: string, keyPoints: string[], entities: Record<string, any>, sourceIds: string[]): void {
    const layer = this.layers.summarized;
    
    layer.summary = summary;
    layer.keyPoints = keyPoints;
    layer.entities = entities;
    layer.sourceMessageIds = sourceIds;
    layer.tokenCount = this.estimateTokens(summary + keyPoints.join(' '));
    layer.lastUpdated = new Date();
    
    logger.debug(`Summarized layer updated: ${layer.tokenCount} tokens`);
  }

  /**
   * Update persistent layer with long-term information
   */
  updatePersistent(facts: string[], preferences: Record<string, any>, history: string[]): void {
    const layer = this.layers.persistent;
    
    layer.importantFacts = facts;
    layer.userPreferences = preferences;
    layer.conversationHistory = history;
    layer.tokenCount = this.estimateLayerTokens(layer);
    layer.lastUpdated = new Date();
    
    logger.debug(`Persistent layer updated: ${layer.tokenCount} tokens`);
  }

  /**
   * Estimate token count for text (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate token count for persistent layer
   */
  private estimateLayerTokens(layer: LongTermMemory): number {
    const factsText = layer.importantFacts.join(' ');
    const preferencesText = JSON.stringify(layer.userPreferences);
    const historyText = layer.conversationHistory.join(' ');
    
    return this.estimateTokens(factsText + preferencesText + historyText);
  }

  /**
   * Get current context as a formatted string
   */
  getFormattedContext(): string {
    const parts: string[] = [];
    
    // Add immediate messages
    if (this.layers.immediate.messages.length > 0) {
      parts.push("Recent Messages:");
      this.layers.immediate.messages.forEach(msg => {
        parts.push(`${msg.role}: ${msg.content}`);
      });
    }
    
    // Add summarized content
    if (this.layers.summarized.summary) {
      parts.push("\nConversation Summary:");
      parts.push(this.layers.summarized.summary);
      
      if (this.layers.summarized.keyPoints.length > 0) {
        parts.push("\nKey Points:");
        this.layers.summarized.keyPoints.forEach(point => {
          parts.push(`- ${point}`);
        });
      }
    }
    
    // Add persistent information
    if (this.layers.persistent.importantFacts.length > 0) {
      parts.push("\nImportant Facts:");
      this.layers.persistent.importantFacts.forEach(fact => {
        parts.push(`- ${fact}`);
      });
    }
    
    if (Object.keys(this.layers.persistent.userPreferences).length > 0) {
      parts.push("\nUser Preferences:");
      Object.entries(this.layers.persistent.userPreferences).forEach(([key, value]) => {
        parts.push(`- ${key}: ${value}`);
      });
    }
    
    return parts.join('\n');
  }
}