import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  DatabaseConfig,
  DatabaseFactory,
} from "../types";
import { logger } from "../utils";
import { validateRequiredParams } from "../utils/validation";
import { DEFAULT_DB_PATH } from "./config";
import { Database } from "./database";

// Load environment variables
dotenv.config();

// Database factory function
export const createDatabase: DatabaseFactory = async (
  config?: DatabaseConfig
) => {
  logger.info("System", "DatabaseFactory", "Creating database instance");
  
  // If no config is provided, create a default one
  if (!config) {
    logger.debug("System", "DatabaseFactory", "No config provided, creating default configuration");
    // Determine which database to use based on environment variables
    const dbType = process.env.DATABASE_TYPE || "sqlite";

    if (dbType === "sqlite") {
      // For SQLite, create a default file-based database
      const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;
      
      // Create database directory if it doesn't exist (for file-based SQLite)
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.debug("System", "DatabaseFactory", `Created directory: ${dir}`);
      }
      
      config = {
        type: "sqlite",
        connection: dbPath,
      };
      
      logger.debug("System", "DatabaseFactory", `Using SQLite: ${dbPath}`);
    } else if (dbType === "postgresql") {
      // For PostgreSQL, use connection URL
      if (process.env.DATABASE_URL) {
        // Parse connection string
        const url = new URL(process.env.DATABASE_URL);
        const host = url.hostname;
        const port = parseInt(url.port || "5432");
        const user = url.username;
        const password = url.password;
        const database = url.pathname.substring(1); // Remove leading slash
        
        config = {
          type: "postgresql",
          connection: {
            host,
            port,
            user,
            password,
            database,
          },
        };
        
        logger.debug("System", "DatabaseFactory", `Using PostgreSQL: ${host}:${port}/${database}`);
      } else {
        logger.error("System", "DatabaseFactory", "PostgreSQL connection requires DATABASE_URL environment variable");
        throw new Error("PostgreSQL connection requires DATABASE_URL environment variable");
      }
    } else {
      logger.error("System", "DatabaseFactory", `Unsupported database type: ${dbType}`);
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  } else {
    logger.debug("System", "DatabaseFactory", `Using provided config: ${config.type}`);
    // Validate the provided config
    validateRequiredParams(
      config,
      ["type"],
      "createDatabase"
    );
  }

  // Create a new database instance
  const db = new Database(config);

  // Connect to the database
  await db.connect();

  // Only run legacy migrations, no auto table creation
  await db.initializeSchema();

  logger.success("System", "DatabaseFactory", `Database instance created and connected: ${config.type}`);
  return db;
};