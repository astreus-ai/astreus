// Astreus - AI Agent Framework

import { logger } from './utils/logger';
import { createAgent } from './agent/';
import { createProvider } from './provider/';
import { createMemory } from './memory/';
import { createDatabase } from './database/';
import { createRAG, parsePDF } from './rag/';
import { createVectorDatabaseConnector, loadVectorDatabaseConfigFromEnv } from './rag/vector-db';
import { createChat } from './chat/';

export { createAgent };
export { createProvider };
export { createMemory };
export { createDatabase };
export { createRAG };
export { createChat };
export { parsePDF };
export { logger };
export { createVectorDatabaseConnector, loadVectorDatabaseConfigFromEnv };

export * from './types';
// Re-export configurations from each module
export * from "./agent/config";
export * from "./context/config";
export * from "./database/config";
export * from "./memory/config";
export * from "./provider/config";
export * from "./rag/config";
export * from "./tasks/config";
export * from "./utils/errors";
export * from "./utils";
export * from "./tasks/";
export * from "./context/";
export { validateRequiredParam, validateRequiredParams } from "./utils/validation";
export { PluginRegistry } from "./plugin/";
