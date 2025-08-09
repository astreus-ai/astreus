/**
 * Centralized configuration for sensitive database fields that require encryption
 */

export const SENSITIVE_FIELDS: Record<string, string[]> = {
  // Agent configuration fields
  agents: ['systemPrompt', 'description'],

  // Memory system fields
  memories: ['content', 'metadata'],

  // Task system fields
  tasks: ['prompt', 'response', 'metadata'],

  // Knowledge system document fields
  knowledge_documents: ['content', 'title', 'metadata', 'file_path'],

  // Knowledge system chunk fields
  knowledge_chunks: ['content', 'metadata'],

  // Scheduler system fields
  scheduled_items: ['metadata'],
};

/**
 * Get sensitive fields for a specific table
 */
export function getSensitiveFields(tableName: string): string[] {
  return SENSITIVE_FIELDS[tableName] || [];
}

/**
 * Check if a field is sensitive for a given table
 */
export function isFieldSensitive(tableName: string, fieldName: string): boolean {
  const fields = getSensitiveFields(tableName);
  return fields.includes(fieldName);
}

/**
 * Validate that all sensitive fields are consistently defined
 */
export function validateSensitiveFieldsConfig(): void {
  const tables = Object.keys(SENSITIVE_FIELDS);

  for (const table of tables) {
    const fields = SENSITIVE_FIELDS[table];

    if (!Array.isArray(fields)) {
      throw new Error(`Sensitive fields for table '${table}' must be an array`);
    }

    if (fields.length === 0) {
      console.warn(`Warning: No sensitive fields defined for table '${table}'`);
    }

    // Check for duplicate field names
    const uniqueFields = new Set(fields);
    if (uniqueFields.size !== fields.length) {
      throw new Error(`Duplicate sensitive fields found for table '${table}'`);
    }
  }
}
