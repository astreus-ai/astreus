import { MemoryConfig, MemoryFactory } from "../types";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { MemoryStorage } from "./storage";

/**
 * Factory function to create a new memory instance
 * @param config Configuration for the memory instance
 * @returns Promise that resolves to the new memory instance
 */
export const createMemory: MemoryFactory = async (config: MemoryConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createMemory");
  validateRequiredParams(
    config,
    ["database"],
    "createMemory"
  );
  
  return MemoryStorage.create(config);
};