export interface EmbeddingConfig {
  provider: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  dimensions?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly supportedModels: string[];
  
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
  getDimensions(model?: string): Promise<number>;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  usage?: {
    totalTokens: number;
  };
}