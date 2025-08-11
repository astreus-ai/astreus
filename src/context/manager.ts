import {
  ContextManager as IContextManager,
  ContextMessage,
  ContextWindow,
  ContextAnalysis,
  CompressionResult,
  ContextCompressorOptions,
  ContextSummary,
} from './types';
import { MetadataObject } from '../types';
import { ContextCompressor } from './compressor';
import { ContextStorage } from './storage';
import { DEFAULT_CONTEXT_OPTIONS } from './defaults';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { getLLM } from '../llm';
import { getDatabase } from '../database';

export class ContextManager implements IContextManager {
  private messages: ContextMessage[] = [];
  private compressor: ContextCompressor;
  private storage: ContextStorage | null = null;
  private logger: Logger;
  private maxTokens: number;
  private autoCompress: boolean;
  private model: string;
  private agentId: number | null = null;
  private isDirty: boolean = false; // Track if context needs saving

  constructor(options: ContextCompressorOptions & { autoCompress?: boolean } = {}) {
    this.logger = getLogger();
    this.compressor = new ContextCompressor(options);
    this.maxTokens = options.maxContextLength || DEFAULT_CONTEXT_OPTIONS.maxContextLength || 8000;
    this.autoCompress = options.autoCompress ?? true;
    // Use provided model or context compression model as fallback
    this.model = options.model || DEFAULT_CONTEXT_OPTIONS.model || 'gpt-4o-mini';

    this.logger.debug('ContextManager initialized', {
      maxTokens: this.maxTokens,
      autoCompress: this.autoCompress,
      model: this.model,
    });
  }

  /**
   * Initialize storage and load context for a specific agent
   */
  async initializeForAgent(agentId: number): Promise<void> {
    this.agentId = agentId;

    try {
      const db = await getDatabase();
      this.storage = new ContextStorage(db.getKnex(), this.logger);

      // Load existing context from storage
      const storedContext = await this.storage.loadContext(agentId);
      if (storedContext) {
        this.messages = storedContext.contextData;
        this.logger.info('Context loaded from storage', {
          agentId,
          messagesCount: this.messages.length,
          tokensUsed: storedContext.tokensUsed,
        });
      } else {
        this.logger.debug('No stored context found, starting fresh', { agentId });
      }

      this.isDirty = false;
    } catch (error) {
      this.logger.warn('Failed to initialize context storage', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without storage - fallback to in-memory only
      this.storage = null;
    }
  }

  /**
   * Save current context to storage
   */
  async saveToStorage(): Promise<void> {
    if (!this.storage || !this.agentId || !this.isDirty) {
      return;
    }

    try {
      const tokensUsed = this.compressor.calculateTotalTokens(this.messages);
      await this.storage.saveContext({
        agentId: this.agentId,
        contextData: this.messages,
        tokensUsed,
      });

      this.isDirty = false;
      this.logger.debug('Context saved to storage', {
        agentId: this.agentId,
        messagesCount: this.messages.length,
        tokensUsed,
      });
    } catch (error) {
      this.logger.warn('Failed to save context to storage', {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Add a message to the context
   */
  addMessage(message: ContextMessage): void {
    // Add timestamp if not provided
    if (!message.timestamp) {
      message.timestamp = new Date();
    }

    // Estimate tokens if not provided
    if (!message.tokens) {
      message.tokens = this.compressor.estimateTokens(message.content);
    }

    this.messages.push(message);
    this.isDirty = true; // Mark context as dirty for saving

    this.logger.debug('Message added to context', {
      role: message.role,
      tokens: message.tokens,
      totalMessages: this.messages.length,
    });

    // Auto-save to storage (async, don't block)
    this.saveToStorage().catch((error) => {
      this.logger.debug('Auto-save failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Auto-compress if needed
    if (this.autoCompress && this.shouldCompress()) {
      this.compressContext().catch((error) => {
        this.logger.error('Auto-compression failed', error instanceof Error ? error : undefined);
      });
    }
  }

  /**
   * Get all messages
   */
  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  /**
   * Get context window information
   */
  getContextWindow(): ContextWindow {
    const totalTokens = this.compressor.calculateTotalTokens(this.messages);
    const utilizationPercentage = (totalTokens / this.maxTokens) * 100;

    return {
      messages: this.getMessages(),
      totalTokens,
      maxTokens: this.maxTokens,
      utilizationPercentage,
    };
  }

  /**
   * Analyze the current context
   */
  analyzeContext(): ContextAnalysis {
    return this.compressor.analyzeContext(this.messages);
  }

  /**
   * Compress the context
   */
  async compressContext(): Promise<CompressionResult> {
    const result = await this.compressor.compressConversation(this.messages);

    if (result.success) {
      this.messages = result.compressedMessages;
      this.isDirty = true; // Mark as dirty since messages changed

      this.logger.info('Context compressed successfully', {
        tokensReduced: result.tokensReduced,
        compressionRatio: `${(result.compressionRatio * 100).toFixed(1)}%`,
      });

      // Save compressed context with metadata
      if (this.storage && this.agentId) {
        try {
          await this.storage.updateContextMetadata(this.agentId, {
            tokensUsed: this.compressor.calculateTotalTokens(this.messages),
            compressionVersion: result.strategy,
          });

          // Save the compressed messages
          await this.saveToStorage();
        } catch (error) {
          this.logger.warn('Failed to save compressed context', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return result;
  }

  /**
   * Clear all context
   */
  clearContext(): void {
    const previousCount = this.messages.length;
    this.messages = [];
    this.logger.info('Context cleared', { messagesRemoved: previousCount });
  }

  /**
   * Check if compression is needed
   */
  shouldCompress(): boolean {
    return this.compressor.shouldCompress(this.messages);
  }

  /**
   * Export context as JSON string
   */
  exportContext(): string {
    const exportData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      messages: this.messages,
      metadata: {
        totalMessages: this.messages.length,
        totalTokens: this.compressor.calculateTotalTokens(this.messages),
      },
    };
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import context from JSON string
   */
  importContext(data: string): void {
    try {
      const parsed = JSON.parse(data);

      if (!parsed.messages || !Array.isArray(parsed.messages)) {
        throw new Error('Invalid context data: missing messages array');
      }

      // Validate and restore messages
      this.messages = parsed.messages.map(
        (msg: {
          role?: string;
          content?: string;
          timestamp?: string;
          metadata?: MetadataObject;
          tokens?: number;
        }) => ({
          role: msg.role || 'user',
          content: msg.content || '',
          timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          metadata: msg.metadata || {},
          tokens: msg.tokens,
        })
      );

      this.logger.info('Context imported successfully', {
        messagesImported: this.messages.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to import context', error instanceof Error ? error : undefined);
      throw new Error(`Failed to import context: ${errorMessage}`);
    }
  }

  /**
   * Generate a summary of the current context
   */
  async generateSummary(): Promise<ContextSummary> {
    if (this.messages.length === 0) {
      return {
        mainTopics: [],
        keyEntities: [],
        conversationFlow: 'No conversation yet',
        importantFacts: [],
        actionItems: [],
      };
    }

    const conversationText = this.messages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const summaryPrompt = `Analyze the following conversation and provide a structured summary:

${conversationText}

Provide a JSON summary with:
1. mainTopics: Array of main topics discussed
2. keyEntities: Array of important entities mentioned (people, places, concepts)
3. conversationFlow: Brief description of how the conversation progressed
4. importantFacts: Array of key facts or decisions
5. actionItems: Array of any action items or tasks mentioned

Return only valid JSON.`;

    try {
      const llm = getLLM(getLogger());
      const response = await llm.generateResponse({
        model: this.model,
        messages: [{ role: 'user' as const, content: summaryPrompt }],
        temperature: 0.3,
        maxTokens: 500,
      });

      const summary = JSON.parse(response.content);
      return {
        mainTopics: summary.mainTopics || [],
        keyEntities: summary.keyEntities || [],
        conversationFlow: summary.conversationFlow || '',
        importantFacts: summary.importantFacts || [],
        actionItems: summary.actionItems || [],
      };
    } catch (error) {
      this.logger.error('Failed to generate summary', error instanceof Error ? error : undefined);
      return {
        mainTopics: [],
        keyEntities: [],
        conversationFlow: 'Failed to generate summary',
        importantFacts: [],
        actionItems: [],
      };
    }
  }

  /**
   * Get recent messages
   */
  getRecentMessages(count: number): ContextMessage[] {
    return this.messages.slice(-count);
  }

  /**
   * Find messages by role
   */
  getMessagesByRole(role: 'user' | 'assistant' | 'system'): ContextMessage[] {
    return this.messages.filter((msg) => msg.role === role);
  }

  /**
   * Update the model used for context operations
   */
  updateModel(model: string): void {
    this.model = model;
    this.compressor.updateOptions({ model });
    this.logger.debug('Context model updated', { model });
  }

  /**
   * Load conversation history from memory module
   */
  async loadFromMemory(
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
    limit: number = 20
  ): Promise<void> {
    try {
      // Memory'den son conversation messages'larını al
      const recentMemories = await memoryModule.listMemories({
        limit,
        orderBy: 'created_at',
        orderDirection: 'desc',
      });

      // Eski context'i temizle
      this.messages = [];

      // Memory'den mesajları context'e yükle (eski -> yeni sırası)
      const sortedMemories = recentMemories.reverse();
      for (const memory of sortedMemories) {
        if (memory.metadata?.type === 'user_message') {
          this.addMessage({
            role: 'user',
            content: memory.content,
            timestamp: new Date(memory.created_at),
            metadata: { source: 'memory', memory_id: memory.id },
          });
        } else if (memory.metadata?.type === 'assistant_response') {
          this.addMessage({
            role: 'assistant',
            content: memory.content,
            timestamp: new Date(memory.created_at),
            metadata: { source: 'memory', memory_id: memory.id },
          });
        }
      }

      this.logger.info('Context loaded from memory', {
        messagesLoaded: this.messages.length,
        memoryLimit: limit,
      });

      // Memory'den yüklendikten sonra compression gerekirse uygula
      if (this.autoCompress && this.shouldCompress()) {
        await this.compressContext();
      }
    } catch (error) {
      this.logger.error(
        'Failed to load context from memory',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Save current context messages to memory
   */
  async saveToMemory(memoryModule: {
    addMemory: (
      content: string,
      metadata?: MetadataObject
    ) => Promise<{ id: number; content: string }>;
  }): Promise<void> {
    try {
      // Sadece memory'de olmayan yeni mesajları kaydet
      const newMessages = this.messages.filter(
        (msg) => !msg.metadata?.source || msg.metadata.source !== 'memory'
      );

      for (const message of newMessages) {
        if (message.role === 'user') {
          await memoryModule.addMemory(message.content, {
            type: 'user_message',
            ...(message.timestamp && { timestamp: message.timestamp.toISOString() }),
            ...(message.metadata && { context_metadata: message.metadata }),
          });
        } else if (message.role === 'assistant') {
          await memoryModule.addMemory(message.content, {
            type: 'assistant_response',
            ...(message.timestamp && { timestamp: message.timestamp.toISOString() }),
            ...(message.metadata && { context_metadata: message.metadata }),
          });
        }
      }

      this.logger.debug('Context saved to memory', {
        messagesSaved: newMessages.length,
      });
    } catch (error) {
      this.logger.error(
        'Failed to save context to memory',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update compressor options
   */
  updateCompressorOptions(options: Partial<ContextCompressorOptions>): void {
    this.compressor.updateOptions(options);
    if (options.maxContextLength !== undefined) {
      this.maxTokens = options.maxContextLength;
    }
    if (options.model !== undefined) {
      this.model = options.model;
    }
  }
}
