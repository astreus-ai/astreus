import { CompressionStrategy, ContextMessage, ContextCompressorOptions } from './types';
import { DEFAULT_CONTEXT_OPTIONS } from './defaults';
import { getLLM } from '../llm';
import { getLogger } from '../logger';

export class SummarizationStrategy implements CompressionStrategy {
  name = 'summarize';
  private logger = getLogger();

  async compress(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    // Handle empty messages array
    if (!messages || messages.length === 0) {
      return [];
    }

    const preserveCount = Math.min(options.preserveLastN ?? 3, messages.length);

    // Edge case: if preserveCount equals message length, nothing to compress
    if (preserveCount >= messages.length) {
      return [...messages];
    }

    const messagesToPreserve = messages.slice(-preserveCount);

    // Filter out old summaries from messages to compress (we'll combine them into new summary)
    const messagesToCompress = messages.slice(0, -preserveCount);
    const oldSummaries = messagesToCompress.filter((msg) => msg.metadata?.type === 'summary');
    const regularMessages = messagesToCompress.filter((msg) => msg.metadata?.type !== 'summary');

    if (messagesToCompress.length === 0) {
      return [...messages];
    }

    // Combine old summaries and regular messages for new summary
    let conversationText = '';

    // Include old summaries content
    if (oldSummaries.length > 0) {
      conversationText += 'Previous Summaries:\n';
      conversationText += oldSummaries.map((msg) => msg.content).join('\n\n');
      conversationText += '\n\nNew Messages:\n';
    }

    // Add regular messages
    conversationText += regularMessages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const summaryPrompt = `Summarize the following conversation history concisely, preserving key context and important information:

${conversationText}

Create a comprehensive summary that maintains essential context, key decisions, and important facts.`;

    try {
      const llm = getLLM(getLogger());
      if (!llm) {
        this.logger.warn('LLM not available for compression');
        return [...messagesToCompress, ...messagesToPreserve]; // Fallback: preserve all messages
      }

      const response = await llm.generateResponse({
        model: options.model ?? DEFAULT_CONTEXT_OPTIONS.model ?? 'gpt-4o-mini',
        messages: [{ role: 'user' as const, content: summaryPrompt }],
        temperature: 0.3,
        maxTokens: 500,
      });

      // Validate response content
      const responseContent = response?.content ?? '';

      const totalOriginalCount = messagesToCompress.reduce((count, msg) => {
        const msgCount = msg.metadata?.originalMessageCount;
        return count + (typeof msgCount === 'number' ? msgCount : 1);
      }, 0);

      const summaryMessage: ContextMessage = {
        role: 'system',
        content: `[Context Compressed] Previous ${totalOriginalCount} messages summarized:\n${responseContent}`,
        metadata: {
          type: 'summary',
          originalMessageCount: totalOriginalCount,
          compressionTimestamp: new Date(),
          compressed: true,
        },
        timestamp: new Date(),
        tokens: Math.floor(responseContent.length / 4), // Estimate tokens
      };

      // Return only ONE summary plus preserved messages
      return [summaryMessage, ...messagesToPreserve];
    } catch (error) {
      // Fallback: if summarization fails, preserve ALL messages to prevent data loss
      this.logger.error(
        'Compression failed, preserving all messages',
        error instanceof Error ? error : undefined
      );
      return [...messagesToCompress, ...messagesToPreserve]; // Don't lose any messages
    }
  }

  estimateCompression(): number {
    return 0.3;
  }
}

export class SelectiveStrategy implements CompressionStrategy {
  name = 'selective';
  private logger = getLogger();

  async compress(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    // Handle empty messages array
    if (!messages || messages.length === 0) {
      return [];
    }

    const preserveCount = Math.min(options.preserveLastN ?? 3, messages.length);

    // Edge case: if preserveCount equals message length, nothing to compress
    if (preserveCount >= messages.length) {
      return [...messages];
    }

    const messagesToPreserve = messages.slice(-preserveCount);
    const messagesToAnalyze = messages.slice(0, -preserveCount);

    if (messagesToAnalyze.length === 0) {
      return [...messages];
    }

    const importantMessages = await this.selectImportantMessages(messagesToAnalyze, options);

    // If no important messages were selected, preserve some older messages as fallback
    // to prevent complete data loss from the non-preserved portion
    if (importantMessages.length === 0 && messagesToAnalyze.length > 0) {
      // Fallback: keep at least 20% of older messages or minimum 1 message
      const fallbackCount = Math.max(1, Math.ceil(messagesToAnalyze.length * 0.2));
      const fallbackMessages = messagesToAnalyze.slice(-fallbackCount);
      this.logger.debug('Using fallback selection due to empty LLM selection', {
        originalCount: messagesToAnalyze.length,
        fallbackCount,
      });
      return [...fallbackMessages, ...messagesToPreserve];
    }

    return [...importantMessages, ...messagesToPreserve];
  }

  private async selectImportantMessages(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    // Handle empty messages
    if (!messages || messages.length === 0) {
      return [];
    }

    try {
      const llm = getLLM(getLogger());
      if (!llm) {
        this.logger.warn('LLM not available for selective compression');
        return []; // Fallback: let compress() use only messagesToPreserve
      }

      const conversationText = messages
        .map((msg, idx) => `[${idx}] ${msg.role?.toUpperCase() ?? 'UNKNOWN'}: ${msg.content ?? ''}`)
        .join('\n\n');

      const selectionPrompt = `Analyze the following conversation and identify the most important messages that must be preserved for context:

${conversationText}

Return the indices of important messages as a comma-separated list. Consider:
- Key decisions or agreements
- Important facts or data
- Context-setting information
- Unresolved questions or tasks

Important message indices:`;

      const response = await llm.generateResponse({
        model: options.model ?? DEFAULT_CONTEXT_OPTIONS.model ?? 'gpt-4o-mini',
        messages: [{ role: 'user' as const, content: selectionPrompt }],
        temperature: 0.1,
        maxTokens: 100,
      });

      // Safely parse response content
      const responseContent = response?.content ?? '';
      const indices = responseContent
        .split(',')
        .map((s) => parseInt(s.trim()))
        .filter((n) => !isNaN(n) && n >= 0 && n < messages.length);

      const selected = indices.map((i) => messages[i]).filter(Boolean);

      if (selected.length === 0) {
        // Fallback: return empty to let compress() use only messagesToPreserve
        // This matches SummarizationStrategy's fallback behavior
        this.logger.debug('No important messages selected, using fallback');
        return [];
      }

      return selected;
    } catch (error) {
      // Fallback: if LLM call fails, return empty to let compress() use only messagesToPreserve
      // This matches SummarizationStrategy's fallback behavior for consistency
      this.logger.warn(
        'Selective compression failed, falling back to preserving recent messages only',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return [];
    }
  }

  estimateCompression(): number {
    return 0.4;
  }
}

export class HybridStrategy implements CompressionStrategy {
  name = 'hybrid';
  private logger: ReturnType<typeof getLogger>;
  private summarizationStrategy: SummarizationStrategy;
  private selectiveStrategy: SelectiveStrategy;

  constructor(logger?: ReturnType<typeof getLogger>) {
    // Cache sub-strategies in constructor to prevent memory leaks from repeated instantiation
    this.logger = logger ?? getLogger();
    this.summarizationStrategy = new SummarizationStrategy();
    this.selectiveStrategy = new SelectiveStrategy();
  }

  async compress(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    // Handle empty messages array
    if (!messages || messages.length === 0) {
      return [];
    }

    const preserveCount = Math.min(options.preserveLastN ?? 3, messages.length);

    // Edge case: if preserveCount equals message length, nothing to compress
    if (preserveCount >= messages.length) {
      return [...messages];
    }

    const messagesToPreserve = messages.slice(-preserveCount);
    const messagesToCompress = messages.slice(0, -preserveCount);

    if (messagesToCompress.length === 0) {
      return [...messages];
    }

    try {
      // For very long conversations or if we already have summaries, use summarization
      const hasSummaries = messagesToCompress.some((msg) => msg.metadata?.type === 'summary');
      if (messagesToCompress.length > 20 || hasSummaries) {
        return this.summarizationStrategy.compress(messages, options);
      }

      // For medium conversations, use selective preservation with mini-summaries
      const sliceIndex = Math.floor(messagesToCompress.length * 0.6);
      const importantMessages = await this.selectiveStrategy.compress(
        messagesToCompress.slice(0, sliceIndex),
        options
      );

      const recentToSummarize = messagesToCompress.slice(sliceIndex);

      if (recentToSummarize.length > 0) {
        const summarized = await this.summarizationStrategy.compress(recentToSummarize, {
          ...options,
          preserveLastN: 0,
        });
        return [...importantMessages, ...summarized, ...messagesToPreserve];
      }

      return [...importantMessages, ...messagesToPreserve];
    } catch (error) {
      // Fallback: if hybrid compression fails, preserve ALL messages to prevent data loss
      this.logger.error(
        'Hybrid compression failed, preserving all messages',
        error instanceof Error ? error : undefined
      );
      return [...messagesToCompress, ...messagesToPreserve]; // Don't lose any messages
    }
  }

  estimateCompression(): number {
    return 0.3;
  }
}

// Singleton cache for strategy instances to prevent memory leaks
// Limited to known strategy types to prevent unbounded growth
const VALID_STRATEGIES = ['summarize', 'selective', 'hybrid'] as const;
type ValidStrategyName = (typeof VALID_STRATEGIES)[number];

const strategyCache = new Map<ValidStrategyName, CompressionStrategy>();

function createStrategy(strategyName: ValidStrategyName): CompressionStrategy {
  switch (strategyName) {
    case 'summarize':
      return new SummarizationStrategy();
    case 'selective':
      return new SelectiveStrategy();
    case 'hybrid':
    default:
      return new HybridStrategy();
  }
}

export function getCompressionStrategy(
  strategyName: 'summarize' | 'selective' | 'hybrid'
): CompressionStrategy {
  // Validate strategy name to prevent cache pollution
  const validName: ValidStrategyName = VALID_STRATEGIES.includes(strategyName as ValidStrategyName)
    ? (strategyName as ValidStrategyName)
    : 'hybrid';

  if (!strategyCache.has(validName)) {
    strategyCache.set(validName, createStrategy(validName));
  }
  return strategyCache.get(validName)!;
}

/**
 * Clear the strategy cache (useful for testing and cleanup)
 * This prevents memory leaks by allowing garbage collection of strategy instances
 */
export function clearStrategyCache(): void {
  strategyCache.clear();
}

/**
 * Get the current cache size (useful for monitoring)
 */
export function getStrategyCacheSize(): number {
  return strategyCache.size;
}
