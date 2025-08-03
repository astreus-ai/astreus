import { IAgentModule, IAgent } from '../agent/types';
import type { Agent } from '../agent';
import { getDatabase } from '../database';
import { Task } from '../task';
import { getGraphStorage } from './storage';
import { Logger, LogData } from '../logger/types';
import { 
  Graph as GraphType, 
  GraphConfig, 
  GraphNode, 
  GraphEdge, 
  GraphExecutionResult,
  GraphExecutionLogEntry,
  AddAgentNodeOptions,
  AddTaskNodeOptions,
  GraphExecutionStatus,
  GraphSchedulingOptions
} from './types';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';


interface TaskExecutionResult {
  type: 'task';
  taskId: number;
  response: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  // Sub-agent execution metadata
  subAgentUsed?: boolean;
  delegationStrategy?: 'auto' | 'manual' | 'sequential';
  coordinationPattern?: 'parallel' | 'sequential';
}

interface AgentExecutionResult {
  type: 'agent';
  agentId?: number;
}

type NodeExecutionResult = TaskExecutionResult | AgentExecutionResult;

export class Graph implements IAgentModule {
  readonly name = 'graph';
  private knex: Knex;
  private graph: GraphType;
  private initialized: boolean = false;
  private agent?: IAgent;
  private logger?: Logger;

  constructor(config: GraphConfig, agent?: IAgent) {
    // Note: knex will be initialized in initialize() method
    this.knex = null!; // Will be initialized in initialize()
    this.agent = agent;
    this.logger = agent?.logger;
    
    this.graph = {
      config,
      nodes: [],
      edges: [],
      status: 'idle',
      executionLog: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // User-facing info log
    if (this.logger) {
      this.logger.info('Graph module initialized', undefined, this.agent?.name);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const db = await getDatabase();
    this.knex = db.getKnex();
    this.initialized = true;
    
    // User-facing info log
    if (this.logger) {
      this.logger.info('Graph module ready', undefined, this.agent?.name);
    }
  }

  // Node management
  addAgentNode(options: AddAgentNodeOptions): string {
    const nodeId = this.generateNodeId();
    
    const node: GraphNode = {
      id: nodeId,
      type: 'agent',
      name: `Agent-${options.agentId}`,
      agentId: options.agentId,
      status: 'pending',
      priority: options.priority || 0,
      dependencies: options.dependencies || [],
      metadata: options.metadata,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.graph.nodes.push(node);
    this.graph.updatedAt = new Date();
    
    this.log('debug', `Added agent node: ${node.name} (agentId: ${options.agentId})`, nodeId);
    
    return nodeId;
  }

  addTaskNode(options: AddTaskNodeOptions): string {
    const nodeId = this.generateNodeId();
    
    // Handle dependsOn (node names) vs dependencies (node IDs)
    let dependencies: string[] = options.dependencies || [];
    if (options.dependsOn && options.dependsOn.length > 0) {
      // Convert node names to node IDs
      const dependencyIds = options.dependsOn.map(nodeName => {
        const depNode = this.graph.nodes.find(n => 
          n.metadata?.name === nodeName || 
          n.name === nodeName
        );
        if (!depNode) {
          this.log('warn', `Dependency node not found: ${nodeName}`, nodeId);
          return null;
        }
        return depNode.id;
      }).filter(id => id !== null) as string[];
      
      dependencies = [...dependencies, ...dependencyIds];
    }
    
    // Check if schedule is provided (no validation needed - just store the string)
    if (options.schedule) {
      this.log('debug', `Schedule provided: ${options.schedule}`, nodeId);
    }
    
    const node: GraphNode = {
      id: nodeId,
      type: 'task',
      name: options.name || `Task-${nodeId.split('_')[1]}-${nodeId.split('_')[2]}`,
      prompt: options.prompt,
      model: options.model,
      stream: options.stream,
      agentId: options.agentId || this.graph.config.defaultAgentId,
      // Sub-agent delegation options
      useSubAgents: options.useSubAgents,
      subAgentDelegation: options.subAgentDelegation,
      subAgentCoordination: options.subAgentCoordination,
      status: 'pending',
      priority: options.priority || 0,
      dependencies,
      schedule: options.schedule,
      metadata: {
        ...options.metadata,
        ...(options.name ? { name: options.name } : {})
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.graph.nodes.push(node);
    this.graph.updatedAt = new Date();
    
    const scheduleInfo = options.schedule ? ` (scheduled: ${options.schedule})` : '';
    this.log('debug', `Added task node: ${node.name} (prompt: "${options.prompt.slice(0, 50)}...")${scheduleInfo}`, nodeId);
    
    return nodeId;
  }

  addEdge(fromNodeId: string, toNodeId: string, condition?: string): string {
    const edgeId = this.generateEdgeId();
    
    const edge: GraphEdge = {
      id: edgeId,
      fromNodeId,
      toNodeId,
      condition
    };

    this.graph.edges.push(edge);
    
    // Add dependency to target node
    const targetNode = this.graph.nodes.find(n => n.id === toNodeId);
    if (targetNode && !targetNode.dependencies.includes(fromNodeId)) {
      targetNode.dependencies.push(fromNodeId);
    }
    
    this.graph.updatedAt = new Date();
    
    return edgeId;
  }

  // Execution
  async run(options?: { stream?: boolean; timeout?: number; nodeTimeout?: number } & GraphSchedulingOptions): Promise<GraphExecutionResult> {
    await this.initialize();
    
    // Auto-save if not already saved
    if (!this.graph.id) {
      this.log('info', 'Auto-saving graph before execution');
      await this.save();
    }
    
    // Detect scheduled nodes
    const hasScheduledNodes = this.graph.nodes.some(node => node.schedule);
    if (hasScheduledNodes) {
      this.log('info', 'Detected scheduled nodes in graph');
    }
    
    this.log('info', 'Starting graph execution with scheduling support');
    this.graph.status = 'running';
    this.graph.startedAt = new Date();
    
    const results: Record<string, NodeExecutionResult> = {};
    const errors: Record<string, string> = {};
    let completedNodes = 0;
    let failedNodes = 0;
    
    // Default scheduling options with timeout support
    const schedulingOptions = {
      respectSchedules: true,
      waitForScheduled: true,
      schedulingCheckInterval: 1000,
      timeout: options?.timeout || 300000, // 5 minutes default
      nodeTimeout: options?.nodeTimeout || 60000, // 1 minute per node default
      ...options
    };
    
    // Set up overall graph timeout
    const overallTimeoutId = setTimeout(() => {
      this.graph.status = 'failed';
      this.log('error', `Graph execution timed out after ${schedulingOptions.timeout}ms`);
      throw new Error(`Graph execution timed out after ${schedulingOptions.timeout}ms`);
    }, schedulingOptions.timeout);
    
    const nodeTimeouts = new Map<string, NodeJS.Timeout>();
    
    try {
      // Ultra-simplified scheduler - no complex schedule calculation needed
      
      const sortedNodes = this.topologicalSort();
      this.log('debug', `Execution plan: ${sortedNodes.length} nodes, max concurrency: ${this.graph.config.maxConcurrency || 1}, scheduling enabled: ${schedulingOptions.respectSchedules}`);
      
      const maxConcurrency = this.graph.config.maxConcurrency || 1;
      const executing = new Set<string>();
      let currentIndex = 0;
      
      // Find the last node for streaming
      const lastNode = sortedNodes[sortedNodes.length - 1];
      const shouldStreamLastNode = options?.stream && lastNode?.type === 'task';
      
      while (currentIndex < sortedNodes.length || executing.size > 0) {
        
        // Start new nodes if we have capacity
        while (executing.size < maxConcurrency && currentIndex < sortedNodes.length) {
          const node = sortedNodes[currentIndex];
          
          // Check if node is ready to execute (dependencies only in ultra-simplified mode)
          if (this.areDependenciesCompleted(node)) {
            this.log('debug', `Node ${node.name} ready to execute - all dependencies completed`, node.id);
            executing.add(node.id);
            
            // Set up node timeout
            const nodeTimeoutId = setTimeout(() => {
              if (executing.has(node.id)) {
                errors[node.id] = `Node execution timed out after ${schedulingOptions.nodeTimeout}ms`;
                node.status = 'failed';
                node.error = `Node execution timed out after ${schedulingOptions.nodeTimeout}ms`;
                failedNodes++;
                executing.delete(node.id);
                this.log('error', `Node ${node.name} timed out after ${schedulingOptions.nodeTimeout}ms`, node.id);
              }
            }, schedulingOptions.nodeTimeout);
            nodeTimeouts.set(node.id, nodeTimeoutId);

            // Special handling for last node with streaming
            if (shouldStreamLastNode && node.id === lastNode.id) {
              this.executeNode(node, true) // Pass stream=true for last node
                .then(result => {
                  const timeoutId = nodeTimeouts.get(node.id);
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    nodeTimeouts.delete(node.id);
                  }
                  results[node.id] = result;
                  node.status = 'completed';
                  node.result = JSON.stringify(result);
                  completedNodes++;
                  executing.delete(node.id);
                  this.log('info', `Node ${node.name} completed (streamed)`, node.id);
                })
                .catch(error => {
                  const timeoutId = nodeTimeouts.get(node.id);
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    nodeTimeouts.delete(node.id);
                  }
                  errors[node.id] = error.message;
                  node.status = 'failed';
                  node.error = error.message;
                  failedNodes++;
                  executing.delete(node.id);
                  this.log('error', `Node ${node.name} failed: ${error.message}`, node.id);
                });
            } else {
              this.executeNode(node)
                .then(result => {
                  const timeoutId = nodeTimeouts.get(node.id);
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    nodeTimeouts.delete(node.id);
                  }
                  results[node.id] = result;
                  node.status = 'completed';
                  node.result = JSON.stringify(result);
                  completedNodes++;
                  executing.delete(node.id);
                  this.log('info', `Node ${node.name} completed`, node.id);
                 })
                 .catch(error => {
                   const timeoutId = nodeTimeouts.get(node.id);
                   if (timeoutId) {
                     clearTimeout(timeoutId);
                     nodeTimeouts.delete(node.id);
                   }
                   errors[node.id] = error.message;
                   node.status = 'failed';
                   node.error = error.message;
                   failedNodes++;
                   executing.delete(node.id);
                   this.log('error', `Node ${node.name} failed: ${error.message}`, node.id);
                 });
             }
             currentIndex++;
           } else {
             // Node not ready (dependencies not completed)
             break;
           }
         }
         
         // Wait a bit before checking again
         if (executing.size > 0) {
           await new Promise(resolve => setTimeout(resolve, 100));
         }
        
        // Skip nodes that have failed dependencies (not running/pending ones)
        while (currentIndex < sortedNodes.length && this.hasFailedDependencies(sortedNodes[currentIndex])) {
          const node = sortedNodes[currentIndex];
          node.status = 'skipped';
          
          // Debug: show which dependencies failed
          const failedDeps = node.dependencies.filter(depId => {
            const depNode = this.graph.nodes.find(n => n.id === depId);
            return depNode?.status === 'failed';
          });
          
          this.log('warn', `Node ${node.name} skipped due to failed dependencies: ${failedDeps.map(id => {
            const depNode = this.graph.nodes.find(n => n.id === id);
            return `${depNode?.name || id}(${depNode?.status || 'unknown'})`;
          }).join(', ')}`, node.id);
          currentIndex++;
        }
      }
      
      this.graph.status = failedNodes > 0 ? 'failed' : 'completed';
      
    } catch (error) {
      this.graph.status = 'failed';
      this.log('error', `Graph execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Clean up all timeouts
      clearTimeout(overallTimeoutId);
      for (const [nodeId, timeoutId] of nodeTimeouts.entries()) {
        clearTimeout(timeoutId);
        this.log('debug', `Cleaned up timeout for node ${nodeId}`);
      }
      nodeTimeouts.clear();
    }
    
    this.graph.completedAt = new Date();
    const duration = this.graph.completedAt.getTime() - this.graph.startedAt!.getTime();
    
    this.log('info', `Graph execution ${this.graph.status}. Completed: ${completedNodes}, Failed: ${failedNodes} (${duration}ms)`);
    
    return {
      graph: this.graph,
      success: this.graph.status === 'completed',
      completedNodes,
      failedNodes,
      duration,
      results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, JSON.stringify(v)])),
      errors
    };
  }

  private async executeNode(node: GraphNode, forceStream?: boolean): Promise<NodeExecutionResult> {
    this.log('info', `Executing node ${node.name}`, node.id);
    node.status = 'running';
    node.updatedAt = new Date();
    
    if (node.type === 'agent') {
      // For agent nodes, we just mark them as completed
      // The actual agent work would be defined by connected task nodes
      return { type: 'agent', agentId: node.agentId };
    } else if (node.type === 'task') {
      if (!node.agentId) {
        throw new Error(`Task node ${node.name} has no assigned agent`);
      }
      
      if (!node.prompt) {
        throw new Error(`Task node ${node.name} has no prompt`);
      }
      
      // Build context from dependency results and agent context
      let enhancedPrompt = node.prompt;
      
      
      if (node.dependencies.length > 0) {
        const dependencyResults: string[] = [];
        
        for (const depId of node.dependencies) {
          const depNode = this.graph.nodes.find(n => n.id === depId);
          if (depNode?.result) {
            try {
              const depResult = JSON.parse(String(depNode.result));
              if (depResult.type === 'task' && depResult.response) {
                dependencyResults.push(`Previous result from ${depNode.name}: ${depResult.response}`);
              }
            } catch {
              // If parsing fails, use raw result
              dependencyResults.push(`Previous result from ${depNode.name}: ${String(depNode.result)}`);
            }
          }
        }
        
        if (dependencyResults.length > 0) {
          enhancedPrompt = `${dependencyResults.join('\n\n')}\n\nBased on the above context, ${node.prompt}`;
          this.log('debug', `Enhanced prompt with ${dependencyResults.length} dependency results`, node.id);
        }
      }
      
      // Execute task using the assigned agent
      if (!this.agent) {
        throw new Error(`No agent available for task node ${node.name}`);
      }
      
      // Determine if sub-agents should be used
      const shouldUseSubAgents = this.shouldUseSubAgents(node);
      
      if (shouldUseSubAgents) {
        // Use agent.ask() with sub-agent delegation
        this.log('info', `Using sub-agent delegation for node ${node.name}`, node.id);
        
        // Enhanced context for sub-agent coordination
        let contextualPrompt = enhancedPrompt;
        
        // Add graph context for sub-agents
        if (this.graph.nodes.length > 1) {
          const graphContext = this.buildGraphContext(node);
          if (graphContext) {
            contextualPrompt = `Graph Context: ${graphContext}\n\n${enhancedPrompt}`;
            this.log('debug', `Enhanced prompt with graph context for sub-agents`, node.id);
          }
        }
        
        const response = await (this.agent as IAgent & { ask: (prompt: string, options?: Record<string, unknown>) => Promise<string> }).ask(contextualPrompt, {
          model: node.model,
          stream: forceStream || node.stream,
          useSubAgents: true,
          delegation: node.subAgentDelegation || (this.graph.config.subAgentCoordination === 'adaptive' ? 'auto' : this.graph.config.subAgentCoordination) || 'auto',
          coordination: node.subAgentCoordination || (this.graph.config.subAgentCoordination === 'adaptive' ? 'sequential' : this.graph.config.subAgentCoordination) || 'sequential'
        });
        
        // Enhanced result with sub-agent metadata
        return {
          type: 'task',
          taskId: 0, // No specific task ID when using direct agent.ask()
          response,
          model: node.model || (this.agent as IAgent & { getModel: () => string }).getModel(),
          usage: undefined, // Usage tracking not available with direct ask()
          subAgentUsed: true,
          delegationStrategy: node.subAgentDelegation || 'auto',
          coordinationPattern: node.subAgentCoordination || (this.graph.config.subAgentCoordination === 'adaptive' ? 'sequential' : this.graph.config.subAgentCoordination) || 'sequential'
        };
      } else {
        // Use traditional Task module execution
        const taskModule = new Task(this.agent);
        await taskModule.initialize();
        
        const createdTask = await taskModule.createTask({
          prompt: enhancedPrompt,
          metadata: node.metadata
        });
        
        const taskResponse = await taskModule.executeTask(createdTask.id!, { 
          model: node.model,
          stream: forceStream || node.stream 
        });
        
        return {
          type: 'task',
          taskId: createdTask.id!,
          response: taskResponse.response,
          model: taskResponse.model,
          usage: taskResponse.usage
        };
      }
    }
    
    throw new Error(`Unknown node type: ${node.type}`);
  }

  private areDependenciesCompleted(node: GraphNode): boolean {
    return node.dependencies.every(depId => {
      const depNode = this.graph.nodes.find(n => n.id === depId);
      return depNode?.status === 'completed';
    });
  }

  private hasFailedDependencies(node: GraphNode): boolean {
    return node.dependencies.some(depId => {
      const depNode = this.graph.nodes.find(n => n.id === depId);
      return depNode?.status === 'failed';
    });
  }

  /**
   * Build contextual information about the graph for sub-agent coordination
   */
  private buildGraphContext(currentNode: GraphNode): string | null {
    const completedNodes = this.graph.nodes.filter(n => 
      n.status === 'completed' && n.id !== currentNode.id
    );
    
    if (completedNodes.length === 0) {
      return null;
    }
    
    const contextParts: string[] = [];
    
    // Add graph structure overview
    contextParts.push(`This task is part of a ${this.graph.nodes.length}-node workflow: "${this.graph.config.name || 'Unnamed Graph'}"`);
    
    // Add completed node summaries
    const completedSummaries = completedNodes.map(node => {
      let summary = `- ${node.name}: ${node.status}`;
      if (node.result) {
        try {
          const result = JSON.parse(String(node.result));
          if (result.response) {
            const truncatedResponse = result.response.length > 150 
              ? result.response.substring(0, 150) + '...' 
              : result.response;
            summary += ` (Result: ${truncatedResponse})`;
          }
        } catch {
          // If parsing fails, skip result summary
        }
      }
      return summary;
    });
    
    if (completedSummaries.length > 0) {
      contextParts.push(`Previous workflow steps:\n${completedSummaries.join('\n')}`);
    }
    
    // Add remaining workflow steps
    const pendingNodes = this.graph.nodes.filter(n => 
      n.status === 'pending' && n.id !== currentNode.id
    );
    
    if (pendingNodes.length > 0) {
      const pendingSummaries = pendingNodes.map(node => `- ${node.name}: pending`);
      contextParts.push(`Upcoming workflow steps:\n${pendingSummaries.join('\n')}`);
    }
    
    return contextParts.join('\n\n');
  }

  /**
   * Determine if a node should use sub-agents for execution
   */
  private shouldUseSubAgents(node: GraphNode): boolean {
    // If node explicitly specifies useSubAgents, respect that
    if (node.useSubAgents !== undefined) {
      return node.useSubAgents;
    }
    
    // If graph is sub-agent aware and agent has sub-agents, use them
    if (this.graph.config.subAgentAware && this.agent?.config.subAgents?.length) {
      return true;
    }
    
    // If optimization is enabled and agent has sub-agents, use them for complex tasks
    if (this.graph.config.optimizeSubAgentUsage && this.agent?.config.subAgents?.length) {
      // Simple heuristic: use sub-agents for longer prompts (more complex tasks)
      const promptLength = node.prompt?.length || 0;
      return promptLength > 100; // Threshold for "complex" tasks
    }
    
    return false;
  }

  private topologicalSort(): GraphNode[] {
    const sorted: GraphNode[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const visit = (nodeId: string) => {
      if (visiting.has(nodeId)) {
        throw new Error(`Circular dependency detected involving node ${nodeId}`);
      }
      
      if (visited.has(nodeId)) {
        return;
      }
      
      visiting.add(nodeId);
      
      const node = this.graph.nodes.find(n => n.id === nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found`);
      }
      
      // Visit dependencies first
      node.dependencies.forEach(depId => visit(depId));
      
      visiting.delete(nodeId);
      visited.add(nodeId);
      sorted.push(node);
    };
    
    // Sort nodes by priority (higher priority first)
    const nodesByPriority = [...this.graph.nodes].sort((a, b) => b.priority - a.priority);
    
    nodesByPriority.forEach(node => {
      if (!visited.has(node.id)) {
        visit(node.id);
      }
    });
    
    return sorted;
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, nodeId?: string) {
    const entry: GraphExecutionLogEntry = {
      timestamp: new Date(),
      level,
      message,
      nodeId
    };
    
    this.graph.executionLog.push(entry);
    
    // Also log to agent's logger if available
    if (this.logger) {
      const nodeContext = nodeId ? ` [Node: ${nodeId}]` : '';
      const fullMessage = message + nodeContext;
      
      // Use the logger's log method with 'Graph' as module name
      // Check if logger has the public log method (it should based on implementation)
      if ('log' in this.logger && typeof this.logger.log === 'function') {
        (this.logger as { log: (level: string, message: string, module?: string, data?: LogData, error?: Error, agentName?: string) => void }).log(
          level, 
          fullMessage, 
          'Graph', 
          undefined, 
          level === 'error' ? new Error(fullMessage) : undefined, 
          this.agent?.name
        );
      } else {
        // Fallback to standard methods if log method is not available
        switch (level) {
          case 'info':
            this.logger.info(fullMessage, undefined, this.agent?.name);
            break;
          case 'warn':
            this.logger.warn(fullMessage, undefined, this.agent?.name);
            break;
          case 'error':
            this.logger.error(fullMessage, undefined, undefined, this.agent?.name);
            break;
          case 'debug':
            this.logger.debug(fullMessage, undefined, this.agent?.name);
            break;
        }
      }
    }
  }

  private generateNodeId(): string {
    return `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateEdgeId(): string {
    return `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Getters
  getGraph(): GraphType {
    return this.graph;
  }

  getNodes(): GraphNode[] {
    return this.graph.nodes;
  }

  getEdges(): GraphEdge[] {
    return this.graph.edges;
  }

  getStatus(): GraphExecutionStatus {
    return this.graph.status;
  }

  getExecutionLog(): GraphExecutionLogEntry[] {
    return this.graph.executionLog;
  }

  // Utility methods
  getNode(id: string): GraphNode | undefined {
    return this.graph.nodes.find(n => n.id === id);
  }

  getNodesByType(type: 'agent' | 'task'): GraphNode[] {
    return this.graph.nodes.filter(n => n.type === type);
  }

  getNodesByStatus(status: GraphNode['status']): GraphNode[] {
    return this.graph.nodes.filter(n => n.status === status);
  }

  // Memory methods for graph
  async getMemories(): Promise<MemoryType[]> {
    if (!this.graph.config.defaultAgentId) {
      throw new Error('No default agent set for this graph');
    }

    const { Agent } = await import('../agent');
    const agent = await Agent.findById(this.graph.config.defaultAgentId);
    
    if (!agent || !agent.hasMemory()) {
      return [];
    }

    // Check if agent has listMemories method (dynamically bound)
    if ('listMemories' in agent && typeof (agent as Agent & { listMemories?: (options: { orderBy: string; order: string }) => Promise<MemoryType[]> }).listMemories === 'function') {
      const agentWithMemory = agent as Agent & { listMemories: (options: { orderBy: string; order: string }) => Promise<MemoryType[]> };
      return await agentWithMemory.listMemories({
        orderBy: 'createdAt',
        order: 'asc'
      });
    }
    return [];
  }

  async searchMemories(query: string, limit?: number): Promise<MemoryType[]> {
    if (!this.graph.config.defaultAgentId) {
      throw new Error('No default agent set for this graph');
    }

    const { Agent } = await import('../agent');
    const agent = await Agent.findById(this.graph.config.defaultAgentId);
    
    if (!agent || !agent.hasMemory()) {
      return [];
    }

    // Check if agent has searchMemories method (dynamically bound)
    if ('searchMemories' in agent && typeof (agent as Agent & { searchMemories?: (query: string, limit?: number) => Promise<MemoryType[]> }).searchMemories === 'function') {
      const agentWithMemory = agent as Agent & { searchMemories: (query: string, limit?: number) => Promise<MemoryType[]> };
      return await agentWithMemory.searchMemories(query, limit);
    }
    return [];
  }

  // Persistence methods
  async save(): Promise<number> {
    await this.initialize();
    const storage = getGraphStorage();
    const graphId = await storage.saveGraph(this.graph);
    this.graph.id = graphId.toString();
    this.graph.config.id = graphId.toString();
    return graphId;
  }

  async update(): Promise<void> {
    await this.initialize();
    if (!this.graph.id) {
      throw new Error('Graph must be saved before updating');
    }
    const storage = getGraphStorage();
    await storage.updateGraph(parseInt(this.graph.id), this.graph);
  }

  async delete(): Promise<boolean> {
    await this.initialize();
    if (!this.graph.id) {
      throw new Error('Graph must be saved before deleting');
    }
    const storage = getGraphStorage();
    return await storage.deleteGraph(parseInt(this.graph.id));
  }

  // Ultra-simplified scheduler - complex scheduling methods removed
  // Schedule detection happens at runtime with simple string parsing

  // Ultra-simplified scheduler - these methods not needed
  // Use simple schedule strings in addTaskNode() instead

  // Static methods
  static async findById(graphId: number): Promise<Graph | null> {
    const storage = getGraphStorage();
    const graphData = await storage.loadGraph(graphId);
    
    if (!graphData) {
      return null;
    }

    const graph = new Graph(graphData.config);
    graph.graph = graphData;
    return graph;
  }

  static async list(): Promise<{ id: number; name: string; status: string; createdAt: Date }[]> {
    const storage = getGraphStorage();
    return await storage.listGraphs();
  }

  static async create(config: GraphConfig, agent?: IAgent): Promise<Graph> {
    const graph = new Graph(config, agent);
    await graph.save();
    return graph;
  }

  // Sub-agent coordination utilities
  
  /**
   * Enable sub-agent awareness for all task nodes in the graph
   */
  enableSubAgentAwareness(): void {
    this.graph.config.subAgentAware = true;
    this.graph.updatedAt = new Date();
    this.log('info', 'Sub-agent awareness enabled for graph');
  }
  
  /**
   * Configure sub-agent delegation for specific nodes
   */
  configureSubAgentDelegation(nodeIds: string[], delegation: 'auto' | 'manual' | 'sequential'): void {
    let configuredCount = 0;
    
    nodeIds.forEach(nodeId => {
      const node = this.graph.nodes.find(n => n.id === nodeId);
      if (node && node.type === 'task') {
        node.subAgentDelegation = delegation;
        node.updatedAt = new Date();
        configuredCount++;
      }
    });
    
    this.graph.updatedAt = new Date();
    this.log('info', `Configured sub-agent delegation (${delegation}) for ${configuredCount} nodes`);
  }
  
  /**
   * Configure sub-agent coordination for specific nodes
   */
  configureSubAgentCoordination(nodeIds: string[], coordination: 'parallel' | 'sequential'): void {
    let configuredCount = 0;
    
    nodeIds.forEach(nodeId => {
      const node = this.graph.nodes.find(n => n.id === nodeId);
      if (node && node.type === 'task') {
        node.subAgentCoordination = coordination;
        node.updatedAt = new Date();
        configuredCount++;
      }
    });
    
    this.graph.updatedAt = new Date();
    this.log('info', `Configured sub-agent coordination (${coordination}) for ${configuredCount} nodes`);
  }
  
  /**
   * Get nodes that are currently using sub-agents
   */
  getSubAgentEnabledNodes(): GraphNode[] {
    return this.graph.nodes.filter(node => 
      node.type === 'task' && (
        node.useSubAgents === true ||
        (this.graph.config.subAgentAware && this.agent?.config.subAgents?.length)
      )
    );
  }
  
  /**
   * Get sub-agent usage statistics for the graph
   */
  getSubAgentStats(): {
    totalNodes: number;
    subAgentEnabledNodes: number;
    delegationStrategies: Record<string, number>;
    coordinationPatterns: Record<string, number>;
  } {
    const taskNodes = this.graph.nodes.filter(n => n.type === 'task');
    const subAgentNodes = this.getSubAgentEnabledNodes();
    
    const delegationStats: Record<string, number> = {};
    const coordinationStats: Record<string, number> = {};
    
    subAgentNodes.forEach(node => {
      const delegation = node.subAgentDelegation || this.graph.config.subAgentCoordination || 'auto';
      const coordination = node.subAgentCoordination || this.graph.config.subAgentCoordination || 'sequential';
      
      delegationStats[delegation] = (delegationStats[delegation] || 0) + 1;
      coordinationStats[coordination] = (coordinationStats[coordination] || 0) + 1;
    });
    
    return {
      totalNodes: taskNodes.length,
      subAgentEnabledNodes: subAgentNodes.length,
      delegationStrategies: delegationStats,
      coordinationPatterns: coordinationStats
    };
  }
  
  /**
   * Optimize sub-agent usage across the graph based on task complexity
   */
  optimizeSubAgentUsage(): void {
    if (!this.agent?.config.subAgents?.length) {
      this.log('warn', 'No sub-agents available for optimization');
      return;
    }
    
    this.graph.config.optimizeSubAgentUsage = true;
    
    // Enable sub-agent awareness
    this.graph.config.subAgentAware = true;
    
    // Analyze task complexity and configure coordination
    this.graph.nodes.forEach(node => {
      if (node.type === 'task' && node.prompt) {
        const promptLength = node.prompt.length;
        const hasDepencies = node.dependencies.length > 0;
        
        // Complex tasks: long prompts or nodes with dependencies
        if (promptLength > 200 || hasDepencies) {
          node.useSubAgents = true;
          node.subAgentDelegation = 'auto';
          node.subAgentCoordination = hasDepencies ? 'sequential' : 'parallel';
        }
        // Simple tasks: short prompts, no dependencies
        else if (promptLength <= 100) {
          node.useSubAgents = false; // Use single agent for efficiency
        }
        // Medium tasks: use default graph settings
        
        node.updatedAt = new Date();
      }
    });
    
    this.graph.updatedAt = new Date();
    this.log('info', 'Optimized sub-agent usage across graph nodes');
  }

  /**
   * Monitor and analyze sub-agent performance during execution
   */
  getSubAgentPerformanceMetrics(): {
    nodePerformance: Array<{
      nodeId: string;
      nodeName: string;
      usedSubAgents: boolean;
      delegationStrategy?: string;
      coordinationPattern?: string;
      executionTime?: number;
      status: string;
    }>;
    overallMetrics: {
      totalNodes: number;
      subAgentNodes: number;
      averageExecutionTime: number;
      successRate: number;
      subAgentEfficiency: number;
    };
  } {
    const nodeMetrics = this.graph.nodes.map(node => {
      const nodeMetric: {
        nodeId: string;
        nodeName: string;
        usedSubAgents: boolean;
        status: string;
        delegationStrategy?: string;
        coordinationPattern?: string;
        executionTime?: number;
      } = {
        nodeId: node.id,
        nodeName: node.name,
        usedSubAgents: this.shouldUseSubAgents(node),
        status: node.status
      };

      if (this.shouldUseSubAgents(node)) {
        nodeMetric.delegationStrategy = node.subAgentDelegation || this.graph.config.subAgentCoordination || 'auto';
        nodeMetric.coordinationPattern = node.subAgentCoordination || this.graph.config.subAgentCoordination || 'sequential';
      }

      // Calculate execution time if available
      if (node.status === 'completed' && this.graph.startedAt && this.graph.completedAt) {
        // Estimate based on graph timing (simplified)
        nodeMetric.executionTime = this.graph.completedAt.getTime() - this.graph.startedAt.getTime();
      }

      return nodeMetric;
    });

    const subAgentNodes = nodeMetrics.filter(n => n.usedSubAgents);
    const completedNodes = nodeMetrics.filter(n => n.status === 'completed');
    const totalExecutionTime = nodeMetrics.reduce((sum, n) => sum + (n.executionTime || 0), 0);

    return {
      nodePerformance: nodeMetrics,
      overallMetrics: {
        totalNodes: this.graph.nodes.length,
        subAgentNodes: subAgentNodes.length,
        averageExecutionTime: totalExecutionTime / Math.max(completedNodes.length, 1),
        successRate: completedNodes.length / this.graph.nodes.length,
        subAgentEfficiency: subAgentNodes.filter(n => n.status === 'completed').length / Math.max(subAgentNodes.length, 1)
      }
    };
  }

  /**
   * Benchmark different sub-agent coordination strategies
   */
  async benchmarkSubAgentStrategies(testPrompt: string = 'Analyze market trends and provide recommendations'): Promise<{
    strategies: Record<string, {
      duration: number;
      success: boolean;
      nodeResults: number;
    }>;
    recommendation: string;
  }> {
    if (!this.agent?.config.subAgents?.length) {
      throw new Error('No sub-agents available for benchmarking');
    }

    const strategies = ['parallel', 'sequential'] as const;
    const results: Record<string, {
      duration: number;
      success: boolean;
      nodeResults: number;
    }> = {};

    for (const strategy of strategies) {
      // Create test node
      const testNodeId = this.addTaskNode({
        name: `Benchmark Test - ${strategy}`,
        prompt: testPrompt,
        useSubAgents: true,
        subAgentDelegation: 'auto',
        subAgentCoordination: strategy
      });

      const startTime = Date.now();
      
      try {
        // Execute just this node
        const testNode = this.graph.nodes.find(n => n.id === testNodeId)!;
        await this.executeNode(testNode);
        
        const duration = Date.now() - startTime;
        results[strategy] = {
          duration,
          success: true,
          nodeResults: 1
        };

        this.log('info', `Benchmark ${strategy}: ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        results[strategy] = {
          duration,
          success: false,
          nodeResults: 0
        };

        this.log('error', `Benchmark ${strategy} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Remove test node
      this.graph.nodes = this.graph.nodes.filter(n => n.id !== testNodeId);
    }

    // Determine best strategy
    const successfulStrategies = Object.entries(results).filter(([, result]) => result.success);
    const recommendation = successfulStrategies.length > 0
      ? successfulStrategies.reduce((best, current) => 
          current[1].duration < best[1].duration ? current : best
        )[0]
      : 'sequential'; // Default fallback

    return {
      strategies: results,
      recommendation: `Based on performance testing, '${recommendation}' strategy is recommended for similar tasks.`
    };
  }

  /**
   * Dynamically adjust sub-agent coordination based on current performance
   */
  autoOptimizeSubAgentCoordination(): void {
    if (!this.agent?.config.subAgents?.length) {
      this.log('warn', 'No sub-agents available for auto-optimization');
      return;
    }

    const metrics = this.getSubAgentPerformanceMetrics();
    
    // Analyze current performance
    const subAgentEfficiency = metrics.overallMetrics.subAgentEfficiency;

    this.graph.nodes.forEach(node => {
      if (node.type === 'task' && node.status === 'pending') {
        const promptComplexity = node.prompt?.length || 0;
        const hasDependencies = node.dependencies.length > 0;

        // Optimize based on current performance and task characteristics
        if (subAgentEfficiency > 0.8) {
          // High efficiency - can use more aggressive parallelization
          if (promptComplexity > 300 && !hasDependencies) {
            node.subAgentCoordination = 'parallel';
            node.useSubAgents = true;
          }
        } else if (subAgentEfficiency < 0.6) {
          // Lower efficiency - use more conservative sequential approach
          if (promptComplexity > 150) {
            node.subAgentCoordination = 'sequential';
            node.useSubAgents = true;
          } else {
            node.useSubAgents = false; // Use single agent for simple tasks
          }
        }

        // Always use sequential for dependent tasks
        if (hasDependencies) {
          node.subAgentCoordination = 'sequential';
        }

        node.updatedAt = new Date();
      }
    });

    this.graph.updatedAt = new Date();
    this.log('info', `Auto-optimized sub-agent coordination based on efficiency: ${subAgentEfficiency.toFixed(2)}`);
  }

  /**
   * Generate performance report for sub-agent usage
   */
  generateSubAgentPerformanceReport(): string {
    const stats = this.getSubAgentStats();
    const metrics = this.getSubAgentPerformanceMetrics();
    
    const report = [
      '=== Sub-Agent Performance Report ===',
      '',
      `Graph: ${this.graph.config.name || 'Unnamed'}`,
      `Total Nodes: ${stats.totalNodes}`,
      `Sub-Agent Enabled: ${stats.subAgentEnabledNodes}`,
      `Success Rate: ${(metrics.overallMetrics.successRate * 100).toFixed(1)}%`,
      `Sub-Agent Efficiency: ${(metrics.overallMetrics.subAgentEfficiency * 100).toFixed(1)}%`,
      '',
      '--- Delegation Strategies ---',
      ...Object.entries(stats.delegationStrategies).map(([strategy, count]) => 
        `${strategy}: ${count} nodes`
      ),
      '',
      '--- Coordination Patterns ---',
      ...Object.entries(stats.coordinationPatterns).map(([pattern, count]) => 
        `${pattern}: ${count} nodes`
      ),
      '',
      '--- Node Performance ---',
      ...metrics.nodePerformance.map(node => 
        `${node.nodeName}: ${node.status} ${node.usedSubAgents ? `(${node.delegationStrategy}/${node.coordinationPattern})` : '(single agent)'}`
      ),
      '',
      '--- Recommendations ---'
    ];

    // Add recommendations based on analysis
    if (metrics.overallMetrics.subAgentEfficiency < 0.7) {
      report.push('• Consider optimizing sub-agent delegation strategies');
      report.push('• Review task complexity vs coordination patterns');
    }

    if (stats.subAgentEnabledNodes < stats.totalNodes * 0.3) {
      report.push('• Consider enabling sub-agents for more complex tasks');
    }

    if (metrics.overallMetrics.successRate < 0.9) {
      report.push('• Review failed nodes and optimize task dependencies');
    }

    return report.join('\n');
  }
}

export * from './types';