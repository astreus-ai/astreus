import { BaseAgent } from './base';
import { withMemory } from './decorators/with-memory';
import { withTask } from './decorators/with-task';

export class Agent extends withTask(withMemory(BaseAgent)) {}

export type { AgentConfig } from './types';
export default Agent;