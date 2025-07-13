// Personality system exports
export * from "./types";
export * from "./config";
export * from "./personality";
export * from "./manager";
export * from "./factory";

// Re-export commonly used items
export { PersonalityFactory } from "./factory";
export { PersonalityManager } from "./manager";
export { Personality } from "./personality";
export type { 
  PersonalityConfig, 
  PersonalityInstance, 
  PersonalityManagerInstance 
} from "./types";