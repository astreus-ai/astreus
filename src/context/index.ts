import { Knex } from 'knex';
import { IAgentModule, IAgent } from '../agent/types';
import { getDatabase } from '../database';
import { getLLM } from '../llm';
import { MetadataObject } from '../types';
import { 
  ContextConfig, 
  ContextLayer, 
  ContextWindow, 
  CompressionResult
} from './types';


export class Context implements IAgentModule {
  readonly name = 'context';
  private knex: Knex;
  private config: Required<ContextConfig>;
  private window: ContextWindow;
  private maxTokens: number;
  private compression: boolean;
  private model: string;
  private temperature: number;
  private initialized: boolean = false;

  constructor(private agent: IAgent, maxTokens: number = 4000, compression: boolean = true, model: string = 'gpt-4o-mini', temperature: number = 0.3, config: ContextConfig = {}) {
    this.maxTokens = maxTokens;
    this.compression = compression;
    this.model = model;
    this.temperature = temperature;
    // Note: knex will be initialized in initialize() method
    this.knex = null!; // Will be initialized in initialize()
    
    // Set defaults
    this.config = {
      layerWeights: {
        immediate: 0.4,
        summarized: 0.35,
        persistent: 0.25,
        ...config.layerWeights
      }
    };

    // Initialize context window
    this.window = {
      layers: {
        immediate: [],
        summarized: [],
        persistent: []
      },
      totalTokens: 0,
      maxTokens: this.maxTokens,
      config: this.config
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const db = await getDatabase();
    this.knex = db.getKnex();
    await this.initializeContextTable();
    this.initialized = true;
  }


  private async initializeContextTable(): Promise<void> {
    // Contexts table is now shared and initialized in the main database module
    // This method is kept for compatibility but does nothing
  }

  // Add content to context
  async addContext(
    layer: 'immediate' | 'summarized' | 'persistent',
    content: string,
    priority: number = 0,
    metadata?: MetadataObject
  ): Promise<void> {
    await this.initialize();
    const tokenCount = this.estimateTokens(content);
    
    // Store in database
    await this.knex('contexts').insert({
      agentId: this.agent.id,
      layer,
      content,
      tokenCount,
      priority,
      metadata: metadata ? JSON.stringify(metadata) : null
    });

    // Add to memory window
    const contextLayer: ContextLayer = {
      content,
      tokenCount,
      priority,
      timestamp: new Date(),
      metadata
    };

    this.window.layers[layer].push(contextLayer);
    this.window.totalTokens += tokenCount;

    // Check if we need compression
    if (this.window.totalTokens > this.maxTokens) {
      await this.manageContextWindow();
    }
  }

  // Get context for LLM
  async getContext(): Promise<string> {
    await this.loadContextWindow();
    
    let context = '';
    
    // Add persistent context (most important)
    if (this.window.layers.persistent.length > 0) {
      context += '=== Important Information ===\n';
      this.window.layers.persistent
        .sort((a, b) => b.priority - a.priority)
        .forEach(layer => {
          context += `${layer.content}\n`;
        });
      context += '\n';
    }

    // Add summarized context
    if (this.window.layers.summarized.length > 0) {
      context += '=== Previous Context Summary ===\n';
      this.window.layers.summarized
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .forEach(layer => {
          context += `${layer.content}\n`;
        });
      context += '\n';
    }

    // Add immediate context (most recent)
    if (this.window.layers.immediate.length > 0) {
      context += '=== Recent Messages ===\n';
      this.window.layers.immediate
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 10) // Last 10 messages
        .reverse() // Chronological order
        .forEach(layer => {
          context += `${layer.content}\n`;
        });
    }

    return context.trim();
  }

  // Load context window from database
  private async loadContextWindow(): Promise<void> {
    await this.initialize();
    const contexts = await this.knex('contexts')
      .where({ agentId: this.agent.id })
      .orderBy('created_at', 'desc')
      .limit(100); // Limit for performance

    // Reset window
    this.window.layers = {
      immediate: [],
      summarized: [],
      persistent: []
    };
    this.window.totalTokens = 0;

    contexts.forEach(ctx => {
      const layer: ContextLayer = {
        content: ctx.content,
        tokenCount: ctx.tokenCount,
        priority: ctx.priority,
        timestamp: new Date(ctx.created_at),
        metadata: ctx.metadata ? JSON.parse(ctx.metadata) : undefined
      };

      this.window.layers[ctx.layer as keyof typeof this.window.layers].push(layer);
      this.window.totalTokens += ctx.tokenCount;
    });
  }

  // Manage context window when it exceeds limits
  private async manageContextWindow(): Promise<void> {
    const targetTokens = this.maxTokens * 0.8; // 80% of max

    // If compression is enabled, try to compress immediate context
    if (this.compression && this.window.layers.immediate.length > 5) {
      await this.compressImmediateContext();
    }

    // Remove least important content if still over limit
    while (this.window.totalTokens > targetTokens) {
      await this.removeLeastImportantContent();
    }
  }

  // Compress immediate context into summarized
  private async compressImmediateContext(): Promise<void> {
    const immediateContent = this.window.layers.immediate
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .slice(0, -3) // Keep last 3 messages immediate
      .map(layer => layer.content)
      .join('\n');

    if (!immediateContent) return;

    try {
      const compression = await this.compressContent(immediateContent);
      
      // Add compressed content to summarized layer
      await this.addContext(
        'summarized',
        compression.compressedContent,
        5, // Higher priority for summaries
        {
          type: 'compressed_summary',
          originalTokens: compression.originalTokens,
          compressionRatio: compression.compressionRatio,
          keyPoints: compression.keyPoints
        }
      );

      // Remove compressed immediate content from database
      const oldestImmediate = this.window.layers.immediate
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .slice(0, -3);

      if (oldestImmediate.length > 0) {
        await this.knex('contexts')
          .where({ agentId: this.agent.id, layer: 'immediate' })
          .whereIn('created_at', oldestImmediate.map(l => l.timestamp))
          .delete();
      }

    } catch {
      // Context compression failed, continue without compression
    }
  }

  // Compress content using LLM
  private async compressContent(content: string): Promise<CompressionResult> {
    const llm = getLLM();
    const originalTokens = this.estimateTokens(content);

    const response = await llm.generateResponse({
      model: this.model,
      messages: [{
        role: 'user',
        content: `Compress the following conversation into key points and important information. Keep it concise but preserve important details:\n\n${content}`
      }],
      temperature: this.temperature,
      maxTokens: Math.floor(originalTokens * 0.3) // Target 30% compression
    });

    const compressedTokens = this.estimateTokens(response.content);
    
    return {
      compressedContent: response.content,
      originalTokens,
      compressedTokens,
      compressionRatio: compressedTokens / originalTokens,
      keyPoints: [] // Could extract key points from response
    };
  }

  // Remove least important content
  private async removeLeastImportantContent(): Promise<void> {
    await this.initialize();
    // Find least important immediate content
    const leastImportant = this.window.layers.immediate
      .sort((a, b) => a.priority - b.priority)[0];

    if (leastImportant) {
      await this.knex('contexts')
        .where({ 
          agentId: this.agent.id, 
          layer: 'immediate',
          content: leastImportant.content 
        })
        .delete();

      // Remove from memory
      const index = this.window.layers.immediate.indexOf(leastImportant);
      this.window.layers.immediate.splice(index, 1);
      this.window.totalTokens -= leastImportant.tokenCount;
    }
  }

  // Estimate token count (rough approximation)
  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4); // Rough estimate: 4 chars = 1 token
  }

  // Get context stats
  async getContextStats(): Promise<{
    totalTokens: number;
    maxTokens: number;
    layers: {
      immediate: { count: number; tokens: number };
      summarized: { count: number; tokens: number };
      persistent: { count: number; tokens: number };
    };
  }> {
    await this.loadContextWindow();

    return {
      totalTokens: this.window.totalTokens,
      maxTokens: this.maxTokens,
      layers: {
        immediate: {
          count: this.window.layers.immediate.length,
          tokens: this.window.layers.immediate.reduce((sum, l) => sum + l.tokenCount, 0)
        },
        summarized: {
          count: this.window.layers.summarized.length,
          tokens: this.window.layers.summarized.reduce((sum, l) => sum + l.tokenCount, 0)
        },
        persistent: {
          count: this.window.layers.persistent.length,
          tokens: this.window.layers.persistent.reduce((sum, l) => sum + l.tokenCount, 0)
        }
      }
    };
  }

  // Clear context
  async clearContext(layer?: 'immediate' | 'summarized' | 'persistent'): Promise<void> {
    await this.initialize();
    let query = this.knex('contexts')
      .where({ agentId: this.agent.id });

    if (layer) {
      query = query.andWhere({ layer });
    }

    await query.delete();

    // Reset memory window
    if (layer) {
      this.window.layers[layer] = [];
    } else {
      this.window.layers = { immediate: [], summarized: [], persistent: [] };
    }
    
    await this.loadContextWindow(); // Recalculate tokens
  }
}

export * from './types';