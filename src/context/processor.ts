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
import { ProviderModel } from "../types/provider";
import { logger } from "../utils";
import { DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS } from "./config";
import { ContextCompressor } from "./compression";

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
  private provider?: ProviderModel;
  
  /**
   * Set the LLM provider for AI-powered context management
   */
  setProvider(provider: ProviderModel): void {
    this.provider = provider;
    // Also set provider for compression utilities
    ContextCompressor.setProvider(provider);
  }

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
  async optimizeTokenDistribution(): Promise<void> {
    logger.debug(`Optimizing token distribution across layers for session ${this.sessionId}`);
    
    // Calculate total used tokens
    const totalUsed = Object.values(this.layers).reduce((sum, layer) => sum + layer.tokenCount, 0);
    
    if (totalUsed > this.maxTokens) {
      // Need to compress - start with least important layer
      await this.compressContext('persistent');
      
      if (this.currentTokens > this.maxTokens) {
        await this.compressContext('summarized');
      }
      
      if (this.currentTokens > this.maxTokens) {
        await this.compressContext('immediate');
      }
    }
    
    // Recalculate current tokens
    this.currentTokens = Object.values(this.layers).reduce((sum, layer) => sum + layer.tokenCount, 0);
    
    logger.debug(`Token optimization complete for session ${this.sessionId}: ${this.currentTokens}/${this.maxTokens} tokens used`);
  }

  /**
   * Prioritize content based on multiple factors
   */
  async prioritizeContent(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    const now = new Date();
    
    const entriesWithPriority = await Promise.all(
      entries.map(async entry => ({
        entry,
        priority: await this.calculatePriority(entry, now)
      }))
    );
    
    // Sort by priority (highest first)
    entriesWithPriority.sort((a, b) => b.priority - a.priority);
    
    return entriesWithPriority.map(item => item.entry);
  }

  /**
   * Calculate priority score for a memory entry with enhanced LLM-based analysis
   */
  async calculatePriority(entry: MemoryEntry, now: Date = new Date()): Promise<number> {
    const weights = this.priorityWeights;
    
    // Recency score (0-1, higher for more recent)
    const ageMs = now.getTime() - entry.timestamp.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const recencyScore = Math.max(0, 1 - (ageHours / 24)); // Decay over 24 hours
    
    // Frequency score (placeholder - would need frequency tracking)
    const frequencyScore = 0.5;
    
    // Importance score based on content analysis (now async)
    const importanceScore = await this.analyzeImportance(entry);
    
    // User interaction score based on role
    const userInteractionScore = entry.role === 'user' ? 1 : 0.5;
    
    // Enhanced sentiment and context score
    const sentimentScore = await this.analyzeSentimentAndContext(entry);
    
    const finalScore = (
      weights.recency * recencyScore +
      weights.frequency * frequencyScore +
      weights.importance * importanceScore +
      weights.userInteraction * userInteractionScore +
      weights.sentiment * sentimentScore
    );
    
    logger.debug(`Priority calculated for session ${this.sessionId}: "${entry.content.substring(0, 50)}...": ${finalScore.toFixed(3)}`);
    return finalScore;
  }
  
  /**
   * Analyze sentiment and contextual importance using LLM
   */
  private async analyzeSentimentAndContext(entry: MemoryEntry): Promise<number> {
    if (!this.provider) {
      return 0.5; // Neutral fallback
    }
    
    try {
      const prompt = `Analyze the sentiment and contextual importance of this message in a conversation. Consider:
- Emotional tone (positive, negative, neutral)
- Urgency or immediacy
- Future reference value
- Relationship building aspects

Rate the overall contextual value on a scale of 0.0 to 1.0 where:
- 0.0-0.3: Low contextual value (negative sentiment, low future relevance)
- 0.4-0.6: Medium contextual value (neutral sentiment, some future relevance)
- 0.7-1.0: High contextual value (positive sentiment, high future relevance)

Message: "${entry.content}"

Respond with just a number between 0.0 and 1.0.`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at analyzing message sentiment and contextual importance. Provide accurate numerical scores."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.1,
        maxTokens: 10
      });
      
      const scoreText = typeof response === 'string' ? response : response.content;
      const score = parseFloat(scoreText.trim());
      
      if (isNaN(score) || score < 0 || score > 1) {
        logger.warn(`Invalid sentiment score '${scoreText}' for message, using neutral`);
        return 0.5;
      }
      
      return score;
    } catch (error) {
      logger.warn('LLM sentiment analysis failed, using neutral score:', error);
      return 0.5;
    }
  }

  /**
   * Analyze importance of content using LLM-based semantic analysis
   */
  private async analyzeImportance(entry: MemoryEntry): Promise<number> {
    // If no provider, fall back to keyword-based analysis
    if (!this.provider) {
      return this.keywordBasedImportance(entry);
    }
    
    try {
      const prompt = `Analyze the importance of this message in a conversation context. Consider factors like:
- Information relevance and value
- User preferences and stated needs
- Factual content and key details
- Emotional significance
- Future reference value

Rate importance on a scale of 0.0 to 1.0 where:
- 0.0-0.3: Low importance (casual remarks, pleasantries)
- 0.4-0.6: Medium importance (general information, questions)
- 0.7-0.9: High importance (preferences, facts, key decisions)
- 0.9-1.0: Critical importance (personal data, goals, explicit requests to remember)

Message: "${entry.content}"

Respond with just a number between 0.0 and 1.0.`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at analyzing message importance for conversation memory. Provide accurate numerical importance scores."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.1,
        maxTokens: 10
      });
      
      const scoreText = typeof response === 'string' ? response : response.content;
      const score = parseFloat(scoreText.trim());
      
      // Validate score
      if (isNaN(score) || score < 0 || score > 1) {
        logger.warn(`Invalid importance score '${scoreText}' for message, falling back to keyword analysis`);
        return this.keywordBasedImportance(entry);
      }
      
      logger.debug(`LLM importance analysis: ${entry.content.substring(0, 50)}... -> ${score}`);
      return score;
    } catch (error) {
      logger.warn('LLM importance analysis failed, falling back to keyword analysis:', error);
      return this.keywordBasedImportance(entry);
    }
  }
  
  /**
   * Fallback keyword-based importance analysis
   */
  private keywordBasedImportance(entry: MemoryEntry): number {
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
  async compressContext(layer: keyof ContextLayers): Promise<void> {
    logger.debug(`Compressing context layer: ${layer}`);
    
    switch (layer) {
      case 'immediate':
        await this.compressImmediateLayer();
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
  private async compressImmediateLayer(): Promise<void> {
    const layer = this.layers.immediate;
    const targetTokens = this.tokenBudget.immediate;
    
    if (layer.tokenCount <= targetTokens) return;
    
    // Sort by priority and keep the most important messages
    const prioritizedMessages = await this.prioritizeContent(layer.messages);
    
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
  async addToImmediate(entry: MemoryEntry): Promise<void> {
    const tokens = this.estimateTokens(entry.content);
    
    if (this.allocateTokens('immediate', tokens)) {
      this.layers.immediate.messages.push(entry);
      this.layers.immediate.lastUpdated = new Date();
    } else {
      // Need to compress first
      await this.compressContext('immediate');
      
      // Try again after compression
      if (this.allocateTokens('immediate', tokens)) {
        this.layers.immediate.messages.push(entry);
        this.layers.immediate.lastUpdated = new Date();
      }
    }
  }

  /**
   * Extract entities from content using LLM-based analysis
   */
  async extractEntities(content: string): Promise<Record<string, any>> {
    if (!this.provider) {
      return this.simpleEntityExtraction(content);
    }
    
    try {
      const prompt = `Extract important entities from this text. Focus on:
- People (names, relationships)
- Places (locations, addresses)
- Organizations (companies, institutions)
- Products/Services
- Dates and Times
- Preferences and Opinions
- Facts and Important Information

Return as JSON object with categories as keys and arrays of entities as values.

Text: "${content}"

Example format:
{
  "people": ["John Doe", "Sarah"],
  "places": ["New York", "Central Park"],
  "preferences": ["likes coffee", "prefers morning meetings"],
  "facts": ["works at Google", "has 5 years experience"]
}`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at extracting structured information from text. Always return valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.1,
        maxTokens: 300
      });
      
      const entityText = typeof response === 'string' ? response : response.content;
      
      try {
        const entities = JSON.parse(entityText.trim());
        logger.debug(`LLM entity extraction successful: ${Object.keys(entities).length} categories`);
        return entities;
      } catch {
        logger.warn('Failed to parse LLM entity extraction response, falling back to simple extraction');
        return this.simpleEntityExtraction(content);
      }
    } catch (error) {
      logger.warn('LLM entity extraction failed, falling back to simple extraction:', error);
      return this.simpleEntityExtraction(content);
    }
  }
  
  /**
   * Simple entity extraction fallback
   */
  private simpleEntityExtraction(content: string): Record<string, any> {
    const entities: Record<string, any> = {
      keywords: [],
      potential_names: [],
      preferences: []
    };
    
    // Extract potential names (capitalized words)
    const namePattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
    const potentialNames = content.match(namePattern) || [];
    entities.potential_names = [...new Set(potentialNames)];
    
    // Extract preference indicators
    const preferencePatterns = [
      /\bi like\s+([^.!?]+)/gi,
      /\bi prefer\s+([^.!?]+)/gi,
      /\bi want\s+([^.!?]+)/gi,
      /\bi need\s+([^.!?]+)/gi
    ];
    
    for (const pattern of preferencePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        entities.preferences.push(...matches);
      }
    }
    
    return entities;
  }
  
  /**
   * Update summarized layer with new information
   */
  async updateSummarized(summary: string, keyPoints: string[], entities: Record<string, any>, sourceIds: string[]): Promise<void> {
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
   * Generate comprehensive summary with entity extraction
   */
  async generateIntelligentSummary(messages: MemoryEntry[]): Promise<{
    summary: string;
    keyPoints: string[];
    entities: Record<string, any>;
  }> {
    if (!this.provider) {
      // Fallback to simple summarization
      const text = messages.map(m => m.content).join(' ');
      const entities = await this.extractEntities(text);
      return {
        summary: text.substring(0, 500) + '...',
        keyPoints: ["Simple summary generated"],
        entities
      };
    }
    
    try {
      const conversationText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      
      const prompt = `Analyze this conversation and provide:
1. A concise summary preserving key information
2. A list of important key points
3. Extracted entities (people, places, preferences, facts)

Return as JSON with structure:
{
  "summary": "...",
  "keyPoints": ["...", "..."],
  "entities": {
    "people": [...],
    "places": [...],
    "preferences": [...],
    "facts": [...]
  }
}

Conversation:
${conversationText}`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at analyzing conversations and extracting structured information. Always return valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.2,
        maxTokens: 600
      });
      
      const responseText = typeof response === 'string' ? response : response.content;
      
      try {
        const result = JSON.parse(responseText.trim());
        logger.debug(`Intelligent summary generated: ${result.keyPoints?.length || 0} key points, ${Object.keys(result.entities || {}).length} entity categories`);
        return {
          summary: result.summary || '',
          keyPoints: result.keyPoints || [],
          entities: result.entities || {}
        };
      } catch {
        logger.warn('Failed to parse intelligent summary response, falling back');
        const text = messages.map(m => m.content).join(' ');
        const entities = await this.extractEntities(text);
        return {
          summary: text.substring(0, 500) + '...',
          keyPoints: ["Fallback summary generated"],
          entities
        };
      }
    } catch (error) {
      logger.warn('Intelligent summary generation failed:', error);
      const text = messages.map(m => m.content).join(' ');
      const entities = await this.extractEntities(text);
      return {
        summary: text.substring(0, 500) + '...',
        keyPoints: ["Fallback summary generated"],
        entities
      };
    }
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