import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming';
import { toResponseInputItem } from 'openai/lib/responses/ResponseInputItems';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseInput,
  ResponseInputContent,
} from 'openai/resources/responses/responses';
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  LLMUsage,
  LLMMessage,
  ToolCall,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  EmbeddingResult,
} from '../types';
import {
  getModelDefinition,
  getModelsByProvider,
  getVisionModelsByProvider,
  getEmbeddingModelsByProvider,
  ModelDefinition,
} from '../models';
import { parseToolArguments, resolveUsageCost } from '../utils';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import { LLMApiError, VisionError } from '../../errors';
import * as fs from 'fs';
import * as path from 'path';

const DIRECT_BASE_URL = 'https://api.openai.com/v1';

type ChatMessage = ChatCompletionMessage & { reasoning_details?: Record<string, unknown>[] };

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private embeddingClient: OpenAI;
  private visionClient: OpenAI;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable.');
    }
    this.logger = config?.logger || getLogger();
    const timeout = config?.timeout ?? 120000;
    const baseURL =
      config?.baseUrl === null
        ? DIRECT_BASE_URL
        : config?.baseUrl || process.env.OPENAI_BASE_URL || DIRECT_BASE_URL;
    this.client = new OpenAI({ apiKey, baseURL, timeout });
    // Keep embedding/vision credentials and endpoints independent of the chat gateway.
    this.embeddingClient = new OpenAI({
      apiKey: process.env.OPENAI_EMBEDDING_API_KEY || apiKey,
      baseURL: process.env.OPENAI_EMBEDDING_BASE_URL || DIRECT_BASE_URL,
      timeout,
    });
    this.visionClient = new OpenAI({
      apiKey: process.env.OPENAI_VISION_API_KEY || apiKey,
      baseURL: process.env.OPENAI_VISION_BASE_URL || DIRECT_BASE_URL,
      timeout,
    });
    this.logger.info('OpenAI provider initialized');
  }

  getSupportedModels(): string[] {
    return getModelsByProvider('openai');
  }

  getVisionModels(): string[] {
    return getVisionModelsByProvider('openai');
  }

  getEmbeddingModels(): string[] {
    return getEmbeddingModelsByProvider('openai');
  }

  private requestModel(options: LLMRequestOptions, client: OpenAI): ModelDefinition {
    const model = getModelDefinition(options.model);
    if (!model || model.provider !== 'openai') {
      throw new Error(`Unsupported OpenAI model: ${options.model}`);
    }
    const endpoint = new URL(client.baseURL);
    const direct =
      endpoint.origin === 'https://api.openai.com' &&
      endpoint.pathname.replace(/\/$/, '') === '/v1';
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('The model endpoint must not contain credentials, a query, or a fragment');
    }
    if (model.gateway && direct) {
      throw new Error(
        `Model ${model.id} requires a configured OpenAI-compatible gateway via OPENAI_BASE_URL`
      );
    }
    if (
      model.gateway === 'openrouter' &&
      (endpoint.origin !== 'https://openrouter.ai' ||
        endpoint.pathname.replace(/\/$/, '') !== '/api/v1')
    ) {
      throw new Error(
        `Model ${model.id} requires OPENAI_BASE_URL=https://openrouter.ai/api/v1; no paid fallback is allowed`
      );
    }
    if (!direct && model.id === 'gpt-6-astra' && options.tools?.length) {
      throw new Error(
        'GPT-6 Astra tool calling requires the direct Responses endpoint, not a Chat Completions gateway'
      );
    }
    if (
      options.maxTokens !== undefined &&
      (!Number.isInteger(options.maxTokens) ||
        options.maxTokens < 1 ||
        (model.maxOutputTokens !== undefined && options.maxTokens > model.maxOutputTokens))
    ) {
      throw new Error(`Invalid maxTokens for model ${model.id}`);
    }
    // A configured compatible endpoint keeps Chat Completions, including existing
    // production deployments. Never silently route its key to a direct endpoint.
    return direct ? model : { ...model, transport: 'chat-completions' };
  }

  private messages(options: LLMRequestOptions): LLMMessage[] {
    const messages = [...options.messages];
    if (options.systemPrompt && !messages.some((message) => message.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }
    return messages;
  }

  private responsesInput(options: LLMRequestOptions): ResponseInput {
    const input: ResponseInput = [];
    for (const message of this.messages(options)) {
      if (message.providerData) {
        if (
          message.role !== 'assistant' ||
          message.providerData.protocol !== 'openai-responses' ||
          message.providerData.model !== options.model
        ) {
          throw new Error(
            'Cannot replay provider continuation with a different model or transport'
          );
        }
        // Replay every native output item, including encrypted reasoning and call IDs.
        // Do not replace this with normalized text/tool calls or item references.
        for (const item of message.providerData.output) {
          const replay = toResponseInputItem(item);
          if (!replay) throw new Error('Native response contains an item that cannot be replayed');
          input.push(replay);
        }
        continue;
      }
      if (message.role === 'tool') {
        if (!message.tool_call_id) throw new Error('Tool result is missing tool_call_id');
        if (typeof message.content !== 'string') throw new Error('Tool results must contain text');
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content,
        });
        continue;
      }
      if (typeof message.content === 'string') {
        if (message.content || !message.tool_calls?.length) {
          input.push({ role: message.role, content: message.content });
        }
      } else {
        const content: ResponseInputContent[] = message.content.map((part) => {
          if (part.type === 'text' && part.text !== undefined) {
            return { type: 'input_text', text: part.text };
          }
          if (part.type === 'image_url' && part.image_url) {
            return {
              type: 'input_image',
              image_url: part.image_url.url,
              detail: part.image_url.detail ?? 'auto',
            };
          }
          throw new Error('Invalid multimodal message content');
        });
        input.push({ role: message.role, content });
      }
      for (const tool of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tool.id,
          name: tool.function.name,
          arguments: JSON.stringify(tool.function.arguments),
        });
      }
    }
    return input;
  }

  private responsesParams(
    options: LLMRequestOptions,
    model: ModelDefinition
  ): ResponseCreateParamsBase {
    return {
      model: options.model,
      input: this.responsesInput(options),
      max_output_tokens: options.maxTokens ?? 4096,
      // Stateless continuation also works for zero-data-retention accounts.
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(model.supportsTemperature && { temperature: options.temperature ?? 0.7 }),
      ...(options.tools?.length && {
        tools: options.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: false,
        })),
        tool_choice: 'auto' as const,
      }),
    };
  }

  private chatMessages(options: LLMRequestOptions): ChatCompletionMessageParam[] {
    return this.messages(options).map((message): ChatCompletionMessageParam => {
      if (message.providerData) {
        if (
          message.role !== 'assistant' ||
          message.providerData.protocol !== 'openai-chat-completions' ||
          message.providerData.model !== options.model
        ) {
          throw new Error(
            'Cannot replay provider continuation with a different model or transport'
          );
        }
        return message.providerData.message;
      }
      if (message.role === 'tool') {
        if (!message.tool_call_id) throw new Error('Tool result is missing tool_call_id');
        if (typeof message.content !== 'string') throw new Error('Tool results must contain text');
        return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
      }
      if (message.role === 'assistant') {
        if (typeof message.content !== 'string')
          throw new Error('Assistant content must contain text');
        const result: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: message.content,
        };
        if (message.tool_calls?.length) {
          result.tool_calls = message.tool_calls.map((tool) => ({
            id: tool.id,
            type: 'function',
            function: {
              name: tool.function.name,
              arguments: JSON.stringify(tool.function.arguments),
            },
          }));
        }
        return result;
      }
      if (message.role === 'system') {
        if (typeof message.content !== 'string')
          throw new Error('System content must contain text');
        return { role: 'system', content: message.content };
      }
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => {
                if (part.type === 'text' && part.text !== undefined)
                  return { type: 'text', text: part.text };
                if (part.type === 'image_url' && part.image_url)
                  return { type: 'image_url', image_url: part.image_url };
                throw new Error('Invalid multimodal message content');
              }),
      };
    });
  }

  private chatParams(
    options: LLMRequestOptions,
    model: ModelDefinition
  ): ChatCompletionCreateParamsBase {
    return {
      model: options.model,
      messages: this.chatMessages(options),
      ...(model.supportsTemperature && { temperature: options.temperature ?? 0.7 }),
      ...(model.supportsTemperature
        ? { max_tokens: options.maxTokens ?? 4096 }
        : { max_completion_tokens: options.maxTokens ?? 4096 }),
      ...(options.tools?.length && { tools: options.tools, tool_choice: 'auto' as const }),
    };
  }

  private fromResponse(response: Response, requestedModel: string): LLMResponse {
    if (response.status === 'failed' || response.status === 'cancelled') {
      throw new Error(`Response ended with status ${response.status}`);
    }
    const tools: ToolCall[] = [];
    let content = '';
    for (const item of response.output) {
      if (item.type === 'function_call') {
        if (!item.call_id || !item.name) throw new Error('Incomplete native function call');
        tools.push({
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: parseToolArguments(item.arguments) },
        });
      } else if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') content += part.text;
          else if (part.type === 'refusal') content += part.refusal;
        }
      }
    }
    if (response.status === 'incomplete' && tools.length) {
      throw new Error('Response ended before tool calls completed');
    }
    return {
      content,
      model: response.model,
      toolCalls: tools.length ? tools : undefined,
      providerData: {
        protocol: 'openai-responses',
        model: requestedModel,
        output: response.output,
      },
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
            cost: resolveUsageCost(response),
          }
        : undefined,
    };
  }

  private fromChat(
    message: ChatMessage,
    model: string,
    requestedModel: string,
    usage?: LLMUsage
  ): LLMResponse {
    const tools = message.tool_calls?.map((tool): ToolCall => {
      if (tool.type !== 'function') throw new Error('Unsupported custom tool call');
      if (!tool.id || !tool.function.name) throw new Error('Incomplete function call');
      return {
        id: tool.id,
        type: 'function',
        function: {
          name: tool.function.name,
          arguments: parseToolArguments(tool.function.arguments),
        },
      };
    });
    return {
      content: message.content ?? message.refusal ?? '',
      model,
      toolCalls: tools?.length ? tools : undefined,
      providerData: { protocol: 'openai-chat-completions', model: requestedModel, message },
      usage,
    };
  }

  private chatUsage(completion: { usage?: ChatCompletion['usage'] | null }): LLMUsage | undefined {
    return completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
          cost: resolveUsageCost(completion),
        }
      : undefined;
  }

  private requestError(error: unknown, operation: string): LLMApiError {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    const message = `OpenAI ${operation} failed${status ? ` (HTTP ${status})` : ''}`;
    // API errors may contain request data. Never log the raw error/response body.
    this.logger.error(message);
    return new LLMApiError(message, this.name, error instanceof Error ? error : undefined);
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateWithClient(options, this.client);
  }

  private async generateWithClient(
    options: LLMRequestOptions,
    client: OpenAI
  ): Promise<LLMResponse> {
    const model = this.requestModel(options, client);
    try {
      if (model.transport === 'responses') {
        const response = await client.responses.create({
          ...this.responsesParams(options, model),
          stream: false,
        });
        return this.fromResponse(response, options.model);
      }
      const completion = await client.chat.completions.create({
        ...this.chatParams(options, model),
        stream: false,
      });
      const choice = completion.choices[0];
      const message = choice?.message;
      if (!message) throw new Error('No message returned by the model');
      if (choice.finish_reason === 'length' && message.tool_calls?.length) {
        throw new Error('Tool call output was truncated');
      }
      return this.fromChat(message, completion.model, options.model, this.chatUsage(completion));
    } catch (error) {
      throw this.requestError(error, 'request');
    }
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const model = this.requestModel(options, this.client);
    if (model.transport === 'responses') {
      const stream = this.client.responses.stream({
        ...this.responsesParams(options, model),
        stream: true,
      });
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            yield { content: event.delta, done: false, model: options.model };
          } else if (event.type === 'response.refusal.delta') {
            yield { content: event.delta, done: false, model: options.model };
          }
        }
        // SDK assembly is indexed by output item and handles interleaved calls.
        const response = this.fromResponse(await stream.finalResponse(), options.model);
        yield { ...response, content: '', done: true };
      } catch (error) {
        throw this.requestError(error, 'stream');
      } finally {
        stream.abort();
      }
      return;
    }

    let stream: Stream<ChatCompletionChunk> | undefined;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const reasoning: Record<string, unknown>[] = [];
    let usage: LLMUsage | undefined;
    let responseModel = options.model;
    let text = '';
    let refusal = '';
    let finished = false;
    try {
      stream = await this.client.chat.completions.create({
        ...this.chatParams(options, model),
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) {
        responseModel = chunk.model || responseModel;
        if (chunk.usage) usage = this.chatUsage(chunk);
        const choice = chunk.choices.find((candidate) => candidate.index === 0);
        if (!choice) continue;
        if (choice.finish_reason) {
          if (choice.finish_reason === 'length' && calls.size)
            throw new Error('Tool call output was truncated');
          finished = true;
        }
        const delta = choice.delta;
        if (delta.content) {
          text += delta.content;
          yield { content: delta.content, done: false, model: responseModel };
        }
        if (delta.refusal) {
          refusal += delta.refusal;
          yield { content: delta.refusal, done: false, model: responseModel };
        }
        for (const call of delta.tool_calls ?? []) {
          const accumulated = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
          if (call.id) accumulated.id = call.id;
          if (call.function?.name) accumulated.name += call.function.name;
          accumulated.arguments += call.function?.arguments ?? '';
          calls.set(call.index, accumulated);
        }
        // OpenRouter reasoning details are opaque continuation, never visible text.
        const details: unknown = (delta as unknown as Record<string, unknown>).reasoning_details;
        if (Array.isArray(details)) {
          for (const detail of details) {
            if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
              throw new Error('Invalid reasoning detail');
            }
            // The gateway documents an ordered sequence of blocks; index is optional.
            // Never invent a merge rule for encrypted data or signatures.
            reasoning.push(detail as Record<string, unknown>);
          }
        }
      }
      if (!finished) throw new Error('Stream ended before the model finished');
      const message: ChatMessage = {
        role: 'assistant',
        content: text || null,
        refusal: refusal || null,
        ...(calls.size && {
          tool_calls: [...calls]
            .sort(([left], [right]) => left - right)
            .map(([, call]) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
        }),
        ...(reasoning.length && { reasoning_details: reasoning }),
      };
      yield {
        ...this.fromChat(message, responseModel, options.model, usage),
        content: '',
        done: true,
      };
    } catch (error) {
      throw this.requestError(error, 'stream');
    } finally {
      stream?.controller.abort();
    }
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const embeddingModel = model || this.getEmbeddingModels()[0];
    try {
      const response = await this.embeddingClient.embeddings.create({
        model: embeddingModel,
        input: text,
        encoding_format: 'float',
      });
      const embedding = response.data[0]?.embedding;
      if (!embedding) throw new Error('No embedding returned by the model');
      return {
        embedding,
        model: embeddingModel,
        usage: response.usage
          ? { promptTokens: response.usage.prompt_tokens, totalTokens: response.usage.total_tokens }
          : undefined,
      };
    } catch (error) {
      throw this.requestError(error, 'embedding request');
    }
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const extension = path.extname(imagePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) throw new Error('Unsupported image format');
    const image = await fs.promises.readFile(imagePath);
    return this.analyzeImageFromBase64(
      `data:${mimeType};base64,${image.toString('base64')}`,
      options
    );
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const start = Date.now();
    try {
      const response = await this.generateWithClient(
        {
          model: options.model || this.getVisionModels()[0],
          temperature: options.temperature ?? 0.1,
          maxTokens: options.maxTokens ?? 1000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: options.prompt || 'Analyze this image and describe what you see in detail.',
                },
                {
                  type: 'image_url',
                  image_url: { url: base64Data, detail: options.detail ?? 'auto' },
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
        'OpenAI vision analysis failed',
        this.name,
        error instanceof Error ? error : undefined
      );
    }
  }

  getEmbeddingProvider(): LLMProvider {
    return {
      name: 'openai-embedding',
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
      name: 'openai-vision',
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
