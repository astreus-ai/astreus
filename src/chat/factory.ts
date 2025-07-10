import { ChatConfig, ChatInstance } from "../types/chat";
import { logger } from "../utils/logger";
import { validateRequiredParam } from "../utils/validation";
import { ChatService } from "./service";

/**
 * Factory function to create a chat management system
 */
export async function createChat(config: ChatConfig): Promise<ChatInstance> {
  validateRequiredParam(config, "config", "createChat");
  validateRequiredParam(config.database, "config.database", "createChat");
  validateRequiredParam(config.memory, "config.memory", "createChat");
  // Provider validation is handled by the ChatManager constructor

  logger.info("System", "ChatFactory", "Creating chat management system");

  const tableName = config.tableName || "chats";

  // Ensure the chats table exists
  await config.database.ensureTable(tableName, (table) => {
    table.string("id").primary();
    table.string("title").nullable();
    table.string("userId").nullable().index();
    table.string("agentId").notNullable().index();
    table.enum("status", ["active", "archived", "deleted"]).defaultTo("active");
    table.timestamp("createdAt").defaultTo(config.database.knex.fn.now());
    table.timestamp("updatedAt").defaultTo(config.database.knex.fn.now());
    table.timestamp("lastMessageAt").nullable();
    table.integer("messageCount").defaultTo(0);
    table.text("lastMessage").nullable();
    table.json("metadata").nullable();
  });

  const chatService = new ChatService(config);

  logger.success("System", "ChatFactory", `Chat management system created with table: ${tableName}`);
  return chatService;
}