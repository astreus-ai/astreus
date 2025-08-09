export interface LLMMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export type LLMMessageContent = string | LLMMessageContentPart[];

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: LLMMessageContent;
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
      properties: Record<
        string,
        {
          type: 'string' | 'number' | 'boolean' | 'object' | 'array';
          description?: string;
          enum?: Array<string | number>;
          items?: { type: string };
          properties?: Record<
            string,
            {
              type: 'string' | 'number' | 'boolean' | 'object' | 'array';
              description?: string;
            }
          >;
        }
      >;
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

export interface VisionAnalysisOptions {
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  detail?: 'low' | 'high' | 'auto';
  model?: string; // Model to use for vision analysis (from agent config)
}

export interface VisionAnalysisResult {
  content: string;
  confidence?: number;
  metadata?: {
    model?: string;
    provider?: string;
    processingTime?: number;
    tokenUsage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  };
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  name: string;
  generateResponse(options: LLMRequestOptions): Promise<LLMResponse>;
  generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk>;
  getSupportedModels(): string[];
  getVisionModels(): string[];
  getEmbeddingModels(): string[];
  generateEmbedding?(text: string, model?: string): Promise<EmbeddingResult>;
  analyzeImage?(imagePath: string, options?: VisionAnalysisOptions): Promise<VisionAnalysisResult>;
  analyzeImageFromBase64?(
    base64Data: string,
    options?: VisionAnalysisOptions
  ): Promise<VisionAnalysisResult>;
  getEmbeddingProvider?(): LLMProvider;
  getVisionProvider?(): LLMProvider;
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string | null;
  defaultModel?: string;
  logger?: import('../logger/types').Logger;
}

// Type guard functions
export function isStringContent(content: LLMMessageContent): content is string {
  return typeof content === 'string';
}

export function isMultiModalContent(
  content: LLMMessageContent
): content is LLMMessageContentPart[] {
  return Array.isArray(content);
}

export function isTextContentPart(
  part: LLMMessageContentPart
): part is LLMMessageContentPart & { type: 'text'; text: string } {
  return part.type === 'text' && typeof part.text === 'string';
}

export function isImageContentPart(part: LLMMessageContentPart): part is LLMMessageContentPart & {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
} {
  return part.type === 'image_url' && !!part.image_url?.url;
}
