import { BaseAgent } from './base';
import { withMemory } from './decorators/with-memory';
import { withTask } from './decorators/with-task';
import { withContext } from './decorators/with-context';
import { withPlugins } from './decorators/with-plugins';

export class Agent extends withPlugins(withContext(withTask(withMemory(BaseAgent)))) {}

export type { AgentConfig } from './types';
export default Agent;