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
   * Token estimation ratios for different content types.
   * Based on empirical analysis of typical tokenization patterns.
   *
   * Reference values (characters per token):
   * - English prose: ~4 chars/token
   * - Code (mixed): ~3.5 chars/token (more special chars, shorter words)
   * - JSON/structured data: ~3 chars/token (lots of punctuation)
   * - Markdown: ~3.8 chars/token (formatting characters)
   * - Technical text: ~3.7 chars/token (technical terms, numbers)
   * - Non-English: ~2.5-3 chars/token (varies by language)
   */
  private static readonly TOKEN_RATIOS = {
    prose: 4.0, // Standard English text
    code: 3.5, // Programming code
    json: 3.0, // JSON/structured data
    markdown: 3.8, // Markdown formatted text
    technical: 3.7, // Technical documentation
    mixed: 3.5, // Mixed content (default for uncertain)
  };

  /**
   * Estimate token count for a message using content-type aware estimation.
   * More accurate than simple character division.
   */
  estimateTokens(content: string): number {
    // Handle null/undefined/empty content
    if (!content || typeof content !== 'string') {
      return 0;
    }

    // Detect content type and use appropriate ratio
    const contentType = this.detectContentType(content);
    const ratio = ContextCompressor.TOKEN_RATIOS[contentType];

    // Calculate base estimate
    const baseEstimate = content.length / ratio;

    // Add overhead for special characters and formatting
    // Tokenizers often split on special characters, creating extra tokens
    const specialCharCount = (content.match(/[^\w\s]/g) || []).length;
    const specialCharOverhead = specialCharCount * 0.1; // ~10% overhead per special char cluster

    // Add overhead for numbers (often tokenized separately)
    const numberCount = (content.match(/\d+/g) || []).length;
    const numberOverhead = numberCount * 0.5;

    // Add overhead for whitespace patterns (newlines, indentation)
    const whitespacePatterns = (content.match(/\n\s+/g) || []).length;
    const whitespaceOverhead = whitespacePatterns * 0.3;

    const totalEstimate = baseEstimate + specialCharOverhead + numberOverhead + whitespaceOverhead;

    return Math.ceil(totalEstimate);
  }

  // Consistent content length limit for all detection methods
  private static readonly CONTENT_DETECTION_LIMIT = 10000;

  /**
   * Detect the content type for more accurate token estimation
   */
  private detectContentType(content: string): keyof typeof ContextCompressor.TOKEN_RATIOS {
    // Limit content length for detection to avoid performance issues
    const sampleContent =
      content.length > ContextCompressor.CONTENT_DETECTION_LIMIT
        ? content.substring(0, ContextCompressor.CONTENT_DETECTION_LIMIT)
        : content;

    // Check for JSON content
    if (this.detectJsonContent(sampleContent)) {
      return 'json';
    }

    // Check for code content (highest priority after JSON)
    if (this.detectCodeContent(sampleContent)) {
      return 'code';
    }

    // Check for markdown content
    if (this.detectMarkdownContent(sampleContent)) {
      return 'markdown';
    }

    // Check for technical content
    if (this.detectTechnicalContent(sampleContent)) {
      return 'technical';
    }

    // Default to prose for regular text
    return 'prose';
  }

  /**
   * Detect if content is JSON or structured data
   */
  private detectJsonContent(content: string): boolean {
    const trimmed = content.trim();
    // Check if content starts with JSON-like patterns
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return true;
    }
    // Check for high density of JSON-like patterns
    const jsonPatterns = (content.match(/["']?\w+["']?\s*:\s*["'[{]/g) || []).length;
    const contentLines = content.split('\n').length;
    return jsonPatterns > contentLines * 0.3; // More than 30% lines have JSON patterns
  }

  /**
   * Detect if content contains markdown formatting
   */
  private detectMarkdownContent(content: string): boolean {
    const markdownIndicators = [
      /^#{1,6}\s+/m, // Headers
      /^\s*[-*+]\s+/m, // Unordered lists
      /^\s*\d+\.\s+/m, // Ordered lists
      /\*\*[^*]+\*\*/, // Bold
      /\*[^*]+\*/, // Italic
      /\[.+?\]\(.+?\)/, // Links
      /`[^`]+`/, // Inline code
      /^\s*>\s+/m, // Blockquotes
    ];
    let matchCount = 0;
    for (const pattern of markdownIndicators) {
      if (pattern.test(content)) matchCount++;
    }
    return matchCount >= 2; // At least 2 markdown patterns
  }

  /**
   * Detect if content is technical documentation
   */
  private detectTechnicalContent(content: string): boolean {
    const technicalIndicators = [
      /\b(API|HTTP|URL|JSON|XML|SQL|REST|SDK)\b/i,
      /\b(function|method|class|interface|type|parameter)\b/i,
      /\b(error|exception|warning|debug|log)\b/i,
      /\b(config|configuration|setting|option)\b/i,
      /\b(v\d+\.\d+|version\s+\d+)/i,
      /\b(npm|yarn|pip|cargo|maven|gradle)\b/i,
    ];
    let matchCount = 0;
    for (const pattern of technicalIndicators) {
      if (pattern.test(content)) matchCount++;
    }
    return matchCount >= 3; // At least 3 technical patterns
  }

  /**
   * Detect if content contains code
   * Note: Content is already limited by detectContentType (CONTENT_DETECTION_LIMIT)
   * Regex patterns are optimized to prevent ReDoS (catastrophic backtracking)
   */
  private detectCodeContent(content: string): boolean {
    // Content is already limited by detectContentType, no need to limit again
    // Keeping regex patterns safe with bounded quantifiers for extra safety
    const codeIndicators = [
      // Safe: uses negated character class instead of [\s\S]* which can cause catastrophic backtracking
      /```[^`]{0,10000}```/,
      /function\s+\w+/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      // Safe: limited repetition instead of .*
      /import\s+[^\n]{0,500}from/,
      // Safe: uses negated character class with limit instead of [\s\S]*
      /\{[^{}]{0,1000}\}/,
    ];
    return codeIndicators.some((pattern) => pattern.test(content));
  }

  /**
   * Calculate total token count for messages
   */
  calculateTotalTokens(messages: ContextMessage[]): number {
    // Handle null/undefined messages array
    if (!messages || !Array.isArray(messages)) {
      return 0;
    }
    return messages.reduce((total, msg) => {
      if (!msg) return total;
      const tokens = msg.tokens ?? this.estimateTokens(msg.content ?? '');
      return total + tokens;
    }, 0);
  }

  /**
   * Analyze context for insights
   */
  analyzeContext(messages: ContextMessage[]): ContextAnalysis {
    // Handle null/undefined messages array
    const safeMessages = messages ?? [];
    const totalTokens = this.calculateTotalTokens(safeMessages);
    const messageCount = safeMessages.length;
    const averageTokensPerMessage = messageCount > 0 ? totalTokens / messageCount : 0;
    const maxLength = this.options.maxContextLength ?? 8000;
    // Prevent division by zero
    const contextUtilization = maxLength > 0 ? (totalTokens / maxLength) * 100 : 0;
    const compressionNeeded = totalTokens > maxLength;

    let suggestedCompressionRatio: number | undefined;
    if (compressionNeeded && totalTokens > 0) {
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
        maxContextLength: this.options.maxContextLength ?? 8000,
        strategy: this.options.compressionStrategy ?? 'hybrid',
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
      const strategy = getCompressionStrategy(this.options.compressionStrategy ?? 'hybrid');

      // Apply compression
      const compressedMessages = await strategy.compress(messages, this.options);

      // Calculate results
      const newTotalTokens = this.calculateTotalTokens(compressedMessages);
      const tokensReduced = originalTokens - newTotalTokens;
      // Prevent division by zero
      const compressionRatio = originalTokens > 0 ? tokensReduced / originalTokens : 0;

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
