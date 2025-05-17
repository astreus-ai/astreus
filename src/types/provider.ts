// Provider type
export type ProviderType = "openai" | "ollama";

// Base model configuration
export interface ModelConfig {
  /** Required: Name of the model */
  name: string;
  /** Optional: Maximum context window size in tokens */
  contextWindow?: number;
  /** Optional: Temperature for generation (0-1), defaults to 0.7 */
  temperature?: number;
  /** Optional: Maximum tokens to generate, dependent on model */
  maxTokens?: number;
}

// Provider-specific model configurations
export interface OpenAIModelConfig extends ModelConfig {
  /** Optional: API key for authentication, defaults to OPENAI_API_KEY env var */
  apiKey?: string;
  /** Optional: Base URL for API, defaults to OPENAI_BASE_URL env var */
  baseUrl?: string;
  /** Optional: Organization ID for API requests */
  organization?: string;
}

export interface OllamaModelConfig extends ModelConfig {
  /** Optional: Base URL for Ollama API, defaults to OLLAMA_BASE_URL env var or http://localhost:11434 */
  baseUrl?: string;
}

// Combined model configuration
export type ProviderModelConfig = OpenAIModelConfig | OllamaModelConfig;

// Provider configuration
export interface ProviderConfig {
  /** Required: Type of the provider (openai or ollama) */
  type: ProviderType;
  /** Optional: Simple format - just specify model name (exclusive with models) */
  model?: string;
  /** Optional: Traditional format with array of models (exclusive with model) */
  models?: (ProviderModelConfig | string)[];
  /** Optional: Default model to use, inferred from model if only one is provided */
  defaultModel?: string;
  /** Optional: Model to use for generating embeddings, defaults to "text-embedding-3-small" for OpenAI */
  embeddingModel?: string;
}

// Message type for provider
export interface ProviderMessage {
  /** Required: Role of the message sender */
  role: "system" | "user" | "assistant";
  /** Required: Content of the message */
  content: string;
}

// Provider tools
export interface ProviderTool {
  name: string;
  description?: string;
  parameters?: any; // Supports both array of parameters and structured JSONSchema
}

// Tool parameter for easier use
export interface ProviderToolParameterSchema {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "null" | "integer";
  description?: string;
  required?: boolean;
  enum?: string[] | number[] | boolean[];
  format?: string;
}

// Completion options for more advanced model calls
export interface CompletionOptions {
  tools?: ProviderTool[];
  toolCalling?: boolean;
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
}

// Provider tool call response structure
export interface ProviderToolCall {
  type: string;
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// Structured response with tool calls
export interface StructuredCompletionResponse {
  content: string;
  tool_calls: ProviderToolCall[];
}

// Provider model instance
export interface ProviderModel {
  provider: ProviderType;
  name: string;
  config: ModelConfig;
  
  /**
   * Complete a prompt with messages
   * @param messages Array of messages to send to the model
   * @param options Additional options like tools to use
   * @returns The completion text or structured response with tool calls
   */
  complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | StructuredCompletionResponse>;
  generateEmbedding?(text: string): Promise<number[]>; // Optional method to generate embeddings
}

// Provider instance
export interface ProviderInstance {
  type: ProviderType;
  getModel(name: string): ProviderModel;
  listModels(): string[];
  getDefaultModel?(): string | null; // Get default model name
  getEmbeddingModel?(): ProviderModel | string | null; // Updated to allow returning string or ProviderModel or null
  generateEmbedding?(text: string): Promise<number[] | null>; // Optional method to generate embeddings
}

// Provider factory function type
export type ProviderFactory = (config: ProviderConfig) => ProviderInstance;
