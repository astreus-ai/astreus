// Astreus - AI Agent Framework

import { logger } from './utils/logger';
import { createAgent } from './agent/';
import { createProvider } from './provider/';
import { createMemory } from './memory/';
import { createDatabase } from './database/';
import { createRAG, parsePDF } from './rag/';
import { createVectorDatabaseConnector, loadVectorDatabaseConfigFromEnv } from './rag/vector-db';
import { createChat } from './chat/';
import { PersonalityFactory } from './personality/';

// Convenience function to create personality manager
export const createPersonalityManager = PersonalityFactory.create;

export { createAgent };
export { createProvider };
export { createMemory };
export { createDatabase };
export { createRAG };
export { createChat };
export { parsePDF };
export { logger };
export { createVectorDatabaseConnector, loadVectorDatabaseConfigFromEnv };
export { PersonalityFactory };

export * from './types';
// Re-export configurations from each module
export { 
  DEFAULT_AGENT_NAME, 
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE as AGENT_DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS as AGENT_DEFAULT_MAX_TOKENS
} from "./agent/config";

export * from "./context/config";
export * from "./database/config";
export * from "./memory/config";

export { 
  PROVIDER_TYPES,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_CLAUDE_BASE_URL,
  DEFAULT_CLAUDE_API_VERSION,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_TEMPERATURE as PROVIDER_DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS as PROVIDER_DEFAULT_MAX_TOKENS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL
} from "./provider/config";

export * from "./rag/config";
export * from "./tasks/config";
export * from "./personality/config";
export * from "./utils/errors";
export * from "./utils";
export * from "./tasks/";
export * from "./context/";
export * from "./personality/";
export { validateRequiredParam, validateRequiredParams } from "./utils/validation";
export { PluginRegistry } from "./plugin/";
