import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from './types';
import { getProviderForModel, getSupportedModelsList } from './models';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';
import { Logger } from '../logger/types';

export class LLM {
  private providers: Map<string, LLMProvider> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || { 
      info: () => {}, 
      debug: () => {}, 
      warn: () => {}, 
      error: () => {},
      success: () => {},
      setLevel: () => {},
      setDebug: () => {}
    } as Logger;
    
    // User-facing info log
    this.logger.info('LLM service initialized');
    
    this.logger.debug('LLM service initialized', {
      providersInitialized: 0,
      supportedModels: this.getSupportedModels().length
    });
  }

  private initializeProvider(providerName: string): LLMProvider {
    if (this.providers.has(providerName)) {
      this.logger.debug('Provider already initialized', { providerName });
      return this.providers.get(providerName)!;
    }

    // User-facing info log
    this.logger.info(`Initializing ${providerName} provider`);

    try {
      let provider: LLMProvider;
      
      this.logger.debug('Creating provider instance', { 
        providerName,
        existingProviders: Array.from(this.providers.keys())
      });
      
      switch (providerName) {
        case 'openai':
          provider = new OpenAIProvider({ logger: this.logger });
          break;
        case 'claude':
          provider = new ClaudeProvider({ logger: this.logger });
          break;
        case 'gemini':
          provider = new GeminiProvider({ logger: this.logger });
          break;
        case 'ollama':
          provider = new OllamaProvider({ logger: this.logger });
          break;
        default:
          throw new Error(`Unsupported provider: ${providerName}`);
      }
      
      this.providers.set(providerName, provider);
      
      // User-facing success message
      this.logger.info(`${providerName} provider ready`);
      
      this.logger.debug('Provider initialized successfully', { 
        providerName,
        totalProviders: this.providers.size
      });
      
      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      
      // User-facing error message
      this.logger.error(`Failed to initialize ${providerName} provider`);
      
      this.logger.debug('Provider initialization failed', { 
        providerName,
        error: message,
        hasStack: error instanceof Error && !!error.stack
      });
      
      throw new Error(`Provider ${providerName} initialization failed: ${message}`);
    }
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    // User-facing info log
    this.logger.info(`Generating response with ${options.model}`);
    
    this.logger.debug('Generating LLM response', {
      model: options.model,
      messageCount: options.messages.length,
      temperature: options.temperature || 0.7,
      maxTokens: options.maxTokens || 2000,
      stream: !!options.stream,
      hasSystemPrompt: !!options.systemPrompt
    });
    
    const provider = this.getProviderForModel(options.model);
    const response = await provider.generateResponse(options);
    
    // User-facing success message
    this.logger.info(`Response generated (${response.content.length} chars)`);
    
    this.logger.debug('LLM response generated', {
      model: response.model,
      contentLength: response.content.length,
      promptTokens: response.usage?.promptTokens || 0,
      completionTokens: response.usage?.completionTokens || 0,
      totalTokens: response.usage?.totalTokens || 0,
      hasToolCalls: !!response.toolCalls?.length
    });
    
    return response;
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    // User-facing info log
    this.logger.info(`Starting stream response with ${options.model}`);
    
    this.logger.debug('Generating streaming LLM response', {
      model: options.model,
      messageCount: options.messages.length,
      temperature: options.temperature || 0.7,
      maxTokens: options.maxTokens || 2000,
      hasSystemPrompt: !!options.systemPrompt
    });
    
    const provider = this.getProviderForModel(options.model);
    let chunkCount = 0;
    let totalContent = '';
    
    try {
      for await (const chunk of provider.generateStreamResponse(options)) {
        chunkCount++;
        totalContent += chunk.content;
        yield chunk;
      }
      
      // User-facing completion message
      this.logger.info(`Stream completed (${chunkCount} chunks, ${totalContent.length} chars)`);
      
      this.logger.debug('Streaming response completed', {
        model: options.model,
        chunkCount,
        totalContentLength: totalContent.length
      });
    } catch (error) {
      // User-facing error message
      this.logger.error('Stream response failed');
      
      this.logger.debug('Streaming response failed', {
        model: options.model,
        chunkCount,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  getSupportedModels(): string[] {
    const models = getSupportedModelsList();
    
    this.logger.debug('Retrieved supported models', {
      modelCount: models.length,
      models: models.slice(0, 10) // Log first 10 models to avoid clutter
    });
    
    return models;
  }

  getAvailableProviders(): string[] {
    const providers = Array.from(this.providers.keys());
    
    this.logger.debug('Retrieved available providers', {
      providerCount: providers.length,
      providers
    });
    
    return providers;
  }

  private getProviderForModel(model: string): LLMProvider {
    this.logger.debug('Looking up provider for model', { model });
    
    const providerType = getProviderForModel(model);
    
    if (!providerType) {
      // User-facing error message
      this.logger.error(`Unsupported model: ${model}`);
      
      this.logger.debug('Model not supported', {
        requestedModel: model,
        supportedModels: this.getSupportedModels()
      });
      
      throw new Error(`Unsupported model: ${model}. Supported models: ${this.getSupportedModels().join(', ')}`);
    }

    this.logger.debug('Provider found for model', {
      model,
      providerType,
      isProviderInitialized: this.providers.has(providerType)
    });

    // Lazy initialize the provider when first needed
    return this.initializeProvider(providerType);
  }
}

// Singleton instances per logger
const llmInstances: Map<Logger | undefined, LLM> = new Map();

export function getLLM(logger?: Logger): LLM {
  if (!llmInstances.has(logger)) {
    llmInstances.set(logger, new LLM(logger));
  }
  return llmInstances.get(logger)!;
}

export async function getLLMProvider(providerName: string, config?: { apiKey?: string; baseUrl?: string | null; logger?: Logger }): Promise<LLMProvider> {
  let provider: LLMProvider;
  
  switch (providerName) {
    case 'openai':
      provider = new OpenAIProvider(config);
      break;
    case 'claude':
      provider = new ClaudeProvider(config);
      break;
    case 'gemini':
      provider = new GeminiProvider(config);
      break;
    case 'ollama':
      provider = new OllamaProvider(config);
      break;
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }
  
  return provider;
}

// Export types and utilities
export * from './types';
export * from './models';
export { OpenAIProvider, ClaudeProvider, GeminiProvider, OllamaProvider };

