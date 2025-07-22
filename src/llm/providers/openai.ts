import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig, LLMMessage } from '../types';
import OpenAI from 'openai';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable.');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config?.baseUrl || process.env.OPENAI_BASE_URL
    });
  }

  getSupportedModels(): string[] {
    return [
      'gpt-4o',
      'gpt-4o-mini', 
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k'
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
            ? JSON.parse(tc.function.arguments)
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

    const toolCalls: any[] = [];

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
          ...tc,
          function: {
            ...tc.function,
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

  private prepareMessages(options: LLMRequestOptions): LLMMessage[] {
    const messages = [...options.messages];
    
    // Add system prompt if provided and no system message exists
    if (options.systemPrompt && !messages.some(m => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }
    
    return messages;
  }
}