// Re-export context components
export { AdaptiveContextManager } from "./processor";
export { ContextCompressor } from "./compression";
export { DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS } from "./config";

// Re-export context-related types
export * from "../types/memory";

// Re-export configuration
export * from "./config";

// Import provider types
import { ProviderModel } from "../types/provider";
import { AdaptiveContextManager } from "./processor";
import { ContextCompressor } from "./compression";
import { DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS } from "./config";

/**
 * Create an enhanced adaptive context manager with LLM integration
 * 
 * @param sessionId - Unique identifier for the session
 * @param provider - LLM provider for AI-powered context operations
 * @param maxTokens - Maximum tokens for the context window (default: 4000)
 * @param tokenBudget - Custom token budget configuration
 * @param priorityWeights - Custom priority weights configuration
 * @returns Configured AdaptiveContextManager with LLM capabilities
 */
export function createEnhancedContextManager(
  sessionId: string,
  provider: ProviderModel,
  maxTokens: number = 4000,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  priorityWeights = DEFAULT_PRIORITY_WEIGHTS
): AdaptiveContextManager {
  const manager = new AdaptiveContextManager(
    sessionId,
    maxTokens,
    tokenBudget,
    priorityWeights
  );
  
  // Set the provider for LLM-powered operations
  manager.setProvider(provider);
  
  return manager;
}

/**
 * Configure context compression with LLM provider
 * 
 * @param provider - LLM provider for AI-powered compression
 */
export function configureContextCompression(provider: ProviderModel): void {
  ContextCompressor.setProvider(provider);
}