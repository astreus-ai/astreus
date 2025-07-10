// RAG-related constants
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_VECTOR_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_MAX_RESULTS = 10;

// Token management constants
export const MAX_CONTEXT_TOKENS = 100000; // Conservative limit (less than OpenAI's 128k)
export const MAX_TOKENS_PER_CHUNK = 2000; // Maximum tokens to include per chunk in tool response
export const AVERAGE_CHARS_PER_TOKEN = 4; // Approximate character-to-token ratio
export const MAX_CHUNK_CONTENT_LENGTH = MAX_TOKENS_PER_CHUNK * AVERAGE_CHARS_PER_TOKEN; // ~8000 chars per chunk
export const RESERVED_TOKENS_FOR_SYSTEM = 10000; // Reserve tokens for system prompt, conversation history, etc.