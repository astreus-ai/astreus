import OpenAI from 'openai';
import { EmbeddingProvider, EmbeddingConfig } from '../types';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly supportedModels = [
    'text-embedding-3-small',
    'text-embedding-3-large', 
    'text-embedding-ada-002'
  ];

  private client: OpenAI;
  private model: string;

  constructor(config: EmbeddingConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: config.baseURL
    });
    
    this.model = config.model || 'text-embedding-3-small';
    
    if (!this.supportedModels.includes(this.model)) {
      throw new Error(`Unsupported OpenAI embedding model: ${this.model}. Supported models: ${this.supportedModels.join(', ')}`);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      encoding_format: 'float'
    });

    return response.data.map(item => item.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }

  async getDimensions(model?: string): Promise<number> {
    const targetModel = model || this.model;
    
    // OpenAI embedding dimensions
    switch (targetModel) {
      case 'text-embedding-3-small':
        return 1536;
      case 'text-embedding-3-large':
        return 3072;
      case 'text-embedding-ada-002':
        return 1536;
      default:
        throw new Error(`Unknown dimensions for model: ${targetModel}`);
    }
  }
}