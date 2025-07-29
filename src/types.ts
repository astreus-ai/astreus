/**
 * Common types used throughout the Astreus codebase
 */

/**
 * Primitive types that can be stored as metadata values
 */
export type MetadataPrimitive = string | number | boolean | Date | null;

/**
 * Complex metadata value that can contain primitives, arrays, or nested objects
 */
export type MetadataValue = 
  | MetadataPrimitive
  | MetadataPrimitive[]
  | { [key: string]: MetadataValue };

/**
 * Type for metadata objects used throughout the application.
 * Provides type safety while maintaining flexibility for various metadata use cases.
 */
export type MetadataObject = Record<string, MetadataValue>;