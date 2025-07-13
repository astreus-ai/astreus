// Personality system types

export interface PersonalityConfig {
  /** Unique identifier for the personality */
  id?: string;
  /** Name of the personality */
  name: string;
  /** Description of what this personality represents */
  description?: string;
  /** System prompt that defines the personality's behavior */
  prompt: string;
  /** Optional metadata for the personality */
  metadata?: Record<string, unknown>;
  /** When the personality was created */
  createdAt?: Date;
  /** When the personality was last updated */
  updatedAt?: Date;
}

export interface PersonalityInstance {
  /** Unique identifier for the personality */
  id: string;
  /** Configuration for the personality */
  config: PersonalityConfig;
  
  /** Get the personality's system prompt */
  getPrompt(): string;
  
  /** Update the personality configuration */
  update(updates: Partial<PersonalityConfig>): Promise<void>;
  
  /** Get personality metadata */
  getMetadata(): Record<string, unknown>;
}

export interface PersonalityManagerInstance {
  /** Create a new personality */
  create(config: Omit<PersonalityConfig, 'id'>): Promise<PersonalityInstance>;
  
  /** Get a personality by ID */
  get(id: string): Promise<PersonalityInstance | null>;
  
  /** List all personalities */
  list(limit?: number): Promise<PersonalityInstance[]>;
  
  /** Update a personality */
  update(id: string, updates: Partial<PersonalityConfig>): Promise<void>;
  
  /** Delete a personality */
  delete(id: string): Promise<void>;
  
  /** Search personalities by name or description */
  search(query: string): Promise<PersonalityInstance[]>;
}