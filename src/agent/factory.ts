import { AgentConfig, AgentFactory } from "../types";
import { logger } from "../utils";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { DEFAULT_AGENT_NAME } from "./config";
import { createDatabase } from "../database/";
import { Agent } from "./agent";

// Agent factory function
export const createAgent: AgentFactory = async (config: AgentConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createAgent");
  validateRequiredParams(
    config,
    ["memory"],
    "createAgent"
  );
  
  logger.info("System", "AgentFactory", `Creating new agent: ${config.name || DEFAULT_AGENT_NAME}`);
  
  // Ensure either model or provider is specified
  if (!config.model && !config.provider) {
    logger.error("System", "AgentFactory", "Either 'model' or 'provider' must be specified in agent config");
    throw new Error("Either 'model' or 'provider' must be specified in agent config");
  }
  
  // Create a new agent instance
  const agent = new Agent(config);

  // Save agent to database
  try {
    logger.debug(agent.config.name, "Database", "Saving agent to database");
    // Use database from config if provided, otherwise create a new one
    const db = config.database || await createDatabase();
    const tableNames = db.getTableNames();
    
    // Ensure agents table exists
    await db.ensureTable(tableNames.agents, (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.text("description").nullable();
      table.text("systemPrompt").nullable();
      table.string("modelName").notNullable();
      table.timestamp("createdAt").defaultTo(db.knex.fn.now());
      table.timestamp("updatedAt").defaultTo(db.knex.fn.now());
      table.json("configuration").nullable();
    });

    const agentsTable = db.getTable(tableNames.agents);

    // Check if agent already exists
    const existingAgent = await agentsTable.findOne({ id: agent.id });

    if (!existingAgent) {
      // Save new agent
      await agentsTable.insert({
        id: agent.id,
        name: agent.config.name,
        description: agent.config.description || null,
        systemPrompt: agent.config.systemPrompt || null,
        modelName: agent.config.model?.name || "unknown",
        createdAt: new Date(),
        updatedAt: new Date(),
        configuration: JSON.stringify({
          hasTools: agent.getAvailableTools().length > 0,
          supportsTaskSystem: true,
        }),
      });
      logger.success(agent.config.name, "Database", `Saved with ID: ${agent.id}`);
    } else {
      // Update existing agent
      await agentsTable.update(
        { id: agent.id },
        {
          name: agent.config.name,
          description: agent.config.description || null,
          systemPrompt: agent.config.systemPrompt || null,
          modelName: agent.config.model?.name || "unknown",
          updatedAt: new Date(),
          configuration: JSON.stringify({
            hasTools: agent.getAvailableTools().length > 0,
            supportsTaskSystem: true,
          }),
        }
      );
      logger.success(agent.config.name, "Database", `Updated with ID: ${agent.id}`);
    }
  } catch (error) {
    logger.error(agent.config.name, "Database", `Save failed: ${error}`);
  }

  logger.success("System", "AgentFactory", `Agent created successfully: ${agent.config.name} (${agent.id})`);
  return agent;
};