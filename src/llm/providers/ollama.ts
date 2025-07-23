import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig } from '../types';
import { Ollama, Message, ChatResponse, ToolCall } from 'ollama';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private client: Ollama;

  constructor(config?: LLMConfig) {
    const baseUrl = config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    
    this.client = new Ollama({
      host: baseUrl
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
      'vicuna'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.prepareMessages(options);
    
    const response = await this.client.chat({
      model: options.model,
      messages,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096
      },
      stream: false,
      tools: options.tools?.map(tool => ({
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      }))
    }) as ChatResponse;

    // Extract tool calls from Ollama's response (if supported)
    const toolCalls = response.message?.tool_calls?.map((tc: ToolCall) => ({
      id: tc.function?.name || 'tool-call',
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || {}
      }
    })) || [];
    
    return {
      content: response.message?.content || '',
      model: response.model || options.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.prompt_eval_count || 0,
        completionTokens: response.eval_count || 0,
        totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0)
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const messages = this.prepareMessages(options);
    
    const stream = await this.client.chat({
      model: options.model,
      messages,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096
      },
      stream: true,
      tools: options.tools?.map(tool => ({
        type: 'function',
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      }))
    });

    const toolCalls: Array<{id: string; type: 'function'; function: {name: string; arguments: any}}> = [];

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
                arguments: tc.function.arguments || {}
              }
            });
          }
        }
        
        if (chunk.done) {
          yield { 
            content: '', 
            done: true, 
            model: options.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined
          };
          return;
        } else if (content) {
          yield { content, done: false, model: options.model };
        }
      }
    } catch (error) {
      throw new Error(`Ollama streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private prepareMessages(options: LLMRequestOptions): Message[] {
    const messages = [...options.messages];
    
    // Add system prompt if provided and no system message exists
    if (options.systemPrompt && !messages.some(m => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }
    
    // Convert messages to Ollama format (handles tool messages)
    return messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content
        } as Message;
      }
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: msg.role,
          content: msg.content || '',
          tool_calls: msg.tool_calls.map(tc => ({
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments
            }
          }))
        } as Message;
      }
      
      return {
        role: msg.role,
        content: msg.content
      } as Message;
    });
  }
}