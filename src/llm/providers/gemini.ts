import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig, LLMMessage } from '../types';

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private apiKey: string;
  private baseUrl: string;

  constructor(config?: LLMConfig) {
    this.apiKey = config?.apiKey || process.env.GOOGLE_API_KEY || '';
    this.baseUrl = config?.baseUrl || process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1';
    
    if (!this.apiKey) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY environment variable.');
    }
  }

  getSupportedModels(): string[] {
    return [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-pro',
      'gemini-pro-vision'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const { systemInstruction, contents } = this.prepareMessages(options);
    
    const requestBody: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    };

    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await fetch(
      `${this.baseUrl}/models/${options.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      model: options.model,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount || 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { systemInstruction, contents } = this.prepareMessages(options);
    
    const requestBody: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    };

    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await fetch(
      `${this.baseUrl}/models/${options.model}:streamGenerateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
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
          if (line.trim() && line.startsWith('{')) {
            try {
              const parsed = JSON.parse(line);
              const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              
              if (content) {
                yield { content, done: false, model: options.model };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
      
      yield { content: '', done: true, model: options.model };
    } finally {
      reader.releaseLock();
    }
  }

  private prepareMessages(options: LLMRequestOptions): { systemInstruction?: string; contents: any[] } {
    let systemInstruction = options.systemPrompt;
    const messages = options.messages.filter(m => m.role !== 'system');
    
    // Find system message if no explicit system prompt
    if (!systemInstruction) {
      const systemMessage = options.messages.find(m => m.role === 'system');
      if (systemMessage) {
        systemInstruction = systemMessage.content;
      }
    }
    
    // Convert to Gemini format
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    
    return { systemInstruction, contents };
  }
}