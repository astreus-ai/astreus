import { 
  CompressionStrategy, 
  CompressionResult, 
  MemoryEntry 
} from "../types/memory";
import { ProviderModel } from "../types/provider";
import { logger } from "../utils";

/**
 * Context compression utilities
 * Implements various strategies for compressing memory content
 */
export class ContextCompressor {
  private static provider?: ProviderModel;
  
  /**
   * Set the LLM provider for AI-powered compression
   */
  static setProvider(provider: ProviderModel): void {
    this.provider = provider;
  }
  
  /**
   * Compress content using the specified strategy
   */
  static async compress(
    content: string | MemoryEntry[], 
    strategy: CompressionStrategy,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = this.estimateTokens(
      Array.isArray(content) ? content.map(e => e.content).join(' ') : content
    );
    
    logger.debug(`Starting compression with ${strategy} strategy, target: ${targetTokens} tokens`);
    
    let compressedContent: string;
    let lossEstimate: number;
    
    switch (strategy) {
      case CompressionStrategy.SUMMARIZE:
        ({ compressedContent, lossEstimate } = await this.summarizeContent(content, targetTokens));
        break;
      case CompressionStrategy.KEYWORD_EXTRACT:
        ({ compressedContent, lossEstimate } = await this.extractKeywords(content, targetTokens));
        break;
      case CompressionStrategy.SEMANTIC_CLUSTER:
        ({ compressedContent, lossEstimate } = await this.semanticCluster(content, targetTokens));
        break;
      case CompressionStrategy.TEMPORAL_COMPRESS:
        ({ compressedContent, lossEstimate } = await this.temporalCompress(content, targetTokens));
        break;
      default:
        throw new Error(`Unknown compression strategy: ${strategy}`);
    }
    
    const compressedTokens = this.estimateTokens(compressedContent);
    const compressionRatio = compressedTokens / originalTokens;
    
    const result: CompressionResult = {
      originalTokens,
      compressedTokens,
      compressionRatio,
      strategy,
      lossEstimate
    };
    
    logger.debug(`Compression complete: ${originalTokens} → ${compressedTokens} tokens (${Math.round(compressionRatio * 100)}%)`);
    
    return result;
  }

  /**
   * Summarize content using LLM-based abstractive summarization
   */
  private static async summarizeContent(
    content: string | MemoryEntry[], 
    targetTokens: number
  ): Promise<{ compressedContent: string; lossEstimate: number }> {
    const text = Array.isArray(content) ? content.map(e => e.content).join(' ') : content;
    
    // If no provider, fall back to extractive summarization
    if (!this.provider) {
      return this.extractiveSummarization(text, targetTokens);
    }
    
    try {
      // Use LLM for abstractive summarization
      const prompt = `Summarize the following conversation or text content concisely while preserving the most important information and context. Target length: approximately ${targetTokens} tokens (~${Math.floor(targetTokens * 0.75)} words).\n\nContent:\n${text}`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at summarizing conversations and text content. Create concise, accurate summaries that preserve key information, context, and important details while reducing length."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.3,
        maxTokens: Math.max(targetTokens, 100)
      });
      
      const summary = typeof response === 'string' ? response : response.content;
      const summaryTokens = this.estimateTokens(summary);
      
      // Trim if too long
      const finalSummary = summaryTokens > targetTokens ? 
        summary.substring(0, targetTokens * 4) + '...' : 
        summary;
      
      logger.debug(`LLM summarization: ${this.estimateTokens(text)} → ${this.estimateTokens(finalSummary)} tokens`);
      
      return {
        compressedContent: finalSummary,
        lossEstimate: 0.3 // Lower loss for abstractive summarization
      };
    } catch (error) {
      logger.warn('LLM summarization failed, falling back to extractive:', error);
      return this.extractiveSummarization(text, targetTokens);
    }
  }
  
  /**
   * Fallback extractive summarization method
   */
  private static extractiveSummarization(
    text: string, 
    targetTokens: number
  ): { compressedContent: string; lossEstimate: number } {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const targetSentences = Math.max(1, Math.floor(targetTokens / 20)); // ~20 tokens per sentence
    
    if (sentences.length <= targetSentences) {
      return {
        compressedContent: text,
        lossEstimate: 0
      };
    }
    
    // Score sentences by length and position (simple heuristic)
    const scoredSentences = sentences.map((sentence, index) => {
      const positionScore = 1 - (index / sentences.length); // Earlier sentences score higher
      const lengthScore = Math.min(sentence.trim().length / 100, 1); // Longer sentences score higher
      
      return {
        sentence: sentence.trim(),
        score: positionScore * 0.3 + lengthScore * 0.7
      };
    });
    
    // Take top sentences
    const topSentences = scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, targetSentences)
      .map(s => s.sentence);
    
    const compressedContent = topSentences.join('. ') + '.';
    const lossEstimate = 1 - (targetSentences / sentences.length);
    
    return { compressedContent, lossEstimate };
  }

  /**
   * Extract keywords and key phrases using LLM-based semantic analysis
   */
  private static async extractKeywords(
    content: string | MemoryEntry[], 
    targetTokens: number
  ): Promise<{ compressedContent: string; lossEstimate: number }> {
    const text = Array.isArray(content) ? content.map(e => e.content).join(' ') : content;
    
    // If no provider, fall back to frequency-based extraction
    if (!this.provider) {
      return this.frequencyBasedKeywordExtraction(text, targetTokens);
    }
    
    try {
      // Use LLM for semantic keyword extraction
      const prompt = `Extract the most important keywords, key phrases, and concepts from the following content. Focus on:
- Main topics and themes
- Important names, places, and entities
- Key actions and decisions
- Critical facts and information

Present as a concise summary using bullet points. Target length: approximately ${targetTokens} tokens.

Content:
${text}`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at extracting key information from text. Identify the most important concepts, entities, and themes while preserving critical context."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.2,
        maxTokens: Math.max(targetTokens, 100)
      });
      
      const keywords = typeof response === 'string' ? response : response.content;
      const keywordTokens = this.estimateTokens(keywords);
      
      // Trim if too long
      const finalKeywords = keywordTokens > targetTokens ? 
        keywords.substring(0, targetTokens * 4) + '...' : 
        keywords;
      
      logger.debug(`LLM keyword extraction: ${this.estimateTokens(text)} → ${this.estimateTokens(finalKeywords)} tokens`);
      
      return {
        compressedContent: finalKeywords,
        lossEstimate: 0.6 // Medium loss for keyword extraction
      };
    } catch (error) {
      logger.warn('LLM keyword extraction failed, falling back to frequency-based:', error);
      return this.frequencyBasedKeywordExtraction(text, targetTokens);
    }
  }
  
  /**
   * Fallback frequency-based keyword extraction
   */
  private static frequencyBasedKeywordExtraction(
    text: string, 
    targetTokens: number
  ): { compressedContent: string; lossEstimate: number } {
    // Simple keyword extraction
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3);
    
    // Count word frequencies
    const wordFreq: Record<string, number> = {};
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    // Get top keywords
    const topKeywords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.floor(targetTokens / 2))
      .map(([word]) => word);
    
    // Extract phrases containing keywords
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const keyPhrases: string[] = [];
    
    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      const hasKeyword = topKeywords.some(keyword => lowerSentence.includes(keyword));
      
      if (hasKeyword && this.estimateTokens(keyPhrases.join(' ')) < targetTokens) {
        keyPhrases.push(sentence.trim());
      }
    }
    
    const compressedContent = keyPhrases.join('. ') + '.';
    const lossEstimate = 0.7; // High loss for keyword extraction
    
    return { compressedContent, lossEstimate };
  }

  /**
   * Cluster semantically similar content using LLM-based analysis
   */
  private static async semanticCluster(
    content: string | MemoryEntry[], 
    targetTokens: number
  ): Promise<{ compressedContent: string; lossEstimate: number }> {
    const entries = Array.isArray(content) ? content : [{ content, timestamp: new Date() } as MemoryEntry];
    
    // If no provider, fall back to word-frequency clustering
    if (!this.provider) {
      return this.wordFrequencyClustering(entries, targetTokens);
    }
    
    try {
      // Use LLM for semantic clustering
      const text = entries.map(e => e.content).join('\n');
      const prompt = `Analyze the following content and group it into semantic clusters/themes. For each cluster, provide a concise summary. Target total length: approximately ${targetTokens} tokens.

Content:
${text}`;
      
      const response = await this.provider.complete([
        {
          role: "system",
          content: "You are an expert at analyzing text and identifying semantic themes. Group related content together and provide clear, concise summaries for each theme."
        },
        {
          role: "user",
          content: prompt
        }
      ], {
        temperature: 0.3,
        maxTokens: Math.max(targetTokens, 150)
      });
      
      const clusters = typeof response === 'string' ? response : response.content;
      const clusterTokens = this.estimateTokens(clusters);
      
      // Trim if too long
      const finalClusters = clusterTokens > targetTokens ? 
        clusters.substring(0, targetTokens * 4) + '...' : 
        clusters;
      
      logger.debug(`LLM semantic clustering: ${this.estimateTokens(text)} → ${this.estimateTokens(finalClusters)} tokens`);
      
      return {
        compressedContent: finalClusters,
        lossEstimate: 0.4 // Lower loss for semantic clustering
      };
    } catch (error) {
      logger.warn('LLM semantic clustering failed, falling back to word-frequency clustering:', error);
      return this.wordFrequencyClustering(entries, targetTokens);
    }
  }
  
  /**
   * Fallback word-frequency based clustering
   */
  private static wordFrequencyClustering(
    entries: MemoryEntry[], 
    targetTokens: number
  ): { compressedContent: string; lossEstimate: number } {
    const clusters: Record<string, string[]> = {};
    
    entries.forEach(entry => {
      const words = entry.content.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 4);
      
      // Find dominant topic (most frequent word)
      const wordFreq: Record<string, number> = {};
      words.forEach(word => {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      });
      
      const topicWord = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';
      
      if (!clusters[topicWord]) {
        clusters[topicWord] = [];
      }
      
      clusters[topicWord].push(entry.content);
    });
    
    // Summarize each cluster
    const clusterSummaries: string[] = [];
    const tokensPerCluster = Math.floor(targetTokens / Object.keys(clusters).length);
    
    for (const [topic, messages] of Object.entries(clusters)) {
      const clusterText = messages.join(' ');
      const summary = this.extractiveSummarization(clusterText, tokensPerCluster);
      clusterSummaries.push(`${topic}: ${summary.compressedContent}`);
    }
    
    const compressedContent = clusterSummaries.join(' ');
    const lossEstimate = 0.5; // Medium loss for clustering
    
    return { compressedContent, lossEstimate };
  }

  /**
   * Compress based on temporal patterns
   */
  private static async temporalCompress(
    content: string | MemoryEntry[], 
    targetTokens: number
  ): Promise<{ compressedContent: string; lossEstimate: number }> {
    const entries = Array.isArray(content) ? content : [{ content, timestamp: new Date() } as MemoryEntry];
    
    // Group by time periods
    const now = new Date();
    const timeGroups: Record<string, MemoryEntry[]> = {
      recent: [], // Last hour
      today: [],  // Today
      week: [],   // This week
      older: []   // Older than a week
    };
    
    entries.forEach(entry => {
      const age = now.getTime() - entry.timestamp.getTime();
      const ageHours = age / (1000 * 60 * 60);
      
      if (ageHours < 1) {
        timeGroups.recent.push(entry);
      } else if (ageHours < 24) {
        timeGroups.today.push(entry);
      } else if (ageHours < 168) { // 7 days
        timeGroups.week.push(entry);
      } else {
        timeGroups.older.push(entry);
      }
    });
    
    // Allocate tokens based on recency (recent gets more tokens)
    const tokenAllocation = {
      recent: Math.floor(targetTokens * 0.4),
      today: Math.floor(targetTokens * 0.3),
      week: Math.floor(targetTokens * 0.2),
      older: Math.floor(targetTokens * 0.1)
    };
    
    const summaries: string[] = [];
    
    for (const [period, periodEntries] of Object.entries(timeGroups)) {
      if (periodEntries.length > 0) {
        const periodText = periodEntries.map(e => e.content).join(' ');
        const allocation = tokenAllocation[period as keyof typeof tokenAllocation];
        const summary = await this.summarizeContent(periodText, allocation);
        summaries.push(`${period}: ${summary.compressedContent}`);
      }
    }
    
    const compressedContent = summaries.join(' ');
    const lossEstimate = 0.3; // Lower loss for temporal compression
    
    return { compressedContent, lossEstimate };
  }

  /**
   * Estimate token count for text
   */
  private static estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Get recommended compression strategy based on content type
   */
  static getRecommendedStrategy(
    contentType: 'conversation' | 'facts' | 'preferences' | 'general',
    originalTokens: number,
    targetTokens: number
  ): CompressionStrategy {
    const compressionRatio = targetTokens / originalTokens;
    
    // Heavy compression needed
    if (compressionRatio < 0.3) {
      return CompressionStrategy.KEYWORD_EXTRACT;
    }
    
    // Medium compression
    if (compressionRatio < 0.6) {
      switch (contentType) {
        case 'conversation':
          return CompressionStrategy.TEMPORAL_COMPRESS;
        case 'facts':
          return CompressionStrategy.SUMMARIZE;
        case 'preferences':
          return CompressionStrategy.KEYWORD_EXTRACT;
        default:
          return CompressionStrategy.SEMANTIC_CLUSTER;
      }
    }
    
    // Light compression
    return CompressionStrategy.SUMMARIZE;
  }
}