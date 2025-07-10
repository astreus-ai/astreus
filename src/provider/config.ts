import {
  OpenAIModelConfig,
  OllamaModelConfig,
  ClaudeModelConfig,
  GeminiModelConfig,
} from "../types/provider";

// Provider-related constants
export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
};

// Default Provider configuration
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_CLAUDE_API_VERSION = '2023-06-01';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

/**
 * Default model configurations for each provider type
 */
export const DEFAULT_MODEL_CONFIGS = {
  openai: {
    "gpt-4o": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<OpenAIModelConfig, 'name'>,
    "gpt-4o-mini": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<OpenAIModelConfig, 'name'>,
    "gpt-4-turbo": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<OpenAIModelConfig, 'name'>,
    "gpt-3.5-turbo": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<OpenAIModelConfig, 'name'>,
  },
  ollama: {
    "llama3.1:8b": {
      temperature: 0.7,
      maxTokens: 2048,
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
    } as Omit<OllamaModelConfig, 'name'>,
    "llama3.1:70b": {
      temperature: 0.7,
      maxTokens: 2048,
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
    } as Omit<OllamaModelConfig, 'name'>,
    "mistral:7b": {
      temperature: 0.7,
      maxTokens: 2048,
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
    } as Omit<OllamaModelConfig, 'name'>,
  },
  claude: {
    "claude-3-5-sonnet-20241022": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<ClaudeModelConfig, 'name'>,
    "claude-3-opus-20240229": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<ClaudeModelConfig, 'name'>,
    "claude-3-haiku-20240307": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<ClaudeModelConfig, 'name'>,
  },
  gemini: {
    "gemini-1.5-pro": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<GeminiModelConfig, 'name'>,
    "gemini-1.5-flash": {
      temperature: 0.7,
      maxTokens: 4096,
    } as Omit<GeminiModelConfig, 'name'>,
  },
} as const;

// Available models for each provider - top 4 most popular (2025)
function getAvailableModels() {
  const models = {
    openai: [
      'gpt-4o',          // Flagship multimodal model
      'gpt-4o-mini',     // Cost-effective alternative
      'o3',              // Latest reasoning model
      'o3-mini'          // Faster reasoning model
    ],
    claude: [
      'claude-sonnet-4-20250514',    // Latest Sonnet 4 (May 2025)
      'claude-opus-4-20250514',      // Most powerful model (May 2025)
      'claude-3-7-sonnet-20250224',  // Hybrid reasoning model (Feb 2025)
      'claude-3-5-sonnet-20241022'   // Previous generation
    ],
    gemini: [
      'gemini-2.5-pro',     // Latest flagship model
      'gemini-2.0',         // Multimodal with agentic capabilities
      'gemini-1.5-pro',     // Previous generation pro
      'gemini-1.5-flash'    // Fast, efficient model
    ],
    ollama: [
      'llama3.3:70b',       // New state-of-the-art 70B model
      'llama3.2',           // Popular general-purpose model
      'deepseek-r1:8b',     // Advanced reasoning model
      'qwen2.5:32b'         // Multilingual powerhouse
    ]
  };

  return models;
}

export const AVAILABLE_MODELS = getAvailableModels();

/**
 * Default embedding models for each provider
 */
export const DEFAULT_EMBEDDING_MODELS = {
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  // Claude and Gemini don't have dedicated embedding endpoints in this config
} as const;

/**
 * Provider-specific configuration defaults
 */
export const PROVIDER_DEFAULTS = {
  openai: {
    temperature: 0.7,
    maxTokens: 4096,
    baseUrl: "https://api.openai.com/v1",
  },
  ollama: {
    temperature: 0.7,
    maxTokens: 2048,
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
  claude: {
    temperature: 0.7,
    maxTokens: 4096,
    baseUrl: "https://api.anthropic.com",
  },
  gemini: {
    temperature: 0.7,
    maxTokens: 4096,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
} as const;