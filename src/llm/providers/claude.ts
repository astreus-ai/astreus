import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  Message,
  MessageCreateParamsBase,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  LLMMessageContent,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  EmbeddingResult,
} from '../types';
import { getModelDefinition, getModelsByProvider, getVisionModelsByProvider } from '../models';
import { parseToolArguments, resolveUsageCost } from '../utils';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import { LLMApiError, VisionError } from '../../errors';
import * as fs from 'fs';
import * as path from 'path';

const DIRECT_BASE_URL = 'https://api.anthropic.com';

export class ClaudeProvider implements LLMProvider {
  name = 'claude';
  private client: Anthropic;
  private visionClient: Anthropic;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable.');
    this.logger = config?.logger || getLogger();
    const timeout = config?.timeout ?? 120000;
    this.client = new Anthropic({
      apiKey,
      timeout,
      baseURL:
        config?.baseUrl === null
          ? DIRECT_BASE_URL
          : config?.baseUrl || process.env.ANTHROPIC_BASE_URL || DIRECT_BASE_URL,
    });
    this.visionClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_VISION_API_KEY || apiKey,
      baseURL: process.env.ANTHROPIC_VISION_BASE_URL || DIRECT_BASE_URL,
      timeout,
    });
    this.logger.info('Claude provider initialized');
  }

  getSupportedModels(): string[] {
    return getModelsByProvider('claude');
  }

  getVisionModels(): string[] {
    return getVisionModelsByProvider('claude');
  }

  getEmbeddingModels(): string[] {
    return [];
  }

  async generateEmbedding(): Promise<EmbeddingResult> {
    throw new Error('Claude does not support embedding generation. Use OpenAI, Gemini, or Ollama.');
  }

  private contentBlocks(content: LLMMessageContent): (TextBlockParam | ImageBlockParam)[] {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    return content.map((part): TextBlockParam | ImageBlockParam => {
      if (part.type === 'text' && part.text !== undefined) return { type: 'text', text: part.text };
      if (part.type === 'image_url' && part.image_url) {
        const match = part.image_url.url.match(
          /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s
        );
        if (match) {
          const mediaType = match[1];
          if (
            mediaType === 'image/jpeg' ||
            mediaType === 'image/png' ||
            mediaType === 'image/gif' ||
            mediaType === 'image/webp'
          ) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: match[2] },
            };
          }
        }
        const url = new URL(part.image_url.url);
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('Invalid image URL');
        return { type: 'image', source: { type: 'url', url: url.href } };
      }
      throw new Error('Invalid multimodal message content');
    });
  }

  private prepareMessages(options: LLMRequestOptions): {
    system?: string;
    messages: MessageParam[];
  } {
    const system =
      options.systemPrompt ||
      options.messages
        .filter((message) => message.role === 'system')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text ?? '').join('')
        )
        .join('\n') ||
      undefined;
    const messages: MessageParam[] = [];
    for (const message of options.messages) {
      if (message.role === 'system') continue;
      let converted: MessageParam;
      if (message.providerData) {
        if (
          message.role !== 'assistant' ||
          message.providerData.protocol !== 'claude-messages' ||
          message.providerData.model !== options.model
        ) {
          throw new Error(
            'Cannot replay provider continuation with a different model or transport'
          );
        }
        // Preserve every block, its order and signature, including empty thinking
        // and redacted blocks. Rebuilding a signature invalidates the next request.
        converted = { role: 'assistant', content: message.providerData.content };
      } else if (message.role === 'tool') {
        if (!message.tool_call_id) throw new Error('Tool result is missing tool_call_id');
        converted = {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: this.contentBlocks(message.content),
            },
          ],
        };
      } else {
        converted = {
          role: message.role,
          content: [
            ...this.contentBlocks(message.content),
            ...(message.tool_calls ?? []).map(
              (tool): ContentBlockParam => ({
                type: 'tool_use',
                id: tool.id,
                name: tool.function.name,
                input: tool.function.arguments,
              })
            ),
          ],
        };
      }
      const previous = messages[messages.length - 1];
      // Parallel tool results belong to one user turn immediately after tool_use.
      if (
        message.role === 'tool' &&
        previous?.role === 'user' &&
        Array.isArray(previous.content) &&
        Array.isArray(converted.content)
      ) {
        previous.content.push(...converted.content);
      } else {
        messages.push(converted);
      }
    }
    return { system, messages };
  }

  private requestParams(options: LLMRequestOptions): MessageCreateParamsBase {
    const model = getModelDefinition(options.model);
    if (!model || model.provider !== 'claude')
      throw new Error(`Unsupported Claude model: ${options.model}`);
    const maxTokens = options.maxTokens ?? 4096;
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < 1 ||
      (model.maxOutputTokens !== undefined && maxTokens > model.maxOutputTokens)
    ) {
      throw new Error(`Invalid maxTokens for model ${model.id}`);
    }
    return {
      model: options.model,
      ...this.prepareMessages(options),
      max_tokens: maxTokens,
      ...(model.supportsTemperature && { temperature: options.temperature ?? 0.7 }),
      // Current models select adaptive thinking automatically. No manual budget,
      // forced tool choice, sampling override or automatic model fallback.
      ...(options.tools?.length && {
        tools: options.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        })),
        tool_choice: { type: 'auto' as const },
      }),
    };
  }

  private fromMessage(message: Message, requestedModel: string): LLMResponse {
    const toolCalls = message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: { name: block.name, arguments: parseToolArguments(block.input) },
      }));
    if (message.stop_reason === 'max_tokens' && toolCalls.length) {
      throw new Error('Message ended before tool calls completed');
    }
    const usage = message.usage;
    // Cache reads/writes are input too, and omitted-thinking tokens are output.
    const input = usage
      ? usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      : 0;
    return {
      content: message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      model: message.model,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      providerData: {
        protocol: 'claude-messages',
        model: requestedModel,
        content: message.content,
      },
      usage: usage
        ? {
            promptTokens: input,
            completionTokens: usage.output_tokens,
            totalTokens: input + usage.output_tokens,
            cost: resolveUsageCost(message),
          }
        : undefined,
    };
  }

  private requestError(error: unknown): LLMApiError {
    const status = error instanceof Anthropic.APIError ? error.status : undefined;
    const message = `Claude request failed${status ? ` (HTTP ${status})` : ''}`;
    this.logger.error(message);
    return new LLMApiError(message, this.name, error instanceof Error ? error : undefined);
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateWithClient(options, this.client);
  }

  private async generateWithClient(
    options: LLMRequestOptions,
    client: Anthropic
  ): Promise<LLMResponse> {
    const params = this.requestParams(options);
    try {
      return this.fromMessage(
        await client.messages.create({ ...params, stream: false }),
        options.model
      );
    } catch (error) {
      throw this.requestError(error);
    }
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const stream = this.client.messages.stream(this.requestParams(options));
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { content: event.delta.text, done: false, model: options.model };
        }
      }
      // The stable SDK assembles indexed JSON fragments, thinking signatures and
      // message_start/message_delta usage into the same shape as a regular call.
      const response = this.fromMessage(await stream.finalMessage(), options.model);
      yield { ...response, content: '', done: true };
    } catch (error) {
      throw this.requestError(error);
    } finally {
      stream.abort();
    }
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mimeType = mimeTypes[path.extname(imagePath).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported image format');
    const image = await fs.promises.readFile(imagePath);
    return this.analyzeImageFromBase64(
      `data:${mimeType};base64,${image.toString('base64')}`,
      options
    );
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions & { mimeType?: string } = {}
  ): Promise<VisionAnalysisResult> {
    const start = Date.now();
    if (!options.model) {
      throw new Error(
        'The previous Claude vision default claude-3-5-sonnet-20241022 is retired. Set a supported vision model explicitly.'
      );
    }
    try {
      const url = base64Data.startsWith('data:')
        ? base64Data
        : `data:${options.mimeType || 'image/jpeg'};base64,${base64Data}`;
      const response = await this.generateWithClient(
        {
          model: options.model,
          maxTokens: options.maxTokens ?? 1000,
          temperature: options.temperature ?? 0.1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url } },
                {
                  type: 'text',
                  text: options.prompt || 'Analyze this image and describe what you see in detail.',
                },
              ],
            },
          ],
        },
        this.visionClient
      );
      return {
        content: response.content,
        metadata: {
          model: response.model,
          provider: this.name,
          processingTime: Date.now() - start,
          tokenUsage: response.usage,
        },
      };
    } catch (error) {
      throw new VisionError(
        'Claude vision analysis failed',
        this.name,
        error instanceof Error ? error : undefined
      );
    }
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
      getEmbeddingModels: () => [],
      getVisionModels: this.getVisionModels.bind(this),
      analyzeImage: this.analyzeImage.bind(this),
      analyzeImageFromBase64: this.analyzeImageFromBase64.bind(this),
    };
  }
}
