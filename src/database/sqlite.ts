import knex, { Knex } from "knex";
import { DatabaseConfig } from "../types";

/**
 * Create a SQLite database connection
 */
export function createSqliteDatabase(config: DatabaseConfig): Knex {
  return knex({
    client: "sqlite3",
    connection: {
      filename:
        typeof config.connection === "string" ? config.connection : ":memory:",
    },
    useNullAsDefault: true,
  });
}

/**
 * Create a SQLite database configuration
 */
export function createSqliteConfig(filename: string): DatabaseConfig {
  return {
    type: "sqlite",
    connection: filename,
  };
}
