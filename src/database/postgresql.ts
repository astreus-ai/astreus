import knex, { Knex } from "knex";
import { DatabaseConfig } from "../types";

/**
 * Create a PostgreSQL database connection
 */
export function createPostgresqlDatabase(config: DatabaseConfig): Knex {
  return knex({
    client: "pg",
    connection: config.connection,
  });
}

/**
 * Create a PostgreSQL database configuration
 */
export function createPostgresqlConfig(
  connectionString: string
): DatabaseConfig {
  return {
    type: "postgresql",
    connection: connectionString,
  };
}
