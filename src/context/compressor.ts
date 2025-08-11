import {
  CompressionResult,
  ContextCompressorOptions,
  ContextMessage,
  ContextAnalysis,
} from './types';
import { DEFAULT_CONTEXT_OPTIONS } from './defaults';
import { getCompressionStrategy } from './strategies';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';

export class ContextCompressor {
  private logger: Logger;
  private options: ContextCompressorOptions;

  constructor(options: ContextCompressorOptions = {}) {
    this.logger = getLogger();
    this.options = {
      ...DEFAULT_CONTEXT_OPTIONS,
      ...options,
    };

    this.logger.debug('ContextCompressor initialized');
  }

  /**
   * Estimate token count for a message
   */
  estimateTokens(content: string): number {
    // More accurate estimation based on typical tokenization
    // Average: ~1 token per 4 characters for English text
    // Adjust for code/technical content which tends to have more tokens
    const baseEstimate = content.length / 4;
    const codeMultiplier = this.detectCodeContent(content) ? 1.2 : 1;
    return Math.ceil(baseEstimate * codeMultiplier);
  }

  /**
   * Detect if content contains code
   */
  private detectCodeContent(content: string): boolean {
    const codeIndicators = [
      /```[\s\S]*```/,
      /function\s+\w+/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      /import\s+.*from/,
      /\{[\s\S]*\}/,
    ];
    return codeIndicators.some((pattern) => pattern.test(content));
  }

  /**
   * Calculate total token count for messages
   */
  calculateTotalTokens(messages: ContextMessage[]): number {
    return messages.reduce((total, msg) => {
      const tokens = msg.tokens || this.estimateTokens(msg.content);
      return total + tokens;
    }, 0);
  }

  /**
   * Analyze context for insights
   */
  analyzeContext(messages: ContextMessage[]): ContextAnalysis {
    const totalTokens = this.calculateTotalTokens(messages);
    const messageCount = messages.length;
    const averageTokensPerMessage = messageCount > 0 ? totalTokens / messageCount : 0;
    const maxLength = this.options.maxContextLength || 8000;
    const contextUtilization = (totalTokens / maxLength) * 100;
    const compressionNeeded = totalTokens > maxLength;

    let suggestedCompressionRatio: number | undefined;
    if (compressionNeeded) {
      const targetTokens = maxLength * 0.8;
      suggestedCompressionRatio = 1 - targetTokens / totalTokens;
    }

    return {
      totalTokens,
      messageCount,
      averageTokensPerMessage,
      contextUtilization,
      compressionNeeded,
      suggestedCompressionRatio,
    };
  }

  /**
   * Compress conversation history
   */
  async compressConversation(messages: ContextMessage[]): Promise<CompressionResult> {
    try {
      const analysis = this.analyzeContext(messages);
      const originalTokens = analysis.totalTokens;

      this.logger.debug('Starting context compression', {
        messageCount: messages.length,
        totalTokens: originalTokens,
        maxContextLength: this.options.maxContextLength || 8000,
        strategy: this.options.compressionStrategy || 'hybrid',
      });

      // If we're under the limit, no compression needed
      if (!analysis.compressionNeeded) {
        this.logger.debug('Context within limits, no compression needed');
        return {
          success: true,
          compressedMessages: messages,
          tokensReduced: 0,
          compressionRatio: 0,
        };
      }

      // Get compression strategy
      const strategy = getCompressionStrategy(this.options.compressionStrategy || 'hybrid');

      // Apply compression
      const compressedMessages = await strategy.compress(messages, this.options);

      // Calculate results
      const newTotalTokens = this.calculateTotalTokens(compressedMessages);
      const tokensReduced = originalTokens - newTotalTokens;
      const compressionRatio = tokensReduced / originalTokens;

      this.logger.info('Context compression completed', {
        originalMessages: messages.length,
        compressedMessages: compressedMessages.length,
        originalTokens,
        newTokens: newTotalTokens,
        tokensReduced,
        compressionRatio: `${(compressionRatio * 100).toFixed(1)}%`,
      });

      return {
        success: true,
        compressedMessages,
        tokensReduced,
        compressionRatio,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Context compression failed', error instanceof Error ? error : undefined);

      return {
        success: false,
        compressedMessages: messages,
        tokensReduced: 0,
        compressionRatio: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if compression is needed
   */
  shouldCompress(messages: ContextMessage[]): boolean {
    const analysis = this.analyzeContext(messages);
    return analysis.compressionNeeded;
  }

  /**
   * Update compression options
   */
  updateOptions(options: Partial<ContextCompressorOptions>): void {
    this.options = {
      ...this.options,
      ...options,
    };

    this.logger.debug('ContextCompressor options updated');
  }

  /**
   * Get current options
   */
  getOptions(): ContextCompressorOptions {
    return { ...this.options };
  }
}
