import { AgentConfig } from './types';
import { getDatabase } from '../database';
import { getLLM } from '../llm';

export class BaseAgent {
  public data: AgentConfig;

  constructor(data: AgentConfig) {
    this.data = data;
  }

  get config(): AgentConfig {
    return this.data;
  }

  static async create(config: AgentConfig): Promise<BaseAgent> {
    const db = getDatabase();
    const agentData = await db.createAgent(config);
    return new BaseAgent(agentData);
  }

  static async findById(id: number): Promise<BaseAgent | null> {
    const db = getDatabase();
    const agentData = await db.getAgent(id);
    return agentData ? new BaseAgent(agentData) : null;
  }

  static async findByName(name: string): Promise<BaseAgent | null> {
    const db = getDatabase();
    const agentData = await db.getAgentByName(name);
    return agentData ? new BaseAgent(agentData) : null;
  }

  static async list(): Promise<BaseAgent[]> {
    const db = getDatabase();
    const agentsData = await db.listAgents();
    return agentsData.map(data => new BaseAgent(data));
  }

  async update(updates: Partial<AgentConfig>): Promise<void> {
    const db = getDatabase();
    const updatedData = await db.updateAgent(this.data.id!, updates);
    if (updatedData) {
      this.data = updatedData;
    }
  }

  async delete(): Promise<boolean> {
    const db = getDatabase();
    return db.deleteAgent(this.data.id!);
  }

  getId(): number {
    return this.data.id!;
  }

  getName(): string {
    return this.data.name;
  }

  getDescription(): string | undefined {
    return this.data.description;
  }

  getModel(): string | undefined {
    return this.data.model;
  }

  getTemperature(): number | undefined {
    return this.data.temperature;
  }

  getMaxTokens(): number | undefined {
    return this.data.maxTokens;
  }

  getSystemPrompt(): string | undefined {
    return this.data.systemPrompt;
  }

  getCreatedAt(): Date {
    return this.data.createdAt!;
  }

  getUpdatedAt(): Date {
    return this.data.updatedAt!;
  }

  hasMemory(): boolean {
    return this.data.memory || false;
  }

  hasKnowledge(): boolean {
    return this.data.knowledge || false;
  }

  canUseTools(): boolean {
    return this.data.useTools !== false; // Default true
  }

  async ask(prompt: string, options?: { useTools?: boolean; [key: string]: any }): Promise<string> {
    // Check if tools should be used
    const shouldUseTools = options?.useTools !== undefined ? options.useTools : this.canUseTools();
    
    // If we have executeTaskWithTools method and should use tools
    if (shouldUseTools && typeof (this as any).executeTaskWithTools === 'function') {
      const result = await (this as any).executeTaskWithTools(prompt, {
        enableTools: true,
        stream: false
      });
      return result.response;
    }
    
    // Fallback to simple LLM call without tools
    const llm = getLLM();
    const response = await llm.generateResponse({
      model: this.data.model || 'gpt-4',
      messages: [
        ...(this.data.systemPrompt ? [{ role: 'system' as const, content: this.data.systemPrompt }] : []),
        { role: 'user' as const, content: prompt }
      ],
      temperature: this.data.temperature,
      maxTokens: this.data.maxTokens,
      ...options
    });
    
    return response.content;
  }

  toJSON() {
    return {
      id: this.data.id,
      name: this.data.name,
      description: this.data.description,
      model: this.data.model,
      temperature: this.data.temperature,
      maxTokens: this.data.maxTokens,
      systemPrompt: this.data.systemPrompt,
      memory: this.data.memory,
      knowledge: this.data.knowledge,
      useTools: this.data.useTools,
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt
    };
  }
}