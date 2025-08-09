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
  isMultiModalContent,
} from '../types';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockDeltaEvent, TextDelta } from '@anthropic-ai/sdk/resources/messages';
import type {
  ToolUseBlock,
  ToolsBetaContentBlock,
  ToolsBetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/tools/messages';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import * as fs from 'fs';
import * as path from 'path';

export class ClaudeProvider implements LLMProvider {
  name = 'claude';
  private client: Anthropic;
  private visionClient: Anthropic;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY;

    // Use provided logger or fallback to global logger
    this.logger = config?.logger || getLogger();

    if (!apiKey) {
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable.');
    }

    this.logger.info('Claude provider initialized');
    this.logger.debug('Claude provider initialization', {
      hasConfigApiKey: !!config?.apiKey,
      hasEnvApiKey: !!process.env.ANTHROPIC_API_KEY,
      hasVisionApiKey: !!process.env.ANTHROPIC_VISION_API_KEY,
      hasCustomBaseUrl: !!config?.baseUrl,
      hasVisionBaseUrl: !!process.env.ANTHROPIC_VISION_BASE_URL,
      supportsEmbeddings: false,
      supportsVision: true,
    });

    // Main client for chat completions (can use custom base URL)
    // If baseUrl is explicitly null, don't use ANTHROPIC_BASE_URL fallback (for embedding/vision providers)
    const chatBaseUrl =
      config?.baseUrl === null ? undefined : config?.baseUrl || process.env.ANTHROPIC_BASE_URL;
    this.client = new Anthropic({
      apiKey,
      ...(chatBaseUrl && { baseURL: chatBaseUrl }),
    });

    // Dedicated vision client - NO fallback to ANTHROPIC_BASE_URL
    const visionApiKey = process.env.ANTHROPIC_VISION_API_KEY || apiKey;
    const visionBaseUrl = process.env.ANTHROPIC_VISION_BASE_URL; // Only dedicated URL, no fallback

    // Create vision client with isolated configuration
    const visionClientConfig: { apiKey: string; baseURL?: string } = {
      apiKey: visionApiKey,
    };

    // Only add baseURL if we have a dedicated one, otherwise use Anthropic default
    if (visionBaseUrl) {
      visionClientConfig.baseURL = visionBaseUrl;
    }
    // Note: Anthropic SDK doesn't auto-read env vars like OpenAI, so no explicit default needed

    this.visionClient = new Anthropic(visionClientConfig);
  }

  private sanitizeArguments(input: object): Record<string, string | number | boolean | null> {
    const sanitized: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input)) {
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
  }

  getSupportedModels(): string[] {
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3.7-sonnet-20250224',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  getVisionModels(): string[] {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  getEmbeddingModels(): string[] {
    // Claude doesn't currently offer embedding models, but structure is ready for future support
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async generateEmbedding(_text: string, _model?: string): Promise<EmbeddingResult> {
    // Claude doesn't currently support embeddings, but this method is ready for future implementation
    throw new Error(
      'Claude provider does not currently support embedding generation. Please use OpenAI, Gemini, or Ollama providers for embeddings.'
    );
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const { system, messages } = this.prepareMessages(options);

    const message = await this.client.beta.tools.messages.create({
      model: options.model,
      messages: messages as ToolsBetaMessageParam[],
      system,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
      ...(options.tools &&
        options.tools.length > 0 && {
          tools: options.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        }),
    });

    // Extract tool calls from Claude's response
    const toolCalls = (message.content as ToolsBetaContentBlock[])
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: this.sanitizeArguments(block.input || {}),
        },
      }));

    const textContent = (message.content as ToolsBetaContentBlock[])
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content: textContent,
      model: message.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens,
      },
    };
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { system, messages } = this.prepareMessages(options);

    const stream = await this.client.beta.tools.messages.create({
      model: options.model,
      messages: messages as ToolsBetaMessageParam[],
      system,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      ...(options.tools &&
        options.tools.length > 0 && {
          tools: options.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        }),
    });

    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, string | number | boolean | null> };
    }> = [];

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const deltaEvent = event as ContentBlockDeltaEvent;
          if (deltaEvent.delta.type === 'text_delta') {
            const textDelta = deltaEvent.delta as TextDelta;
            const content = textDelta.text || '';
            if (content) {
              yield { content, done: false, model: options.model };
            }
          }
        } else if (event.type === 'content_block_start') {
          // Standard streaming doesn't support tool_use in content_block_start
          // Tool calls will be handled differently or in the final response
        } else if (event.type === 'message_stop') {
          yield {
            content: '',
            done: true,
            model: options.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
          return;
        }
      }
    } catch (error) {
      throw new Error(
        `Claude streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private prepareMessages(options: LLMRequestOptions): {
    system?: string;
    messages: ToolsBetaMessageParam[];
  } {
    let system = options.systemPrompt;
    const messages = options.messages.filter((m) => m.role !== 'system');

    // Find system message if no explicit system prompt
    if (!system) {
      const systemMessage = options.messages.find((m) => m.role === 'system');
      if (systemMessage) {
        system = isStringContent(systemMessage.content) ? systemMessage.content : '';
      }
    }

    // Convert messages to Claude format
    return {
      system,
      messages: messages.map((msg) => {
        if (msg.role === 'tool') {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: msg.tool_call_id!,
                content: [
                  { type: 'text' as const, text: isStringContent(msg.content) ? msg.content : '' },
                ],
              },
            ],
          } as ToolsBetaMessageParam;
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant' as const,
            content: [
              ...(msg.content && isStringContent(msg.content)
                ? [{ type: 'text' as const, text: msg.content }]
                : []),
              ...msg.tool_calls.map((tc) => ({
                type: 'tool_use' as const,
                id: tc.id,
                name: tc.function.name,
                input: tc.function.arguments,
              })),
            ],
          } as ToolsBetaMessageParam;
        }

        // Handle multi-modal content
        if (isMultiModalContent(msg.content)) {
          const claudeContent = msg.content
            .map((part) => {
              if (part.type === 'text') {
                return { type: 'text' as const, text: part.text || '' };
              } else if (part.type === 'image_url' && part.image_url) {
                // Extract base64 data from data URL
                const base64Match = part.image_url.url.match(/^data:(.+);base64,(.+)$/);
                if (base64Match) {
                  const mediaType = base64Match[1];
                  const data = base64Match[2];
                  return {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: mediaType as
                        | 'image/jpeg'
                        | 'image/png'
                        | 'image/gif'
                        | 'image/webp',
                      data,
                    },
                  };
                }
              }
              return { type: 'text' as const, text: '' };
            })
            .filter((part) => (part.type === 'text' ? part.text !== '' : true));

          return {
            role: msg.role as 'user' | 'assistant',
            content: claudeContent,
          } as ToolsBetaMessageParam;
        }

        // Handle string content
        return {
          role: msg.role as 'user' | 'assistant',
          content: isStringContent(msg.content) ? msg.content : '',
        } as Anthropic.Messages.MessageParam;
      }),
    };
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const fileName = path.basename(imagePath);

    this.logger.info(`Analyzing image: ${fileName}`);
    this.logger.debug('Claude image analysis started', {
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
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!supportedFormats.includes(ext)) {
      this.logger.error(`Unsupported image format: ${ext}`);
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`
      );
    }

    // Read and encode image
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = this.getMimeType(ext);

    return this.analyzeImageFromBase64(base64Image, { ...options, mimeType });
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions & { mimeType?: string } = {}
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.info('Analyzing base64 image');
    this.logger.debug('Claude base64 image analysis started', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      maxTokens: options.maxTokens || 1000,
      mimeType: options.mimeType || 'image/jpeg',
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';
      const mimeType = options.mimeType || 'image/jpeg';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      const response = await this.visionClient.messages.create({
        model,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.1,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: cleanBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      });

      const processingTime = Date.now() - startTime;
      const content =
        response.content[0]?.type === 'text' ? response.content[0].text : 'No analysis available';

      const result: VisionAnalysisResult = {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage
            ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.input_tokens + response.usage.output_tokens,
              }
            : undefined,
        },
      };

      this.logger.info('Image analysis completed');
      this.logger.debug('Claude image analysis result', {
        model,
        processingTime,
        contentLength: content.length,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('Image analysis failed');
      this.logger.debug('Claude image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });

      throw new Error(`Claude vision analysis failed: ${errorMessage}`);
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };

    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
  }

  getEmbeddingProvider(): LLMProvider {
    return {
      name: 'claude-embedding',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: () => [],
      getEmbeddingModels: this.getEmbeddingModels.bind(this),
      generateEmbedding: this.generateEmbedding.bind(this),
    };
  }

  getVisionProvider(): LLMProvider {
    return {
      name: 'claude-vision',
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

        return this.analyzeImageFromBase64WithClient(
          base64Image,
          { ...options, mimeType },
          this.visionClient
        );
      },
      analyzeImageFromBase64: async (base64Data: string, options?: VisionAnalysisOptions) => {
        return this.analyzeImageFromBase64WithClient(base64Data, options, this.visionClient);
      },
    };
  }

  private async analyzeImageFromBase64WithClient(
    base64Data: string,
    options: VisionAnalysisOptions & { mimeType?: string } = {},
    client: Anthropic
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.debug('Using dedicated vision client', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      mimeType: options.mimeType || 'image/jpeg',
      clientHasBaseURL: 'baseURL' in client,
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';
      const mimeType = options.mimeType || 'image/jpeg';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.1,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: cleanBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      });

      const processingTime = Date.now() - startTime;
      const content =
        response.content[0]?.type === 'text' ? response.content[0].text : 'No analysis available';

      return {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage: response.usage
            ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.input_tokens + response.usage.output_tokens,
              }
            : undefined,
        },
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      this.logger.error('Claude image analysis failed');
      this.logger.debug('Claude image analysis error', {
        processingTime,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });

      throw new Error(`Claude vision analysis failed: ${errorMessage}`);
    }
  }
}
