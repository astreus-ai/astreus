import { PersonalityManager } from "./manager";
import { PersonalityManagerInstance } from "./types";
import { DatabaseInstance } from "../types";
import { logger } from "../utils";
import { validateRequiredParam } from "../utils/validation";

export class PersonalityFactory {
  /**
   * Create a personality manager instance with database support
   */
  static async create(database: DatabaseInstance): Promise<PersonalityManagerInstance> {
    validateRequiredParam(database, "database", "PersonalityFactory.create");
    
    logger.info("System", "PersonalityFactory", "Creating personality manager");
    
    const manager = new PersonalityManager(database);
    
    logger.success("System", "PersonalityFactory", "Personality manager created successfully");
    return manager;
  }
}