import { EmbeddingProvider, EmbeddingConfig } from '../types';
import { OpenAIEmbeddingProvider } from './openai';
import { OllamaEmbeddingProvider } from './ollama';

export const embeddingProviders = {
  openai: OpenAIEmbeddingProvider,
  ollama: OllamaEmbeddingProvider
} as const;

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  const ProviderClass = embeddingProviders[config.provider as keyof typeof embeddingProviders];
  
  if (!ProviderClass) {
    const availableProviders = Object.keys(embeddingProviders).join(', ');
    throw new Error(`Unsupported embedding provider: ${config.provider}. Available providers: ${availableProviders}`);
  }
  
  return new ProviderClass(config);
}

export * from './openai';
export * from './ollama';
export type { EmbeddingProvider } from '../types';