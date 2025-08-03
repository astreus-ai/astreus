/**
 * Task delegation strategies for sub-agents
 */
import { AgentInterface } from '../agent/types';
import { SubAgentTask, DelegationStrategy, SubAgentRunOptions } from './types';
import { getLLM } from '../llm';
import { Logger } from '../logger/types';

/**
 * Auto delegation strategy - uses LLM to intelligently analyze task and assign to sub-agents
 */
export class AutoDelegationStrategy implements DelegationStrategy {
  name = 'auto' as const;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  async delegate(prompt: string, subAgents: AgentInterface[], options?: SubAgentRunOptions, model?: string): Promise<SubAgentTask[]> {
    if (subAgents.length === 0) {
      return [];
    }

    // Single agent case - assign full task
    if (subAgents.length === 1) {
      return [{
        agentId: subAgents[0].id,
        task: prompt,
        priority: 5
      }];
    }

    try {
      // Use LLM to analyze task and create delegation plan
      const delegationPlan = await this.createDelegationPlan(prompt, subAgents, model);
      return delegationPlan;
    } catch (error) {
      this.logger?.warn('LLM-based delegation failed, using fallback', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Fallback: assign full task to all agents (parallel execution)
      return subAgents.map(agent => ({
        agentId: agent.id,
        task: prompt,
        priority: 5
      }));
    }
  }

  private async createDelegationPlan(prompt: string, subAgents: AgentInterface[], model?: string): Promise<SubAgentTask[]> {
    const llm = getLLM(this.logger);

    // Build sub-agent information for the LLM
    const agentDescriptions = subAgents.map(agent => 
      `Agent ID: ${agent.id}, Name: "${agent.name}", Role: "${agent.config.systemPrompt || 'General assistant'}"`
    ).join('\n');

    const delegationPrompt = `You are a task coordinator. Analyze the following task and decide how to distribute it among available sub-agents.

TASK TO DELEGATE:
"${prompt}"

AVAILABLE SUB-AGENTS:
${agentDescriptions}

INSTRUCTIONS:
1. Analyze the task and determine if it can be broken down into subtasks
2. Assign each subtask to the most appropriate sub-agent based on their role/expertise
3. If the task cannot be meaningfully split, assign it to the most relevant single agent
4. Provide priority levels (1-10, higher = more important/should execute first)

RESPONSE FORMAT (JSON only, no explanation):
{
  "tasks": [
    {
      "agentId": number,
      "task": "specific task description",
      "priority": number,
      "reasoning": "brief explanation why this agent"
    }
  ]
}

Example response:
{
  "tasks": [
    {
      "agentId": 123,
      "task": "Research current AI trends in healthcare",
      "priority": 8,
      "reasoning": "Researcher agent best suited for information gathering"
    },
    {
      "agentId": 124,
      "task": "Write a comprehensive report based on the research findings",
      "priority": 6,
      "reasoning": "Writer agent specialized in content creation"
    }
  ]
}`;

    const response = await llm.generateResponse({
      model: model || 'gpt-4o-mini', // Use provided model or fallback to fast model
      messages: [{ role: 'user', content: delegationPrompt }],
      temperature: 0.3, // Low temperature for consistent delegation
      maxTokens: 1000
    });

    this.logger?.debug('LLM delegation response', { 
      response: response.content.substring(0, 200) + '...' 
    });

    try {
      // Extract JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const delegationResult = JSON.parse(jsonMatch[0]);
      
      if (!delegationResult.tasks || !Array.isArray(delegationResult.tasks)) {
        throw new Error('Invalid delegation result format');
      }

      // Convert to SubAgentTask format and validate
      const tasks: SubAgentTask[] = delegationResult.tasks
        .filter((task: { agentId: unknown; task: unknown; priority?: unknown }) => {
          // Validate each task
          const hasValidAgentId = typeof task.agentId === 'number' && 
            subAgents.some(agent => agent.id === task.agentId);
          const hasValidTask = typeof task.task === 'string' && task.task.trim().length > 0;
          
          if (!hasValidAgentId) {
            this.logger?.warn(`Invalid agent ID in delegation: ${task.agentId}`);
          }
          if (!hasValidTask) {
            this.logger?.warn(`Invalid task in delegation: ${task.task}`);
          }
          
          return hasValidAgentId && hasValidTask;
        })
        .map((task: { agentId: number; task: string; priority?: number }) => ({
          agentId: task.agentId,
          task: task.task.trim(),
          priority: typeof task.priority === 'number' ? task.priority : 5
        }));

      if (tasks.length === 0) {
        throw new Error('No valid tasks generated by LLM');
      }

      this.logger?.info(`LLM generated ${tasks.length} delegation tasks`, {
        taskCount: tasks.length,
        agentIds: tasks.map(t => t.agentId)
      });

      return tasks;

    } catch (parseError) {
      this.logger?.error('Failed to parse LLM delegation response', parseError as Error);
      throw new Error(`Failed to parse delegation plan: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
  }
}

/**
 * Manual delegation strategy - uses provided task assignments
 */
export class ManualDelegationStrategy implements DelegationStrategy {
  name = 'manual' as const;

  async delegate(_prompt: string, subAgents: AgentInterface[], options?: SubAgentRunOptions): Promise<SubAgentTask[]> {
    const tasks: SubAgentTask[] = [];
    
    if (!options?.taskAssignment) {
      throw new Error('Manual delegation requires taskAssignment in options');
    }
    
    // Create tasks based on manual assignment
    for (const [agentIdStr, task] of Object.entries(options.taskAssignment)) {
      const agentId = parseInt(agentIdStr);
      const agent = subAgents.find(a => a.id === agentId);
      
      if (!agent) {
        throw new Error(`Agent with ID ${agentId} not found in sub-agents`);
      }
      
      tasks.push({
        agentId,
        task,
        priority: 5 // Default priority for manual tasks
      });
    }
    
    return tasks;
  }
}

/**
 * Sequential delegation strategy - assigns tasks in order to available sub-agents
 */
export class SequentialDelegationStrategy implements DelegationStrategy {
  name = 'sequential' as const;

  async delegate(prompt: string, subAgents: AgentInterface[]): Promise<SubAgentTask[]> {
    const tasks: SubAgentTask[] = [];
    
    if (subAgents.length === 0) {
      return tasks;
    }
    
    // For sequential, we assign the full prompt to each agent in order
    // Each agent builds on the previous agent's work
    for (let i = 0; i < subAgents.length; i++) {
      const agent = subAgents[i];
      
      let task: string;
      if (i === 0) {
        // First agent gets the original task
        task = prompt;
      } else {
        // Subsequent agents build on previous work
        task = `Based on the previous agent's work, continue and enhance: ${prompt}`;
      }
      
      tasks.push({
        agentId: agent.id,
        task,
        priority: 10 - i, // Decreasing priority for execution order
        dependencies: i > 0 ? [subAgents[i - 1].id] : [] // Depend on previous agent
      });
    }
    
    return tasks;
  }
}

/**
 * Factory function to get delegation strategy
 */
export function getDelegationStrategy(type: 'auto' | 'manual' | 'sequential', logger?: Logger): DelegationStrategy {
  switch (type) {
    case 'auto':
      return new AutoDelegationStrategy(logger);
    case 'manual':
      return new ManualDelegationStrategy();
    case 'sequential':
      return new SequentialDelegationStrategy();
    default:
      throw new Error(`Unknown delegation strategy: ${type}`);
  }
}