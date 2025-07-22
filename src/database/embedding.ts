import OpenAI from 'openai';
import { Ollama } from 'ollama';

export interface EmbeddingConfig {
  provider: 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
  baseURL?: string;
}

export class EmbeddingService {
  private config: EmbeddingConfig;
  private openai?: OpenAI;
  private ollama?: Ollama;

  constructor(config?: EmbeddingConfig) {
    this.config = config || this.getConfigFromEnv();
    
    if (this.config.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: this.config.apiKey || process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
        baseURL: this.config.baseURL
      });
    } else {
      this.ollama = new Ollama({
        host: this.config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
      });
    }
  }

  private getConfigFromEnv(): EmbeddingConfig {
    const provider = process.env.EMBEDDING_PROVIDER as 'openai' | 'ollama' || 'openai';
    
    return {
      provider,
      model: process.env.EMBEDDING_MODEL || (provider === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text'),
      apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: provider === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') : undefined
    };
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(text) ? text : [text];
    
    if (this.config.provider === 'openai') {
      return this.embedWithOpenAI(texts);
    } else {
      return this.embedWithOllama(texts);
    }
  }

  private async embedWithOpenAI(texts: string[]): Promise<number[][]> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await this.openai.embeddings.create({
      model: this.config.model || 'text-embedding-3-small',
      input: texts,
      encoding_format: 'float'
    });

    return response.data.map(item => item.embedding);
  }

  private async embedWithOllama(texts: string[]): Promise<number[][]> {
    if (!this.ollama) {
      throw new Error('Ollama client not initialized');
    }

    const embeddings: number[][] = [];
    
    for (const text of texts) {
      const response = await this.ollama.embeddings({
        model: this.config.model || 'nomic-embed-text',
        prompt: text
      });
      
      embeddings.push(response.embedding);
    }
    
    return embeddings;
  }

  async embedSingle(text: string): Promise<number[]> {
    const [embedding] = await this.embed(text);
    return embedding;
  }
}