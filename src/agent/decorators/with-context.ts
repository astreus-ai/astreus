import { Context, initializeContextTable } from '../../context';
import { BaseAgent } from '../base';

export function withContext(BaseClass: typeof BaseAgent) {
  class ContextAgent extends BaseClass {
    public context?: Context;

    constructor(data: any) {
      super(data);
      this.context = new Context(
        this.getId(), 
        data.maxTokens || 4000,
        data.contextCompression ?? true,
        data.model || 'gpt-4o-mini',
        data.temperature || 0.3
      );
    }

    static async create(config: any) {
      const agent = await super.create(config);
      
      // Initialize context table for agent
      await initializeContextTable(agent.getId());
      (agent as any).context = new Context(
        agent.getId(),
        config.maxTokens || 4000,
        config.contextCompression ?? true,
        config.model || 'gpt-4o-mini',
        config.temperature || 0.3
      );
      
      return agent;
    }

    static async findById(id: number) {
      const agent = await super.findById(id);
      if (agent) {
        (agent as any).context = new Context(
          agent.getId(),
          agent.getMaxTokens() || 4000,
          (agent.data as any).contextCompression ?? true,
          (agent.data as any).model || 'gpt-4o-mini',
          (agent.data as any).temperature || 0.3
        );
      }
      return agent;
    }

    static async findByName(name: string) {
      const agent = await super.findByName(name);
      if (agent) {
        (agent as any).context = new Context(
          agent.getId(),
          agent.getMaxTokens() || 4000,
          (agent.data as any).contextCompression ?? true,
          (agent.data as any).model || 'gpt-4o-mini',
          (agent.data as any).temperature || 0.3
        );
      }
      return agent;
    }

    static async list() {
      const agents = await super.list();
      return agents.map((agent: BaseAgent) => {
        (agent as any).context = new Context(
          agent.getId(),
          agent.getMaxTokens() || 4000,
          (agent.data as any).contextCompression ?? true,
          (agent.data as any).model || 'gpt-4o-mini',
          (agent.data as any).temperature || 0.3
        );
        return agent;
      });
    }

    async update(updates: any) {
      await super.update(updates);
      
      // Ensure context is always available
      if (!this.context) {
        this.context = new Context(
          this.getId(),
          this.getMaxTokens() || 4000,
          updates.contextCompression ?? true,
          updates.model || (this.data as any).model || 'gpt-4o-mini',
          updates.temperature || (this.data as any).temperature || 0.3
        );
      }
    }

    // Context methods
    public getContext(): Context {
      if (!this.context) {
        this.context = new Context(
          this.getId(),
          this.getMaxTokens() || 4000,
          (this.data as any).contextCompression ?? true,
          (this.data as any).model || 'gpt-4o-mini',
          (this.data as any).temperature || 0.3
        );
      }
      return this.context;
    }

    async addToContext(
      layer: 'immediate' | 'summarized' | 'persistent',
      content: string,
      priority?: number,
      metadata?: Record<string, any>
    ) {
      return this.getContext().addToContext(layer, content, priority, metadata);
    }

    async getContextForLLM(): Promise<string> {
      return this.getContext().getContextForLLM();
    }

    async getContextStats() {
      return this.getContext().getContextStats();
    }

    async clearContext(layer?: 'immediate' | 'summarized' | 'persistent') {
      return this.getContext().clearContext(layer);
    }
  }
  
  return ContextAgent;
}