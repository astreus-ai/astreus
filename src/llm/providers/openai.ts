import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig, LLMMessage, VisionAnalysisOptions, VisionAnalysisResult, EmbeddingResult } from '../types';
import OpenAI from 'openai';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import * as fs from 'fs';
import * as path from 'path';

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
      hasConfigApiKey: !!config?.apiKey,
      hasEnvApiKey: !!process.env.OPENAI_API_KEY,
      hasEmbeddingApiKey: !!process.env.OPENAI_EMBEDDING_API_KEY,  
      hasVisionApiKey: !!process.env.OPENAI_VISION_API_KEY,
      hasCustomBaseUrl: !!config?.baseUrl,
      hasEmbeddingBaseUrl: !!process.env.OPENAI_EMBEDDING_BASE_URL,
      hasVisionBaseUrl: !!process.env.OPENAI_VISION_BASE_URL,
      supportsEmbeddings: true,
      supportsVision: true
    });

    // Main client for chat completions (can use custom base URL like OpenRouter)
    // If baseUrl is explicitly null, don't use OPENAI_BASE_URL fallback (for embedding/vision providers)
    const chatBaseUrl = config?.baseUrl === null ? undefined : (config?.baseUrl || process.env.OPENAI_BASE_URL);
    this.client = new OpenAI({
      apiKey,
      ...(chatBaseUrl && { baseURL: chatBaseUrl })
    });

    // Dedicated embedding client - NO fallback to OPENAI_BASE_URL
    const embeddingApiKey = process.env.OPENAI_EMBEDDING_API_KEY || apiKey;
    const embeddingBaseUrl = process.env.OPENAI_EMBEDDING_BASE_URL; // Only dedicated URL, no fallback
    
    this.logger.debug('Creating embedding client', {
      hasEmbeddingApiKey: !!embeddingApiKey,
      usingDedicatedKey: !!process.env.OPENAI_EMBEDDING_API_KEY,
      hasDedicatedBaseUrl: !!embeddingBaseUrl,
      willUseDefaultEndpoint: !embeddingBaseUrl
    });
    
    // Create embedding client with COMPLETELY isolated configuration
    const embeddingClientConfig: { apiKey: string; baseURL?: string } = {
      apiKey: embeddingApiKey
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
    const visionClientConfig: { apiKey: string; baseURL?: string } = {
      apiKey: visionApiKey
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
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
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
      'gpt-3.5-turbo-instruct'
    ];
  }

  getVisionModels(): string[] {
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4-vision-preview',
      'gpt-4o-2024-08-06',
      'gpt-4o-2024-05-13'
    ];
  }

  getEmbeddingModels(): string[] {
    return [
      'text-embedding-3-large',
      'text-embedding-3-small',
      'text-embedding-ada-002'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.prepareMessages(options);
    
    const completion = await this.client.chat.completions.create({
      model: options.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
      ...(options.tools && options.tools.length > 0 && {
        tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
        tool_choice: 'auto'
      })
    });

    const message = completion.choices[0]?.message;
    
    return {
      content: message?.content || '',
      model: completion.model,
      toolCalls: message?.tool_calls?.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string' 
            ? this.safeJsonParse(tc.function.arguments)
            : tc.function.arguments
        }
      })),
      usage: {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const messages = this.prepareMessages(options);
    
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      ...(options.tools && options.tools.length > 0 && {
        tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
        tool_choice: 'auto'
      })
    });

    const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const content = delta?.content || '';
        
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
                    arguments: tc.function?.arguments || ''
                  }
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

      // Final chunk with tool calls
      yield { 
        content: '', 
        done: true, 
        model: options.model,
        toolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string' 
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments
          }
        })) : undefined
      };
    } catch (error) {
      throw new Error(`OpenAI streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available
    
    this.logger.info(`Generating embedding with model: ${embeddingModel}`);
    this.logger.debug('OpenAI embedding request', {
      model: embeddingModel,
      textLength: text.length
    });

    try {
      const response = await this.embeddingClient.embeddings.create({
        model: embeddingModel,
        input: text,
        encoding_format: 'float'
      });

      const result: EmbeddingResult = {
        embedding: response.data[0].embedding,
        model: embeddingModel,
        usage: {
          promptTokens: response.usage.prompt_tokens,
          totalTokens: response.usage.total_tokens
        }
      };

      this.logger.info('Embedding generated successfully');
      this.logger.debug('OpenAI embedding result', {
        model: embeddingModel,
        dimensions: result.embedding.length,
        promptTokens: result.usage?.promptTokens || 0
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error('Embedding generation failed');
      this.logger.debug('OpenAI embedding error', {
        model: embeddingModel,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack
      });
      throw new Error(`OpenAI embedding generation failed: ${errorMessage}`);
    }
  }

  async analyzeImage(imagePath: string, options: VisionAnalysisOptions = {}): Promise<VisionAnalysisResult> {
    const fileName = path.basename(imagePath);
    
    this.logger.info(`Analyzing image: ${fileName}`);
    this.logger.debug('OpenAI image analysis started', {
      imagePath,
      fileName,
      hasPrompt: !!options.prompt,
      detail: options.detail || 'auto',
      maxTokens: options.maxTokens || 1000
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
      throw new Error(`Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`);
    }

    // Read and encode image
    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = this.getMimeType(ext);
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    return this.analyzeImageFromBase64(dataUrl, options);
  }

  async analyzeImageFromBase64(base64Data: string, options: VisionAnalysisOptions = {}): Promise<VisionAnalysisResult> {
    const startTime = Date.now();
    
    this.logger.info('Analyzing base64 image');
    this.logger.debug('OpenAI base64 image analysis started', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      detail: options.detail || 'auto',
      maxTokens: options.maxTokens || 1000
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      const response = await this.visionClient.chat.completions.create({
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
                  detail: options.detail || 'auto'
                }
              }
            ]
          }
        ],
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.1,
      });

      const processingTime = Date.now() - startTime;
      const content = response.choices[0]?.message?.content || 'No analysis available';

      const result: VisionAnalysisResult = {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        }
      };

      this.logger.info('Image analysis completed');
      this.logger.debug('OpenAI image analysis result', {
        model,
        processingTime,
        contentLength: content.length,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('Image analysis failed');
      this.logger.debug('OpenAI image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack
      });

      throw new Error(`OpenAI vision analysis failed: ${errorMessage}`);
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    };
    
    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
  }

  private prepareMessages(options: LLMRequestOptions): LLMMessage[] {
    const messages = [...options.messages];
    
    // Add system prompt if provided and no system message exists
    if (options.systemPrompt && !messages.some(m => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }
    
    return messages;
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
          clientApiKey: (this.embeddingClient as { apiKey?: string }).apiKey?.slice(0, 12) + '...'
        });
        
        
        const response = await this.embeddingClient.embeddings.create({
          model: embeddingModel,
          input: text,
          encoding_format: 'float'
        });

        return {
          embedding: response.data[0].embedding,
          model: embeddingModel,
          usage: {
            promptTokens: response.usage.prompt_tokens,
            totalTokens: response.usage.total_tokens
          }
        };
      }
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
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = this.getMimeType(ext);
        const dataUrl = `data:${mimeType};base64,${base64Image}`;
        
        return this.analyzeImageFromBase64WithClient(dataUrl, options, this.visionClient);
      },
      analyzeImageFromBase64: async (base64Data: string, options?: VisionAnalysisOptions) => {
        return this.analyzeImageFromBase64WithClient(base64Data, options, this.visionClient);
      }
    };
  }

  private async analyzeImageFromBase64WithClient(base64Data: string, options: VisionAnalysisOptions = {}, client: OpenAI): Promise<VisionAnalysisResult> {
    const startTime = Date.now();
    
    this.logger.debug('Using dedicated vision client', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      clientHasBaseURL: 'baseURL' in client
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

      const response = await client.chat.completions.create({
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
                  detail: options.detail || 'auto'
                }
              }
            ]
          }
        ],
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.1,
      });

      const processingTime = Date.now() - startTime;
      const content = response.choices[0]?.message?.content || 'No analysis available';

      return {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        }
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('OpenAI image analysis failed');
      this.logger.debug('OpenAI image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack
      });

      throw new Error(`OpenAI vision analysis failed: ${errorMessage}`);
    }
  }
}