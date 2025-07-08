// Provider-related constants
export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
};

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

// Default Provider configuration
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_CLAUDE_API_VERSION = '2023-06-01';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

// Default model configs - top 4 most popular models (2025)
export const DEFAULT_MODEL_CONFIGS = {
  openai: {
    "gpt-4o": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 128000
    },
    "gpt-4o-mini": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 128000
    },
    "o3": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 200000
    },
    "o3-mini": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 200000
    }
  },
  ollama: {
    "llama3.3:70b": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 131072
    },
    "deepseek-r1:8b": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 32768
    },
    "qwen2.5:32b": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 32768
    },
    "llama3.2": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 32768
    }
  },
  claude: {
    "claude-sonnet-4-20250514": {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      apiVersion: DEFAULT_CLAUDE_API_VERSION,
      temperature: 0.7,
      maxTokens: 200000
    },
    "claude-opus-4-20250514": {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      apiVersion: DEFAULT_CLAUDE_API_VERSION,
      temperature: 0.7,
      maxTokens: 200000
    },
    "claude-3-7-sonnet-20250224": {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      apiVersion: DEFAULT_CLAUDE_API_VERSION,
      temperature: 0.7,
      maxTokens: 200000
    },
    "claude-3-5-sonnet-20241022": {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      apiVersion: DEFAULT_CLAUDE_API_VERSION,
      temperature: 0.7,
      maxTokens: 8192
    }
  },
  gemini: {
    "gemini-2.5-pro": {
      apiKey: process.env.GOOGLE_API_KEY || '',
      baseUrl: process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2097152
    },
    "gemini-2.0": {
      apiKey: process.env.GOOGLE_API_KEY || '',
      baseUrl: process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2097152
    },
    "gemini-1.5-pro": {
      apiKey: process.env.GOOGLE_API_KEY || '',
      baseUrl: process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2097152
    },
    "gemini-1.5-flash": {
      apiKey: process.env.GOOGLE_API_KEY || '',
      baseUrl: process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      temperature: 0.7,
      maxTokens: 1048576
    }
  }
}; 