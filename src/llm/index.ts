import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from './types';
import { getProviderForModel, getSupportedModelsList } from './models';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';

export class LLM {
  private providers: Map<string, LLMProvider> = new Map();

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders() {
    try {
      this.providers.set('openai', new OpenAIProvider());
    } catch (e) {
      // OpenAI provider not available
    }

    try {
      this.providers.set('claude', new ClaudeProvider());
    } catch (e) {
      // Claude provider not available
    }

    try {
      this.providers.set('gemini', new GeminiProvider());
    } catch (e) {
      // Gemini provider not available
    }

    try {
      this.providers.set('ollama', new OllamaProvider());
    } catch (e) {
      // Ollama provider not available
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

    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new Error(`Provider ${providerType} not available. Check your API keys and configuration.`);
    }

    return provider;
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
export { OpenAIProvider, ClaudeProvider, GeminiProvider, OllamaProvider };