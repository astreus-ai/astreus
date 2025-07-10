import { ProviderConfig, ProviderFactory } from "../types/provider";
import { logger } from "../utils/logger";
import { ProviderClient } from "./client";

/**
 * Factory function to create a provider instance
 */
export const createProvider: ProviderFactory = (config: ProviderConfig) => {
  logger.info("System", "ProviderFactory", `Creating ${config.type} provider`);
  
  const provider = new ProviderClient(config);
  
  logger.success("System", "ProviderFactory", `${config.type} provider created with ${provider.listModels().length} models`);
  return provider;
};