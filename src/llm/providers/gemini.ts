import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.GOOGLE_API_KEY;
    
    if (!apiKey) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY environment variable.');
    }

    this.client = new GoogleGenerativeAI(apiKey);
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
    
    const model = this.client.getGenerativeModel({
      model: options.model,
      ...(systemInstruction && { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } }),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    });
    
    const response = result.response;
    const text = response.text() || '';
    
    return {
      content: text,
      model: options.model,
      usage: {
        promptTokens: 0, // Gemini doesn't provide detailed usage in basic response
        completionTokens: 0,
        totalTokens: 0
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { systemInstruction, contents } = this.prepareMessages(options);
    
    const model = this.client.getGenerativeModel({
      model: options.model,
      ...(systemInstruction && { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } }),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    });

    const result = await model.generateContentStream({
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096
      }
    });

    try {
      for await (const chunk of result.stream) {
        const text = chunk.text();
        
        if (text) {
          yield { content: text, done: false, model: options.model };
        }
      }
      
      yield { content: '', done: true, model: options.model };
    } catch (error) {
      throw new Error(`Gemini streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    
    // Convert messages to Gemini format
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    
    return { systemInstruction, contents };
  }
}