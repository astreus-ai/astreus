import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk } from './types';
import { getProviderForModel, getSupportedModelsList } from './models';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { DEFAULT_LLM_CONFIG } from './defaults';

export class LLM {
  private providers: Map<string, LLMProvider> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || getLogger();

    // User-facing info log
    this.logger.info('LLM service initialized');

    this.logger.debug('LLM service initialized', {
      providersInitialized: 0,
      supportedModels: this.getSupportedModels().length,
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
        existingProviders: Array.from(this.providers.keys()),
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
        totalProviders: this.providers.size,
      });

      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // User-facing error message
      this.logger.error(`Failed to initialize ${providerName} provider`);

      this.logger.debug('Provider initialization failed', {
        providerName,
        error: message,
        hasStack: error instanceof Error && !!error.stack,
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
      temperature: options.temperature || DEFAULT_LLM_CONFIG.defaultTemperature,
      maxTokens: options.maxTokens || DEFAULT_LLM_CONFIG.defaultMaxTokens,
      stream: !!options.stream,
      hasSystemPrompt: !!options.systemPrompt,
    });

    const provider = this.getProviderForModel(options.model);
    const response = await provider.generateResponse(options);

    // User-facing success message
    if (response.content.length === 0 && response.toolCalls && response.toolCalls.length > 0) {
      this.logger.info(
        `Tools called: ${response.toolCalls.map((tc) => tc.function.name).join(', ')}`
      );
    } else {
      this.logger.info(`Response generated (${response.content.length} chars)`);
    }

    this.logger.debug('LLM response generated', {
      model: response.model,
      contentLength: response.content.length,
      promptTokens: response.usage?.promptTokens || 0,
      completionTokens: response.usage?.completionTokens || 0,
      totalTokens: response.usage?.totalTokens || 0,
      hasToolCalls: !!response.toolCalls?.length,
    });

    return response;
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    // User-facing info log
    this.logger.info(`Starting stream response with ${options.model}`);

    this.logger.debug('Generating streaming LLM response', {
      model: options.model,
      messageCount: options.messages.length,
      temperature: options.temperature || DEFAULT_LLM_CONFIG.defaultTemperature,
      maxTokens: options.maxTokens || DEFAULT_LLM_CONFIG.defaultMaxTokens,
      hasSystemPrompt: !!options.systemPrompt,
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
        totalContentLength: totalContent.length,
      });
    } catch (error) {
      // User-facing error message
      this.logger.error('Stream response failed');

      this.logger.debug('Streaming response failed', {
        model: options.model,
        chunkCount,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  getSupportedModels(): string[] {
    const models = getSupportedModelsList();

    this.logger.debug('Retrieved supported models', {
      modelCount: models.length,
      models: models.slice(0, 10), // Log first 10 models to avoid clutter
    });

    return models;
  }

  getAvailableProviders(): string[] {
    const providers = Array.from(this.providers.keys());

    this.logger.debug('Retrieved available providers', {
      providerCount: providers.length,
      providers,
    });

    return providers;
  }

  async generateEmbedding(text: string, model?: string): Promise<{ embedding: number[] }> {
    const modelToUse = model || 'text-embedding-ada-002';
    const provider = this.getProviderForModel(modelToUse);

    if (!provider.generateEmbedding) {
      throw new Error(`Provider for model ${modelToUse} does not support embedding generation`);
    }

    const result = await provider.generateEmbedding(text, modelToUse);
    return { embedding: result.embedding };
  }

  private getProviderForModel(model: string): LLMProvider {
    this.logger.debug('Looking up provider for model', { model });

    const providerType = getProviderForModel(model);

    if (!providerType) {
      // User-facing error message
      this.logger.error(`Unsupported model: ${model}`);

      this.logger.debug('Model not supported', {
        requestedModel: model,
        supportedModels: this.getSupportedModels(),
      });

      throw new Error(
        `Unsupported model: ${model}. Supported models: ${this.getSupportedModels().join(', ')}`
      );
    }

    this.logger.debug('Provider found for model', {
      model,
      providerType,
      isProviderInitialized: this.providers.has(providerType),
    });

    // Lazy initialize the provider when first needed
    return this.initializeProvider(providerType);
  }
}

// Singleton instances per logger with cleanup mechanism
const llmInstances: Map<Logger | undefined, LLM> = new Map();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_INSTANCES = 50; // Prevent unlimited growth

// Cleanup old instances periodically
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanupTimer() {
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      // Keep only recent instances, remove old ones
      if (llmInstances.size > MAX_INSTANCES) {
        const entries = Array.from(llmInstances.entries());
        // Keep the last MAX_INSTANCES/2 entries
        const toKeep = entries.slice(-Math.floor(MAX_INSTANCES / 2));
        llmInstances.clear();
        toKeep.forEach(([key, value]) => llmInstances.set(key, value));
      }
    }, CLEANUP_INTERVAL);

    // Ensure cleanup on process exit
    process.on('beforeExit', () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      llmInstances.clear();
    });
  }
}

export function getLLM(logger?: Logger): LLM {
  startCleanupTimer();

  if (!llmInstances.has(logger)) {
    llmInstances.set(logger, new LLM(logger));
  }
  return llmInstances.get(logger)!;
}

// Manual cleanup function for testing or explicit cleanup
export function clearLLMInstances(): void {
  llmInstances.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export async function getLLMProvider(
  providerName: string,
  config?: { apiKey?: string; baseUrl?: string | null; logger?: Logger }
): Promise<LLMProvider> {
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
