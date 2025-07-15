// Provider-related constants
export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
};

// Default Provider configuration
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_CLAUDE_API_VERSION = '2023-06-01';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

// Default model parameters
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 4096;

// Default embedding models
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';