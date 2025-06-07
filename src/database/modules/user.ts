import { v4 as uuidv4 } from "uuid";
import { createDatabase } from "../../database";
import { logger } from "../../utils";

/**
 * Create a user and save to database
 */
export async function createUser(username: string): Promise<string> {
  try {
    // Generate user ID
    const id = uuidv4();

    // Get database instance
    const db = await createDatabase();
    const tableNames = db.getTableNames();

    // Save user to database
    await db.getTable(tableNames.users).insert({
      id,
      username,
      createdAt: new Date(),
    });

    logger.success(`User created with ID: ${id}`);
    return id;
  } catch (error) {
    logger.error("Error creating user:", error);
    throw error;
  }
}

/**
 * Get user by ID
 */
export async function getUserById(id: string): Promise<any | null> {
  try {
    const db = await createDatabase();
    const tableNames = db.getTableNames();
    return await db.getTable(tableNames.users).findOne({ id });
  } catch (error) {
    logger.error("Error getting user by ID:", error);
    throw error;
  }
}

/**
 * Get user by username
 */
export async function getUserByUsername(username: string): Promise<any | null> {
  try {
    const db = await createDatabase();
    const tableNames = db.getTableNames();
    return await db.getTable(tableNames.users).findOne({ username });
  } catch (error) {
    logger.error("Error getting user by username:", error);
    throw error;
  }
}

/**
 * Update user
 */
export async function updateUser(id: string, data: Record<string, any>): Promise<boolean> {
  try {
    const db = await createDatabase();
    const tableNames = db.getTableNames();
    const result = await db.getTable(tableNames.users).update({ id }, data);
    return result > 0;
  } catch (error) {
    logger.error("Error updating user:", error);
    throw error;
  }
}

/**
 * Delete user
 */
export async function deleteUser(id: string): Promise<boolean> {
  try {
    const db = await createDatabase();
    const tableNames = db.getTableNames();
    const result = await db.getTable(tableNames.users).delete({ id });
    return result > 0;
  } catch (error) {
    logger.error("Error deleting user:", error);
    throw error;
  }
} 