export interface AgentConfig {
  id?: number;
  name: string;
  description?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  memory?: boolean;
  knowledge?: boolean;
  vision?: boolean;
  useTools?: boolean;
  contextCompression?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}