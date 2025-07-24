export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, string | number | boolean | null>;
  };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'object' | 'array';
        description?: string;
        enum?: Array<string | number>;
        items?: { type: string };
        properties?: Record<string, {
          type: 'string' | 'number' | 'boolean' | 'object' | 'array';
          description?: string;
        }>;
      }>;
      required?: string[];
    };
  };
}

export interface LLMRequestOptions {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  systemPrompt?: string;
  tools?: Tool[];
}

export interface LLMResponse {
  content: string;
  model: string;
  toolCalls?: ToolCall[];
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
  toolCalls?: ToolCall[];
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