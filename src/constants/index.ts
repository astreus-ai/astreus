// Default configuration constants
export const DEFAULT_AGENT_NAME = 'astreus-agent';
export const DEFAULT_MODEL = 'gpt-4';
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_MAX_TOKENS = 2000;

// Memory-related constants
export const DEFAULT_MEMORY_SIZE = 10;

// Database-related constants
export const DEFAULT_DB_PATH = './.astreus/db';

// Provider-related constants
export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
};

// Error messages
export const ERROR_MESSAGES = {
  MISSING_PARAMETER: 'Missing required parameter:',
  INVALID_PROVIDER: 'Invalid provider configuration',
  INVALID_MEMORY: 'Invalid memory configuration',
}; 