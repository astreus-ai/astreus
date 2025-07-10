// Re-export database components
export { Database } from "./database";
export { createDatabase } from "./factory";
export { createSqliteDatabase, createSqliteConfig } from "./sqlite";
export { createPostgresqlDatabase, createPostgresqlConfig } from "./postgresql";

// Re-export database modules
export { 
  createUser, 
  getUserById, 
  getUserByUsername, 
  updateUser, 
  deleteUser 
} from "./modules/user";

// Re-export types
export * from "../types/database";

// Re-export configuration
export * from "./config";