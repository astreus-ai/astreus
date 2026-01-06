import {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  LLMMessage,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  EmbeddingResult,
} from '../types';
import OpenAI from 'openai';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import { LLMApiError, VisionError } from '../../errors';
import * as fs from 'fs';
import * as path from 'path';

// Retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
      }
    }
  }
  if (!lastError) {
    throw new Error('No retry attempts made');
  }
  throw lastError;
}

// OpenAI-specific message type that accepts string arguments for tool calls
interface OpenAIMessage extends Omit<LLMMessage, 'tool_calls'> {
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string; // OpenAI requires string, not our Record type
    };
  }>;
}

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private embeddingClient: OpenAI;
  private visionClient: OpenAI;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;

    // Use provided logger or fallback to global logger
    this.logger = config?.logger || getLogger();

    if (!apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable.');
    }

    this.logger.info('OpenAI provider initialized');
    this.logger.debug('OpenAI provider initialization', {
      hasCustomBaseUrl: !!config?.baseUrl,
      hasEmbeddingBaseUrl: !!process.env.OPENAI_EMBEDDING_BASE_URL,
      hasVisionBaseUrl: !!process.env.OPENAI_VISION_BASE_URL,
      supportsEmbeddings: true,
      supportsVision: true,
    });

    // Default timeout: 2 minutes (120000ms)
    const timeout = config?.timeout ?? 120000;

    // Main client for chat completions (can use custom base URL like OpenRouter)
    // If baseUrl is explicitly null, don't use OPENAI_BASE_URL fallback (for embedding/vision providers)
    const chatBaseUrl =
      config?.baseUrl === null ? undefined : config?.baseUrl || process.env.OPENAI_BASE_URL;
    this.client = new OpenAI({
      apiKey,
      timeout,
      ...(chatBaseUrl && { baseURL: chatBaseUrl }),
    });

    // Dedicated embedding client - NO fallback to OPENAI_BASE_URL
    const embeddingApiKey = process.env.OPENAI_EMBEDDING_API_KEY || apiKey;
    const embeddingBaseUrl = process.env.OPENAI_EMBEDDING_BASE_URL; // Only dedicated URL, no fallback

    this.logger.debug('Creating embedding client', {
      hasEmbeddingApiKey: !!embeddingApiKey,
      usingDedicatedKey: !!process.env.OPENAI_EMBEDDING_API_KEY,
      hasDedicatedBaseUrl: !!embeddingBaseUrl,
      willUseDefaultEndpoint: !embeddingBaseUrl,
    });

    // Create embedding client with COMPLETELY isolated configuration
    const embeddingClientConfig: { apiKey: string; baseURL?: string; timeout: number } = {
      apiKey: embeddingApiKey,
      timeout,
    };

    // Only add baseURL if we have a dedicated one, otherwise OpenAI client will use default
    if (embeddingBaseUrl) {
      embeddingClientConfig.baseURL = embeddingBaseUrl;
    } else {
      // Explicitly prevent OpenAI SDK from reading OPENAI_BASE_URL environment variable
      embeddingClientConfig.baseURL = 'https://api.openai.com/v1';
    }

    this.embeddingClient = new OpenAI(embeddingClientConfig);

    // Dedicated vision client - NO fallback to OPENAI_BASE_URL
    const visionApiKey = process.env.OPENAI_VISION_API_KEY || apiKey;
    const visionBaseUrl = process.env.OPENAI_VISION_BASE_URL; // Only dedicated URL, no fallback

    // Create vision client with COMPLETELY isolated configuration
    const visionClientConfig: { apiKey: string; baseURL?: string; timeout: number } = {
      apiKey: visionApiKey,
      timeout,
    };

    // Only add baseURL if we have a dedicated one, otherwise OpenAI client will use default
    if (visionBaseUrl) {
      visionClientConfig.baseURL = visionBaseUrl;
    } else {
      // Explicitly prevent OpenAI SDK from reading OPENAI_BASE_URL environment variable
      visionClientConfig.baseURL = 'https://api.openai.com/v1';
    }

    this.visionClient = new OpenAI(visionClientConfig);
  }

  private safeJsonParse(jsonString: string): Record<string, string | number | boolean | null> {
    try {
      const parsed = JSON.parse(jsonString);
      // Ensure all values are of allowed types
      const sanitized: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          sanitized[key] = value;
        } else {
          sanitized[key] = String(value); // Convert complex types to string
        }
      }
      return sanitized;
    } catch {
      this.logger.warn('Failed to parse tool call arguments', { jsonString });
      return {}; // Return empty object as fallback
    }
  }

  getSupportedModels(): string[] {
    return [
      'gpt-4.5',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o4-mini',
      'o4-mini-high',
      'o3',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
      'gpt-3.5-turbo-instruct',
    ];
  }

  getVisionModels(): string[] {
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4-vision-preview',
      'gpt-4o-2024-08-06',
      'gpt-4o-2024-05-13',
    ];
  }

  getEmbeddingModels(): string[] {
    return ['text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002'];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.prepareMessages(options);

    try {
      const completion = await withRetry(() =>
        this.client.chat.completions.create({
          model: options.model,
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4096,
          stream: false,
          ...(options.tools &&
            options.tools.length > 0 && {
              tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
              tool_choice: 'auto',
            }),
        })
      );

      const message = completion.choices[0]?.message;

      return {
        content: message?.content || '',
        model: completion.model,
        toolCalls: message?.tool_calls?.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === 'string'
                ? this.safeJsonParse(tc.function.arguments)
                : tc.function.arguments,
          },
        })),
        usage: {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
        },
      };
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('OpenAI generateResponse failed', originalError, {
        model: options.model,
        errorMessage: originalError.message,
      });
      throw new LLMApiError(
        `OpenAI API request failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const messages = this.prepareMessages(options);

    let stream:
      | (Awaited<ReturnType<typeof this.client.chat.completions.create>> & {
          controller?: AbortController;
        })
      | undefined;
    try {
      stream = await withRetry(() =>
        this.client.chat.completions.create({
          model: options.model,
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4096,
          stream: true,
          stream_options: { include_usage: true }, // Enable usage tracking in streaming
          ...(options.tools &&
            options.tools.length > 0 && {
              tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
              tool_choice: 'auto',
            }),
        })
      );
    } catch (error: unknown) {
      // Log full error details including OpenAI API response
      const errorObj = error as Record<string, unknown>;
      this.logger.error('OpenAI API request failed', error instanceof Error ? error : undefined, {
        model: options.model,
        messageCount: messages.length,
        errorMessage: String(errorObj?.message || 'Unknown error'),
        errorType: String(errorObj?.constructor?.name || 'Unknown'),
        status: String(errorObj?.status || errorObj?.statusCode || ''),
        code: String(errorObj?.code || ''),
        type: String(errorObj?.type || ''),
        errorString: String(error),
      });
      this.logger.debug('OpenAI API error details', {
        messageCount: messages.length,
        roles: messages.map((m) => m.role).join(', '),
      });
      throw error;
    }

    const toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];

    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    // Helper function to abort stream safely
    const abortStream = (): void => {
      try {
        // OpenAI SDK streams have a controller property for aborting
        if (stream && 'controller' in stream && stream.controller instanceof AbortController) {
          stream.controller.abort();
        }
      } catch {
        // Ignore abort errors - stream may already be closed
      }
    };

    try {
      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
        const delta = chunk.choices?.[0]?.delta;
        const content = delta?.content || '';

        // Capture usage from final chunk (OpenAI includes this when stream_options.include_usage is true)
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }

        // Handle tool calls in streaming
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  id: tc.id || '',
                  type: tc.type || 'function',
                  function: {
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  },
                };
              } else {
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          }
        }

        if (content) {
          yield { content, done: false, model: chunk.model };
        }
      }

      // Final chunk with tool calls and usage
      yield {
        content: '',
        done: true,
        model: options.model,
        toolCalls:
          toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.function.name,
                  arguments:
                    typeof tc.function.arguments === 'string'
                      ? this.safeJsonParse(tc.function.arguments)
                      : tc.function.arguments,
                },
              }))
            : undefined,
        usage,
      };
    } catch (error) {
      // Abort the stream on error to prevent resource leak
      abortStream();

      // Log full error details for debugging
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        'OpenAI streaming error details',
        new Error(`${originalError.message} - ${JSON.stringify(error, null, 2)}`)
      );

      throw new LLMApiError(
        `OpenAI streaming error: ${originalError.message}`,
        this.name,
        originalError
      );
    } finally {
      // Ensure stream is aborted when generator is closed early (consumer breaks out of loop)
      abortStream();
    }
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

    this.logger.info(`Generating embedding with model: ${embeddingModel}`);
    this.logger.debug('OpenAI embedding request', {
      model: embeddingModel,
      textLength: text.length,
    });

    try {
      const response = await withRetry(() =>
        this.embeddingClient.embeddings.create({
          model: embeddingModel,
          input: text,
          encoding_format: 'float',
        })
      );

      const embeddingData = response.data[0]?.embedding;
      if (!embeddingData) {
        throw new Error('No embedding data returned from OpenAI API');
      }

      const result: EmbeddingResult = {
        embedding: embeddingData,
        model: embeddingModel,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      };

      this.logger.info('Embedding generated successfully');
      this.logger.debug('OpenAI embedding result', {
        model: embeddingModel,
        dimensions: result.embedding.length,
        promptTokens: result.usage?.promptTokens ?? 0,
      });

      return result;
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Embedding generation failed');
      this.logger.debug('OpenAI embedding error', {
        model: embeddingModel,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });
      throw new LLMApiError(
        `OpenAI embedding generation failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const fileName = path.basename(imagePath);

    this.logger.info(`Analyzing image: ${fileName}`);
    this.logger.debug('OpenAI image analysis started', {
      imagePath,
      fileName,
      hasPrompt: !!options.prompt,
      detail: options.detail || 'auto',
      maxTokens: options.maxTokens || 1000,
    });

    // Validate image file
    try {
      await fs.promises.access(imagePath);
    } catch {
      this.logger.error(`Image file not found: ${imagePath}`);
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const ext = path.extname(imagePath).toLowerCase();
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    if (!supportedFormats.includes(ext)) {
      this.logger.error(`Unsupported image format: ${ext}`);
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`
      );
    }

    // Read and encode image
    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = this.getMimeType(ext);
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    return this.analyzeImageFromBase64(dataUrl, options);
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.info('Analyzing base64 image');
    this.logger.debug('OpenAI base64 image analysis started', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      detail: options.detail || 'auto',
      maxTokens: options.maxTokens || 1000,
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      const response = await withRetry(() =>
        this.visionClient.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: base64Data,
                    detail: options.detail || 'auto',
                  },
                },
              ],
            },
          ],
          max_tokens: options.maxTokens ?? 1000,
          temperature: options.temperature ?? 0.1,
        })
      );

      const processingTime = Date.now() - startTime;
      const content = response.choices[0]?.message?.content || 'No analysis available';

      const result: VisionAnalysisResult = {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
              }
            : undefined,
        },
      };

      this.logger.info('Image analysis completed');
      this.logger.debug('OpenAI image analysis result', {
        model,
        processingTime,
        contentLength: content.length,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error(String(error));

      this.logger.error('Image analysis failed');
      this.logger.debug('OpenAI image analysis error', {
        processingTime,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });

      throw new VisionError(
        `OpenAI vision analysis failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
    };

    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
  }

  private prepareMessages(options: LLMRequestOptions): OpenAIMessage[] {
    const messages = [...options.messages];

    // Add system prompt if provided and no system message exists
    if (options.systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }

    // Ensure tool_calls arguments are serialized as strings for OpenAI API
    const processedMessages: OpenAIMessage[] = messages.map((message): OpenAIMessage => {
      if (message.role === 'assistant' && message.tool_calls) {
        return {
          ...message,
          tool_calls: message.tool_calls.map((tc) => ({
            ...tc,
            function: {
              ...tc.function,
              arguments:
                typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
            },
          })),
        };
      }
      return message as OpenAIMessage;
    });

    return processedMessages;
  }

  getEmbeddingProvider(): LLMProvider {
    return {
      name: 'openai-embedding',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: () => [],
      getEmbeddingModels: this.getEmbeddingModels.bind(this),
      generateEmbedding: async (text: string, model?: string) => {
        // Use the dedicated embedding client that was created with correct API key and base URL
        const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

        this.logger.debug('Using dedicated embedding client', {
          model: embeddingModel,
          clientHasBaseURL: 'baseURL' in this.embeddingClient,
          clientBaseURL: (this.embeddingClient as { baseURL?: string }).baseURL || 'none',
          clientApiKey: '[REDACTED]',
        });

        const response = await this.embeddingClient.embeddings.create({
          model: embeddingModel,
          input: text,
          encoding_format: 'float',
        });

        const embeddingData = response.data[0]?.embedding;
        if (!embeddingData) {
          throw new Error('No embedding data returned from OpenAI API');
        }

        return {
          embedding: embeddingData,
          model: embeddingModel,
          usage: {
            promptTokens: response.usage?.prompt_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
          },
        };
      },
    };
  }

  getVisionProvider(): LLMProvider {
    return {
      name: 'openai-vision',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: this.getVisionModels.bind(this),
      getEmbeddingModels: () => [],
      analyzeImage: async (imagePath: string, options?: VisionAnalysisOptions) => {
        const imageBuffer = await fs.promises.readFile(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = this.getMimeType(ext);
        const dataUrl = `data:${mimeType};base64,${base64Image}`;

        return this.analyzeImageFromBase64WithClient(dataUrl, options, this.visionClient);
      },
      analyzeImageFromBase64: async (base64Data: string, options?: VisionAnalysisOptions) => {
        return this.analyzeImageFromBase64WithClient(base64Data, options, this.visionClient);
      },
    };
  }

  private async analyzeImageFromBase64WithClient(
    base64Data: string,
    options: VisionAnalysisOptions = {},
    client: OpenAI
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.debug('Using dedicated vision client', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      clientHasBaseURL: 'baseURL' in client,
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      const response = await withRetry(() =>
        client.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: base64Data,
                    detail: options.detail || 'auto',
                  },
                },
              ],
            },
          ],
          max_tokens: options.maxTokens ?? 1000,
          temperature: options.temperature ?? 0.1,
        })
      );

      const processingTime = Date.now() - startTime;
      const content = response.choices[0]?.message?.content || 'No analysis available';

      return {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
              }
            : undefined,
        },
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error(String(error));

      this.logger.error('OpenAI image analysis failed');
      this.logger.debug('OpenAI image analysis error', {
        processingTime,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });

      throw new VisionError(
        `OpenAI vision analysis failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }
}
