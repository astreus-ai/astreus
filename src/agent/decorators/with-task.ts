import { Task, initializeTaskTable } from '../../task';
import { BaseAgent } from '../base';

export function withTask(BaseClass: typeof BaseAgent) {
  class TaskAgent extends BaseClass {
    public task?: Task;

    constructor(data: any) {
      super(data);
      this.task = new Task(this.getId());
    }

    static async create(config: any) {
      const agent = await super.create(config);
      
      // Initialize task table for all agents
      await initializeTaskTable(agent.getId());
      (agent as any).task = new Task(agent.getId());
      
      return agent;
    }

    static async findById(id: number) {
      const agent = await super.findById(id);
      if (agent) {
        (agent as any).task = new Task(agent.getId());
      }
      return agent;
    }

    static async findByName(name: string) {
      const agent = await super.findByName(name);
      if (agent) {
        (agent as any).task = new Task(agent.getId());
      }
      return agent;
    }

    static async list() {
      const agents = await super.list();
      return agents.map((agent: BaseAgent) => {
        (agent as any).task = new Task(agent.getId());
        return agent;
      });
    }

    async update(updates: any) {
      await super.update(updates);
      
      // Ensure task is always available
      if (!this.task) {
        this.task = new Task(this.getId());
      }
    }

    // Task methods
    public getTask(): Task {
      if (!this.task) {
        this.task = new Task(this.getId());
      }
      return this.task;
    }

    async createTask(request: { prompt: string; metadata?: Record<string, any> }) {
      return this.getTask().createTask(request);
    }

    async executeTask(taskId: number, options?: { model?: string; stream?: boolean }) {
      return this.getTask().executeTask(taskId, options);
    }

    async getTaskById(id: number) {
      return this.getTask().getTask(id);
    }

    async listTasks(options?: any) {
      return this.getTask().listTasks(options);
    }

    async updateTask(id: number, updates: any) {
      return this.getTask().updateTask(id, updates);
    }

    async deleteTask(id: number) {
      return this.getTask().deleteTask(id);
    }

    async clearTasks() {
      return this.getTask().clearTasks();
    }
  }
  
  return TaskAgent;
}