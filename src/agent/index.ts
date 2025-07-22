import { BaseAgent } from './base';
import { withMemory } from './decorators/with-memory';
import { withTask } from './decorators/with-task';
import { withContext } from './decorators/with-context';
import { withPlugins } from './decorators/with-plugins';
import { withKnowledge } from './decorators/with-knowledge';
import { withVision } from './decorators/with-vision';
import { AgentConfig } from './types';
import { getDatabase } from '../database';
import { knowledgeTools } from '../knowledge';
import { visionTools } from '../vision/tools';

class BaseAgentWithFeatures extends withPlugins(withContext(withTask(withVision(withKnowledge(withMemory(BaseAgent)))))) {}

export class Agent extends BaseAgentWithFeatures {
  constructor(data: AgentConfig) {
    super(data);
    
    // Auto-add knowledge tools if agent has knowledge and can use tools
    if (data.knowledge && this.canUseTools() && (this as any).addPluginTools) {
      (this as any).addPluginTools(knowledgeTools);
    }
    
    // Auto-add vision tools if agent has vision and can use tools
    if (data.vision && this.canUseTools() && (this as any).addPluginTools) {
      (this as any).addPluginTools(visionTools);
    }
  }

  static async create(config: AgentConfig): Promise<Agent> {
    const db = getDatabase();
    const agentData = await db.createAgent(config);
    return new Agent(agentData);
  }

  static async findById(id: number): Promise<Agent | null> {
    const db = getDatabase();
    const agentData = await db.getAgent(id);
    return agentData ? new Agent(agentData) : null;
  }

  static async findByName(name: string): Promise<Agent | null> {
    const db = getDatabase();
    const agentData = await db.getAgentByName(name);
    return agentData ? new Agent(agentData) : null;
  }

  static async list(): Promise<Agent[]> {
    const db = getDatabase();
    const agentsData = await db.listAgents();
    return agentsData.map(data => new Agent(data));
  }
}

export type { AgentConfig } from './types';
export default Agent;