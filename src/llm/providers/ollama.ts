import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig, LLMMessage } from '../types';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private baseUrl: string;

  constructor(config?: LLMConfig) {
    this.baseUrl = config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  getSupportedModels(): string[] {
    return [
      'llama3.2',
      'llama3.1', 
      'mistral',
      'codellama',
      'phi3',
      'qwen2.5'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.prepareMessages(options);
    
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens ?? 4096
        },
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.message?.content || '',
      model: data.model || options.model,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const messages = this.prepareMessages(options);
    
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens ?? 4096
        },
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line);
              const content = parsed.message?.content || '';
              
              if (parsed.done) {
                yield { content: '', done: true, model: options.model };
                return;
              } else if (content) {
                yield { content, done: false, model: options.model };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
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