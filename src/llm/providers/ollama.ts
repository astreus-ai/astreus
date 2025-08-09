import {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  EmbeddingResult,
  isStringContent,
} from '../types';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import * as fs from 'fs';
import * as path from 'path';

// Ollama-specific tool parameter schema (matches JSON Schema format)
interface OllamaToolSchema {
  type: string;
  properties?: Record<string, OllamaToolParameter>;
  required?: string[];
  items?: OllamaToolParameter;
  description?: string;
  enum?: Array<string | number>;
}

interface OllamaToolParameter {
  type?: string | string[];
  items?: { type: string };
  description?: string;
  enum?: Array<string | number>;
  properties?: Record<string, OllamaToolParameter>;
}
import { Ollama, Message, ChatResponse, ToolCall } from 'ollama';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private client: Ollama;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    // Use provided logger or fallback to global logger
    this.logger = config?.logger || getLogger();

    // If baseUrl is explicitly null, use default Ollama URL (for embedding/vision providers)
    const baseUrl =
      config?.baseUrl === null
        ? 'http://localhost:11434'
        : config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

    this.logger.info('Ollama provider initialized');
    this.logger.debug('Ollama provider initialization', {
      hasConfigApiKey: false, // Ollama doesn't use API keys
      hasCustomBaseUrl: !!config?.baseUrl,
      hasEnvBaseUrl: !!process.env.OLLAMA_BASE_URL,
      baseUrl: baseUrl,
      supportsEmbeddings: true,
      supportsVision: true,
    });

    this.client = new Ollama({
      host: baseUrl,
    });
  }

  getSupportedModels(): string[] {
    return [
      'deepseek-r1',
      'deepseek-v3',
      'deepseek-v2.5',
      'deepseek-coder',
      'deepseek-coder-v2',
      'qwen3',
      'qwen2.5-coder',
      'llama3.3',
      'gemma3',
      'phi4',
      'mistral-small',
      'codellama',
      'llama3.2',
      'llama3.1',
      'qwen2.5',
      'gemma2',
      'phi3',
      'mistral',
      'codegemma',
      'wizardlm2',
      'dolphin-mistral',
      'openhermes',
      'deepcoder',
      'stable-code',
      'wizardcoder',
      'magicoder',
      'solar',
      'yi',
      'zephyr',
      'orca-mini',
      'vicuna',
    ];
  }

  getVisionModels(): string[] {
    return [
      'llava',
      'llava:7b',
      'llava:13b',
      'llava:34b',
      'llava-llama3',
      'llava-phi3',
      'moondream',
    ];
  }

  getEmbeddingModels(): string[] {
    return ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.prepareMessages(options);

    const response = (await this.client.chat({
      model: options.model,
      messages,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
      stream: false,
      tools: options.tools?.map((tool) => ({
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as OllamaToolSchema,
        },
      })),
    })) as ChatResponse;

    // Extract tool calls from Ollama's response (if supported)
    const toolCalls =
      response.message?.tool_calls?.map((tc: ToolCall) => ({
        id: tc.function?.name || 'tool-call',
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || {},
        },
      })) || [];

    return {
      content: response.message?.content || '',
      model: response.model || options.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.prompt_eval_count || 0,
        completionTokens: response.eval_count || 0,
        totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
    };
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const messages = this.prepareMessages(options);

    const stream = await this.client.chat({
      model: options.model,
      messages,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
      stream: true,
      tools: options.tools?.map((tool) => ({
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as OllamaToolSchema,
        },
      })),
    });

    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, string | number | boolean | null> };
    }> = [];

    try {
      for await (const chunk of stream) {
        const content = chunk.message?.content || '';

        // Handle tool calls if present
        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            toolCalls.push({
              id: tc.function?.name || 'tool-call',
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments || {},
              },
            });
          }
        }

        if (chunk.done) {
          yield {
            content: '',
            done: true,
            model: options.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
          return;
        } else if (content) {
          yield { content, done: false, model: options.model };
        }
      }
    } catch (error) {
      throw new Error(
        `Ollama streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private prepareMessages(options: LLMRequestOptions): Message[] {
    const messages = [...options.messages];

    // Add system prompt if provided and no system message exists
    if (options.systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }

    // Convert messages to Ollama format (handles tool messages)
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: isStringContent(msg.content) ? msg.content : 'Multi-modal content not supported',
        } as Message;
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: msg.role,
          content: (isStringContent(msg.content) ? msg.content : '') || '',
          tool_calls: msg.tool_calls.map((tc) => ({
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        } as Message;
      }

      return {
        role: msg.role,
        content: isStringContent(msg.content)
          ? msg.content
          : 'Multi-modal content not fully supported by Ollama provider',
      } as Message;
    });
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

    this.logger.info(`Generating embedding with model: ${embeddingModel}`);
    this.logger.debug('Ollama embedding request', {
      model: embeddingModel,
      textLength: text.length,
    });

    try {
      const response = await this.client.embeddings({
        model: embeddingModel,
        prompt: text,
      });

      const result: EmbeddingResult = {
        embedding: response.embedding,
        model: embeddingModel,
        usage: {
          promptTokens: 0, // Ollama doesn't provide detailed usage
          totalTokens: 0,
        },
      };

      this.logger.info('Embedding generated successfully');
      this.logger.debug('Ollama embedding result', {
        model: embeddingModel,
        dimensions: result.embedding.length,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error('Embedding generation failed');
      this.logger.debug('Ollama embedding error', {
        model: embeddingModel,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });
      throw new Error(`Ollama embedding generation failed: ${errorMessage}`);
    }
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const fileName = path.basename(imagePath);

    this.logger.info(`Analyzing image: ${fileName}`);
    this.logger.debug('Ollama image analysis started', {
      imagePath,
      fileName,
      hasPrompt: !!options.prompt,
      maxTokens: options.maxTokens || 1000,
    });

    // Validate image file
    if (!fs.existsSync(imagePath)) {
      this.logger.error(`Image file not found: ${imagePath}`);
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const ext = path.extname(imagePath).toLowerCase();
    const supportedFormats = ['.jpg', '.jpeg', '.png'];
    if (!supportedFormats.includes(ext)) {
      this.logger.error(`Unsupported image format: ${ext}`);
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`
      );
    }

    // Read and encode image
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    return this.analyzeImageFromBase64(base64Image, options);
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.info('Analyzing base64 image');
    this.logger.debug('Ollama base64 image analysis started', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      maxTokens: options.maxTokens || 1000,
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      // Check if model is available
      const availableModels = await this.client.list();
      const modelExists = availableModels.models.some((m) => m.name.includes(model.split(':')[0]));

      if (!modelExists) {
        this.logger.error(`Model not found: ${model}`);
        throw new Error(
          `Model '${model}' not found. Available models: ${availableModels.models.map((m) => m.name).join(', ')}`
        );
      }

      const response = await this.client.generate({
        model,
        prompt,
        images: [cleanBase64],
        options: {
          num_predict: options.maxTokens || 1000,
          temperature: options.temperature || 0.1,
        },
        stream: false,
      });

      const processingTime = Date.now() - startTime;
      const content = response.response || 'No analysis available';

      const result: VisionAnalysisResult = {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: {
            promptTokens: response.prompt_eval_count || 0,
            completionTokens: response.eval_count || 0,
            totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
          },
        },
      };

      this.logger.info('Image analysis completed');
      this.logger.debug('Ollama image analysis result', {
        model,
        processingTime,
        contentLength: content.length,
        promptEvalCount: response.prompt_eval_count || 0,
        evalCount: response.eval_count || 0,
        totalDuration: response.total_duration || 0,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('Image analysis failed');
      this.logger.debug('Ollama image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });

      throw new Error(`Ollama vision analysis failed: ${errorMessage}`);
    }
  }

  getEmbeddingProvider(): LLMProvider {
    return {
      name: 'ollama-embedding',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: () => [],
      getEmbeddingModels: this.getEmbeddingModels.bind(this),
      generateEmbedding: async (text: string, model?: string) => {
        const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

        this.logger.debug('Using Ollama client for embeddings', {
          model: embeddingModel,
          textLength: text.length,
        });

        const response = await this.client.embeddings({
          model: embeddingModel,
          prompt: text,
        });

        return {
          embedding: response.embedding,
          model: embeddingModel,
          usage: {
            promptTokens: 0,
            totalTokens: 0,
          },
        };
      },
    };
  }

  getVisionProvider(): LLMProvider {
    return {
      name: 'ollama-vision',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: this.getVisionModels.bind(this),
      getEmbeddingModels: () => [],
      analyzeImage: async (imagePath: string, options?: VisionAnalysisOptions) => {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');

        return this.analyzeImageFromBase64WithClient(base64Image, options, this.client);
      },
      analyzeImageFromBase64: async (base64Data: string, options?: VisionAnalysisOptions) => {
        return this.analyzeImageFromBase64WithClient(base64Data, options, this.client);
      },
    };
  }

  private async analyzeImageFromBase64WithClient(
    base64Data: string,
    options: VisionAnalysisOptions = {},
    client: Ollama
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.debug('Using Ollama client for vision', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      // Check if model is available
      const availableModels = await client.list();
      const modelExists = availableModels.models.some((m) => m.name.includes(model.split(':')[0]));

      if (!modelExists) {
        this.logger.error(`Model not found: ${model}`);
        throw new Error(
          `Model '${model}' not found. Available models: ${availableModels.models.map((m) => m.name).join(', ')}`
        );
      }

      const response = await client.generate({
        model,
        prompt,
        images: [cleanBase64],
        options: {
          num_predict: options.maxTokens || 1000,
          temperature: options.temperature || 0.1,
        },
        stream: false,
      });

      const processingTime = Date.now() - startTime;
      const content = response.response || 'No analysis available';

      return {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: {
            promptTokens: response.prompt_eval_count || 0,
            completionTokens: response.eval_count || 0,
            totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
          },
        },
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('Ollama image analysis failed');
      this.logger.debug('Ollama image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });

      throw new Error(`Ollama vision analysis failed: ${errorMessage}`);
    }
  }
}
