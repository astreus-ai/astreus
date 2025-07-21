export interface AgentConfig {
  id?: number;
  name: string;
  description?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  memory?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}