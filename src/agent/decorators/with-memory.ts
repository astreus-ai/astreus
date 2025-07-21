import { Memory, initializeMemoryTable } from '../../memory';
import { BaseAgent } from '../base';
import { initializeDatabase } from '../../database';
import { parseDatabaseUrl } from '../../database/url-parser';

export function withMemory(BaseClass: typeof BaseAgent) {
  class MemoryAgent extends BaseClass {
    public memory?: Memory;

    constructor(data: any) {
      super(data);
      if (this.hasMemory()) {
        this.memory = new Memory(this.getId());
      }
    }

    static async create(config: any) {
      // Auto-initialize database from environment only
      let dbConfig;
      
      if (process.env.DB_URL) {
        // Parse connection URL
        dbConfig = parseDatabaseUrl(process.env.DB_URL);
      } else {
        // Fallback to individual env vars or defaults
        dbConfig = {
          client: process.env.DB_CLIENT || 'sqlite3',
          connection: { filename: process.env.DB_PATH || './agents.db' }
        };
      }
      
      await initializeDatabase(dbConfig);
      
      const agent = await super.create(config);
      if (config.memory) {
        await initializeMemoryTable(agent.getId());
        (agent as any).memory = new Memory(agent.getId());
      }
      return agent;
    }

    static async findById(id: number) {
      const agent = await super.findById(id);
      if (agent && agent.hasMemory()) {
        (agent as any).memory = new Memory(agent.getId());
      }
      return agent;
    }

    static async findByName(name: string) {
      const agent = await super.findByName(name);
      if (agent && agent.hasMemory()) {
        (agent as any).memory = new Memory(agent.getId());
      }
      return agent;
    }

    static async list() {
      const agents = await super.list();
      return agents.map((agent: BaseAgent) => {
        if (agent.hasMemory()) {
          (agent as any).memory = new Memory(agent.getId());
        }
        return agent;
      });
    }

    async update(updates: any) {
      const wasMemoryEnabled = this.hasMemory();
      await super.update(updates);
      
      if (this.hasMemory() && !wasMemoryEnabled) {
        await initializeMemoryTable(this.getId());
        this.memory = new Memory(this.getId());
      } else if (!this.hasMemory() && wasMemoryEnabled) {
        this.memory = undefined;
      }
    }

    public ensureMemory() {
      if (!this.memory) {
        throw new Error(`Agent ${this.getName()} does not have memory enabled`);
      }
      return this.memory;
    }

    async addMemory(content: string, metadata?: Record<string, any>) {
      return this.ensureMemory().addMemory(content, metadata);
    }

    async getMemory(id: number) {
      return this.ensureMemory().getMemory(id);
    }

    async listMemories(options?: any) {
      return this.ensureMemory().listMemories(options);
    }

    async updateMemory(id: number, updates: any) {
      return this.ensureMemory().updateMemory(id, updates);
    }

    async deleteMemory(id: number) {
      return this.ensureMemory().deleteMemory(id);
    }

    async clearMemories() {
      return this.ensureMemory().clearMemories();
    }

    async searchMemories(query: string, limit?: number) {
      return this.ensureMemory().searchMemories(query, limit);
    }
  }
  
  return MemoryAgent;
}