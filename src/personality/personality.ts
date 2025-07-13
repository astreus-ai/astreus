import { v4 as uuidv4 } from "uuid";
import { PersonalityConfig, PersonalityInstance } from "./types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";

export class Personality implements PersonalityInstance {
  public id: string;
  public config: PersonalityConfig;

  constructor(config: PersonalityConfig) {
    validateRequiredParam(config, "config", "Personality constructor");
    validateRequiredParams(
      config,
      ["name", "prompt"],
      "Personality constructor"
    );

    this.id = config.id || uuidv4();
    this.config = {
      ...config,
      id: this.id,
      createdAt: config.createdAt || new Date(),
      updatedAt: config.updatedAt || new Date(),
      metadata: config.metadata || {}
    };

    logger.info("System", "Personality", `Created personality: ${this.config.name} (${this.id})`);
  }

  getPrompt(): string {
    return this.config.prompt;
  }

  async update(updates: Partial<PersonalityConfig>): Promise<void> {
    validateRequiredParam(updates, "updates", "update");

    this.config = {
      ...this.config,
      ...updates,
      id: this.id, // Ensure ID cannot be changed
      updatedAt: new Date()
    };

    logger.info("System", "Personality", `Updated personality: ${this.config.name} (${this.id})`);
    logger.debug("System", "Personality", `Updated fields: ${Object.keys(updates).join(', ')}`);
  }

  getMetadata(): Record<string, unknown> {
    return this.config.metadata || {};
  }

  // Utility method to get a summary of the personality
  getSummary(): {
    id: string;
    name: string;
    description?: string;
    createdAt?: Date;
    updatedAt?: Date;
  } {
    return {
      id: this.id,
      name: this.config.name,
      description: this.config.description,
      createdAt: this.config.createdAt,
      updatedAt: this.config.updatedAt
    };
  }
}