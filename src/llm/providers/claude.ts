import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig, LLMMessage } from '../types';

export class ClaudeProvider implements LLMProvider {
  name = 'claude';
  private apiKey: string;
  private baseUrl: string;

  constructor(config?: LLMConfig) {
    this.apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config?.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    
    if (!this.apiKey) {
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable.');
    }
  }

  getSupportedModels(): string[] {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229', 
      'claude-3-haiku-20240307'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const { system, messages } = this.prepareMessages(options);
    
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        system,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.content?.[0]?.text || '',
      model: data.model,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { system, messages } = this.prepareMessages(options);
    
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        system,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
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
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            
            try {
              const parsed = JSON.parse(data);
              
              if (parsed.type === 'content_block_delta') {
                const content = parsed.delta?.text || '';
                if (content) {
                  yield { content, done: false, model: options.model };
                }
              } else if (parsed.type === 'message_stop') {
                yield { content: '', done: true, model: options.model };
                return;
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

  private prepareMessages(options: LLMRequestOptions): { system?: string; messages: Omit<LLMMessage, 'role'>[] } {
    let system = options.systemPrompt;
    const messages = options.messages.filter(m => m.role !== 'system');
    
    // Find system message if no explicit system prompt
    if (!system) {
      const systemMessage = options.messages.find(m => m.role === 'system');
      if (systemMessage) {
        system = systemMessage.content;
      }
    }
    
    // Claude expects messages without system role
    return {
      system,
      messages: messages.map(({ role, content }) => ({ 
        role: role as 'user' | 'assistant', 
        content 
      }))
    };
  }
}