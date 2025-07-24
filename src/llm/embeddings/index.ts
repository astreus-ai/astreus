import { EmbeddingConfig, EmbeddingProvider } from './types';
import { createEmbeddingProvider } from './providers';

export class EmbeddingService {
  private provider: EmbeddingProvider;
  private config: EmbeddingConfig;

  constructor(config?: EmbeddingConfig) {
    this.config = config || this.getConfigFromEnv();
    this.provider = createEmbeddingProvider(this.config);
  }

  private getConfigFromEnv(): EmbeddingConfig {
    const provider = process.env.EMBEDDING_PROVIDER || 'openai';
    
    return {
      provider,
      model: process.env.EMBEDDING_MODEL || (provider === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text'),
      apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: provider === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') : undefined
    };
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(text) ? text : [text];
    return this.provider.embed(texts);
  }

  async embedSingle(text: string): Promise<number[]> {
    return this.provider.embedSingle(text);
  }

  async getDimensions(model?: string): Promise<number> {
    return this.provider.getDimensions(model);
  }

  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  getSupportedModels(): string[] {
    return this.provider.supportedModels;
  }
}

// Export types and providers
export * from './types';
export * from './providers';

// Legacy compatibility 
export type { EmbeddingConfig } from './types';