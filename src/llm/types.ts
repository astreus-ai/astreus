export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequestOptions {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  systemPrompt?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  model: string;
}

export interface LLMProvider {
  name: string;
  generateResponse(options: LLMRequestOptions): Promise<LLMResponse>;
  generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk>;
  getSupportedModels(): string[];
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}