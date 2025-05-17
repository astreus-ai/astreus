// Provider-related constants
export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
};

// Default Provider configuration
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

// Default OpenAI model configs
export const DEFAULT_MODEL_CONFIGS = {
  openai: {
    "gpt-4o": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 4096
    },
    "gpt-4o-mini": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2048
    },
    "gpt-4": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 4096
    },
    "gpt-3.5-turbo": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2048
    }
  },
  ollama: {
    "llama3": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 2048
    },
    "mistral": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 2048
    }
  }
}; 