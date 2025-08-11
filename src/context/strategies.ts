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
    const preserveCount = Math.min(options.preserveLastN || 5, messages.length);
    const messagesToPreserve = messages.slice(-preserveCount);
    const messagesToCompress = messages.slice(0, -preserveCount);

    if (messagesToCompress.length === 0) {
      return messages;
    }

    const conversationText = messagesToCompress
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const summaryPrompt = `Summarize the following conversation history concisely, preserving key context and important information:

${conversationText}

Create a comprehensive summary that maintains essential context, key decisions, and important facts.`;

    const llm = getLLM(getLogger());

    const response = await llm.generateResponse({
      model: options.model || DEFAULT_CONTEXT_OPTIONS.model || 'gpt-4o-mini',
      messages: [{ role: 'user' as const, content: summaryPrompt }],
      temperature: 0.3,
      maxTokens: 500,
    });

    const summaryMessage: ContextMessage = {
      role: 'system',
      content: `[Conversation Summary: ${response.content}]`,
      metadata: {
        type: 'summary',
        originalMessageCount: messagesToCompress.length,
        compressionTimestamp: new Date(),
      },
    };

    return [summaryMessage, ...messagesToPreserve];
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
    const preserveCount = Math.min(options.preserveLastN || 5, messages.length);
    const messagesToPreserve = messages.slice(-preserveCount);
    const messagesToAnalyze = messages.slice(0, -preserveCount);

    if (messagesToAnalyze.length === 0) {
      return messages;
    }

    const importantMessages = await this.selectImportantMessages(messagesToAnalyze, options);

    return [...importantMessages, ...messagesToPreserve];
  }

  private async selectImportantMessages(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    const llm = getLLM(getLogger());

    const conversationText = messages
      .map((msg, idx) => `[${idx}] ${msg.role.toUpperCase()}: ${msg.content}`)
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
      model: options.model || DEFAULT_CONTEXT_OPTIONS.model || 'gpt-4o-mini',
      messages: [{ role: 'user' as const, content: selectionPrompt }],
      temperature: 0.1,
      maxTokens: 100,
    });

    const indices = response.content
      .split(',')
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n) && n >= 0 && n < messages.length);

    const selected = indices.map((i) => messages[i]).filter(Boolean);

    if (selected.length === 0) {
      // Fallback: keep every 3rd message
      return messages.filter((_, idx) => idx % 3 === 0);
    }

    return selected;
  }

  estimateCompression(): number {
    return 0.4;
  }
}

export class HybridStrategy implements CompressionStrategy {
  name = 'hybrid';
  private logger = getLogger();
  private summarizationStrategy = new SummarizationStrategy();
  private selectiveStrategy = new SelectiveStrategy();

  async compress(
    messages: ContextMessage[],
    options: ContextCompressorOptions
  ): Promise<ContextMessage[]> {
    const preserveCount = Math.min(options.preserveLastN || 5, messages.length);
    const messagesToPreserve = messages.slice(-preserveCount);
    const messagesToCompress = messages.slice(0, -preserveCount);

    if (messagesToCompress.length === 0) {
      return messages;
    }

    // For very long conversations, use summarization
    if (messagesToCompress.length > 20) {
      return this.summarizationStrategy.compress(messages, options);
    }

    // For medium conversations, use selective preservation with mini-summaries
    const importantMessages = await this.selectiveStrategy.compress(
      messagesToCompress.slice(0, Math.floor(messagesToCompress.length * 0.6)),
      options
    );

    const recentToSummarize = messagesToCompress.slice(Math.floor(messagesToCompress.length * 0.6));

    if (recentToSummarize.length > 0) {
      const summarized = await this.summarizationStrategy.compress(recentToSummarize, {
        ...options,
        preserveLastN: 0,
      });
      return [...importantMessages, ...summarized, ...messagesToPreserve];
    }

    return [...importantMessages, ...messagesToPreserve];
  }

  estimateCompression(): number {
    return 0.3;
  }
}

export function getCompressionStrategy(
  strategyName: 'summarize' | 'selective' | 'hybrid'
): CompressionStrategy {
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
