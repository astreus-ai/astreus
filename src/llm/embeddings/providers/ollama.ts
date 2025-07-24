import { Ollama } from 'ollama';
import { EmbeddingProvider, EmbeddingConfig } from '../types';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly supportedModels = [
    'nomic-embed-text',
    'mxbai-embed-large',
    'all-minilm',
    'snowflake-arctic-embed'
  ];

  private client: Ollama;
  private model: string;
  private modelPulled: boolean = false;

  constructor(config: EmbeddingConfig) {
    this.client = new Ollama({
      host: config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    });
    
    this.model = config.model || 'nomic-embed-text';
    
    if (!this.supportedModels.includes(this.model)) {
      throw new Error(`Unsupported Ollama embedding model: ${this.model}. Supported models: ${this.supportedModels.join(', ')}`);
    }
  }

  private async ensureModelAvailable(): Promise<void> {
    if (this.modelPulled) return;
    
    try {
      // Try to use the model first
      await this.client.embeddings({
        model: this.model,
        prompt: 'test'
      });
      this.modelPulled = true;
    } catch (error) {
      // If model not found, try to pull it
      if (error instanceof Error && error.message.includes('not found')) {
        console.log(`Model ${this.model} not found, pulling...`);
        try {
          await this.client.pull({ model: this.model });
          console.log(`Successfully pulled model: ${this.model}`);
          this.modelPulled = true;
        } catch (pullError) {
          throw new Error(`Failed to pull model ${this.model}: ${pullError instanceof Error ? pullError.message : 'Unknown error'}`);
        }
      } else {
        throw error;
      }
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ensureModelAvailable();
    
    const embeddings: number[][] = [];
    
    for (const text of texts) {
      const response = await this.client.embeddings({
        model: this.model,
        prompt: text
      });
      
      embeddings.push(response.embedding);
    }
    
    return embeddings;
  }

  async embedSingle(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }

  async getDimensions(model?: string): Promise<number> {
    const targetModel = model || this.model;
    
    // Ollama embedding dimensions
    switch (targetModel) {
      case 'nomic-embed-text':
        return 768;
      case 'mxbai-embed-large':
        return 1024;
      case 'all-minilm':
        return 384;
      case 'snowflake-arctic-embed':
        return 1024;
      default:
        // Try to get dimensions from Ollama API
        try {
          await this.ensureModelAvailable();
          const response = await this.client.embeddings({
            model: targetModel,
            prompt: 'test'
          });
          return response.embedding.length;
        } catch {
          throw new Error(`Unknown dimensions for model: ${targetModel}`);
        }
    }
  }
}