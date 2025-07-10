import { TokenBudgetConfig, PriorityWeights } from "../types/memory";

/**
 * Default token budget configuration
 * 40% immediate, 35% summarized, 25% persistent
 */
export const DEFAULT_TOKEN_BUDGET: TokenBudgetConfig = {
  total: 4000,
  immediate: 1600,    // 40%
  summarized: 1400,   // 35%
  persistent: 1000    // 25%
};

/**
 * Default priority weights for content retention
 */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  recency: 0.3,      // Recent messages
  frequency: 0.2,    // Frequently repeated topics
  importance: 0.25,  // Important information
  userInteraction: 0.15, // User interaction level
  sentiment: 0.1     // Emotional intensity
};