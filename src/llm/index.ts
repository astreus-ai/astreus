import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from './types';
import { getProviderForModel, getSupportedModelsList } from './models';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';
import { getLogger } from '../logger';

export class LLM {
  private providers: Map<string, LLMProvider> = new Map();
  private logger = getLogger();

  constructor() {
    // No longer initialize all providers upfront
  }

  private initializeProvider(providerName: string): LLMProvider {
    if (this.providers.has(providerName)) {
      return this.providers.get(providerName)!;
    }

    try {
      let provider: LLMProvider;
      
      switch (providerName) {
        case 'openai':
          provider = new OpenAIProvider();
          break;
        case 'claude':
          provider = new ClaudeProvider();
          break;
        case 'gemini':
          provider = new GeminiProvider();
          break;
        case 'ollama':
          provider = new OllamaProvider();
          break;
        default:
          throw new Error(`Unsupported provider: ${providerName}`);
      }
      
      this.providers.set(providerName, provider);
      this.logger.debug(`Initialized provider: ${providerName}`);
      
      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.log('error', `Failed to initialize provider: ${providerName}`, 'LLM', { error: message });
      throw new Error(`Provider ${providerName} initialization failed: ${message}`);
    }
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const provider = this.getProviderForModel(options.model);
    return provider.generateResponse(options);
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const provider = this.getProviderForModel(options.model);
    yield* provider.generateStreamResponse(options);
  }

  getSupportedModels(): string[] {
    return getSupportedModelsList();
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  private getProviderForModel(model: string): LLMProvider {
    const providerType = getProviderForModel(model);
    
    if (!providerType) {
      throw new Error(`Unsupported model: ${model}. Supported models: ${this.getSupportedModels().join(', ')}`);
    }

    // Lazy initialize the provider when first needed
    return this.initializeProvider(providerType);
  }
}

// Singleton instance
let llm: LLM | null = null;

export function getLLM(): LLM {
  if (!llm) {
    llm = new LLM();
  }
  return llm;
}

// Export types and utilities
export * from './types';
export * from './models';
export * from './embeddings';
export { OpenAIProvider, ClaudeProvider, GeminiProvider, OllamaProvider };