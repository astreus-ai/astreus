// Provider type definitions
export type ProviderType = "openai" | "ollama" | "claude" | "gemini";

// Base model configuration interface
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

// OpenAI-specific model configuration
export interface OpenAIModelConfig extends ModelConfig {
  /** Optional: API key for authentication, defaults to OPENAI_API_KEY env var */
  apiKey?: string;
  /** Optional: Base URL for API, defaults to OPENAI_BASE_URL env var or standard OpenAI URL */
  baseUrl?: string;
  /** Optional: Organization ID for API requests */
  organization?: string;
}

// Ollama-specific model configuration
export interface OllamaModelConfig extends ModelConfig {
  /** Optional: Base URL for Ollama API, defaults to OLLAMA_BASE_URL env var or http://localhost:11434 */
  baseUrl?: string;
}

// Claude (Anthropic) specific model configuration
export interface ClaudeModelConfig extends ModelConfig {
  /** Optional: API key for authentication, defaults to ANTHROPIC_API_KEY env var */
  apiKey?: string;
  /** Optional: Base URL for API, defaults to ANTHROPIC_BASE_URL env var or standard Anthropic URL */
  baseUrl?: string;
  /** Optional: API version, defaults to latest stable version */
  apiVersion?: string;
}

// Gemini (Google) specific model configuration
export interface GeminiModelConfig extends ModelConfig {
  /** Optional: API key for authentication, defaults to GOOGLE_API_KEY env var */
  apiKey?: string;
  /** Optional: Base URL for API, defaults to GOOGLE_BASE_URL env var or standard Google URL */
  baseUrl?: string;
  /** Optional: Project ID for Google Cloud */
  projectId?: string;
}

// Union type for all model configurations
export type ProviderModelConfig = OpenAIModelConfig | OllamaModelConfig | ClaudeModelConfig | GeminiModelConfig;

// Provider configuration interface
export interface ProviderConfig {
  /** Required: Type of the provider (openai, ollama, claude, or gemini) */
  type: ProviderType;
  /** Optional: Simple format - just specify model name (exclusive with models) */
  model?: string;
  /** Optional: Traditional format with array of models (exclusive with model) */
  models?: (ProviderModelConfig | string)[];
  /** Optional: Default model to use, inferred from model if only one is provided */
  defaultModel?: string;
  /** Optional: Model to use for generating embeddings, defaults to "text-embedding-3-small" for OpenAI */
  embeddingModel?: string;
  /** Optional: API key for authentication (provider-specific) */
  apiKey?: string;
  /** Optional: Base URL for API (provider-specific) */
  baseUrl?: string;
  /** Optional: Organization ID (OpenAI-specific) */
  organization?: string;
}

// Content types for multimodal messages
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageUrlContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface ImageFileContent {
  type: "image_file";
  image_file: {
    path: string;
    mimeType?: string;
  };
}

export interface DocumentContent {
  type: "document";
  document: {
    path: string;
    filename: string;
    mimeType: string;
  };
}

export type MessageContent = TextContent | ImageUrlContent | ImageFileContent | DocumentContent;

// Provider message interface for chat completions
export interface ProviderMessage {
  /** Required: Role of the message sender */
  role: "system" | "user" | "assistant";
  /** Required: Content of the message - can be string for simple text or array for multimodal */
  content: string | MessageContent[];
}

// Provider tool interface for function calling
export interface ProviderTool {
  name: string;
  description?: string;
  parameters?: any; // Supports both array of parameters and structured JSONSchema
}

// Tool parameter schema interface
export interface ProviderToolParameterSchema {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "null" | "integer";
  description?: string;
  required?: boolean;
  enum?: string[] | number[] | boolean[];
  format?: string;
}

// Completion options interface
export interface CompletionOptions {
  tools?: ProviderTool[];
  toolCalling?: boolean;
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
}

// Provider tool call interface for structured responses
export interface ProviderToolCall {
  type: string;
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// Structured completion response interface
export interface StructuredCompletionResponse {
  content: string;
  tool_calls: ProviderToolCall[];
}

// Provider model interface
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
  
  /**
   * Stream completion with real-time response chunks (optional)
   * @param messages Array of messages to send to the model
   * @param options Additional options like tools to use
   * @param onChunk Callback function to handle each chunk
   * @returns The complete response text
   */
  streamComplete?(
    messages: ProviderMessage[], 
    options?: CompletionOptions,
    onChunk?: (chunk: string) => void
  ): Promise<string>;
  
  /**
   * Generate embeddings for text (optional)
   * @param text Text to generate embeddings for
   * @returns Vector embedding array
   */
  generateEmbedding?(text: string): Promise<number[]>;
}

// Provider instance interface
export interface ProviderInstance {
  type: ProviderType;
  
  /**
   * Get a specific model by name
   * @param name Name of the model to retrieve
   * @returns Provider model instance
   */
  getModel(name: string): ProviderModel;
  
  /**
   * List all available model names
   * @returns Array of model names
   */
  listModels(): string[];
  
  /**
   * Get the default model name (optional)
   * @returns Default model name or null if none set
   */
  getDefaultModel?(): string | null;
  
  /**
   * Get the embedding model (optional)
   * @returns Embedding model instance, name, or null
   */
  getEmbeddingModel?(): ProviderModel | string | null;
  
  /**
   * Generate embeddings using the provider's embedding model (optional)
   * @param text Text to generate embeddings for
   * @returns Vector embedding array or null if not supported
   */
  generateEmbedding?(text: string): Promise<number[] | null>;
  
  /**
   * Test the embedding model functionality (optional)
   * @param modelName Optional model name to test
   * @returns Whether the embedding model is available and working
   */
  testEmbeddingModel?(modelName?: string): Promise<boolean>;
}

// Provider factory function type
export type ProviderFactory = (config: ProviderConfig) => ProviderInstance;
