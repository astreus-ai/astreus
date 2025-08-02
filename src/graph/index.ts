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
  AddScheduledTaskNodeOptions,
  GraphExecutionStatus,
  GraphSchedulingOptions
} from './types';
import { Scheduler } from '../scheduler';
import { Schedule, ScheduleOptions, ScheduledItem } from '../scheduler/types';
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
    
    const node: GraphNode = {
      id: nodeId,
      type: 'task',
      name: `Task-${nodeId.split('_')[1]}-${nodeId.split('_')[2]}`,
      prompt: options.prompt,
      model: options.model,
      stream: options.stream,
      agentId: options.agentId || this.graph.config.defaultAgentId,
      status: 'pending',
      priority: options.priority || 0,
      dependencies: options.dependencies || [],
      metadata: options.metadata,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.graph.nodes.push(node);
    this.graph.updatedAt = new Date();
    
    this.log('debug', `Added task node: ${node.name} (prompt: "${options.prompt.slice(0, 50)}...")`, nodeId);
    
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
      // Calculate initial node schedules
      await this.calculateNodeSchedules();
      
      const sortedNodes = this.topologicalSort();
      this.log('debug', `Execution plan: ${sortedNodes.length} nodes, max concurrency: ${this.graph.config.maxConcurrency || 1}, scheduling enabled: ${schedulingOptions.respectSchedules}`);
      
      const maxConcurrency = this.graph.config.maxConcurrency || 1;
      const executing = new Set<string>();
      let currentIndex = 0;
      
      // Find the last node for streaming
      const lastNode = sortedNodes[sortedNodes.length - 1];
      const shouldStreamLastNode = options?.stream && lastNode?.type === 'task';
      
      while (currentIndex < sortedNodes.length || executing.size > 0) {
        const now = new Date();
        
        // Start new nodes if we have capacity
        while (executing.size < maxConcurrency && currentIndex < sortedNodes.length) {
          const node = sortedNodes[currentIndex];
          
          // Check if node is ready to execute (dependencies + schedule)
          if (this.isNodeReadyToExecute(node, now, schedulingOptions)) {
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
                   
                  // Update dependent nodes' schedules
                  this.updateDependentNodeSchedules(node.id);
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
             // Check if node is waiting for schedule
             if (schedulingOptions.respectSchedules && node.isScheduled && node.scheduledFor && node.scheduledFor > now) {
               node.status = 'scheduled';
               this.log('info', `Node ${node.name} scheduled for ${node.scheduledFor.toISOString()}`, node.id);
             }
             break;
           }
         }
         
         // Wait a bit before checking again (longer for scheduled nodes)
         const waitTime = schedulingOptions.waitForScheduled && this.hasScheduledNodes() 
           ? schedulingOptions.schedulingCheckInterval! 
           : 100;
         
         if (executing.size > 0 || (schedulingOptions.waitForScheduled && this.hasScheduledNodes())) {
           await new Promise(resolve => setTimeout(resolve, waitTime));
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

  // Scheduling methods

  // Add a scheduled task node to the graph
  addScheduledTaskNode(name: string, options: AddScheduledTaskNodeOptions): string {
    const nodeId = this.addTaskNode({
      ...options,
      metadata: { ...options.metadata, name }
    });
    const node = this.graph.nodes.find(n => n.id === nodeId);
    
    if (node) {
      node.schedule = options.schedule;
      node.isScheduled = true;
      node.scheduleOptions = options.scheduleOptions;
      node.status = 'scheduled';
      
      this.log('info', `Added scheduled task node: ${name} (scheduled for ${options.schedule.executeAt.toISOString()})`, nodeId);
    }
    
    return nodeId;
  }

  // Calculate when each node should execute based on schedule + dependencies
  private async calculateNodeSchedules(): Promise<void> {
    const now = new Date();
    
    for (const node of this.graph.nodes) {
      if (node.isScheduled && node.schedule) {
        // Set earliest possible time from schedule
        const earliestPossibleAt = new Date(Math.max(node.schedule.executeAt.getTime(), now.getTime()));
        
        // Calculate actual scheduled time considering dependencies
        node.scheduledFor = this.calculateNodeExecutionTime(node, earliestPossibleAt);
        
        this.log('debug', `Node ${node.name} scheduled for ${node.scheduledFor.toISOString()}`, node.id);
      } else {
        // Non-scheduled nodes can execute immediately (subject to dependencies)
        node.scheduledFor = now;
      }
    }
  }

  // Calculate when a node can actually execute (considering dependencies + schedule)
  private calculateNodeExecutionTime(node: GraphNode, earliestPossibleAt: Date): Date {
    const now = new Date();
    let latestDependencyTime = now;
    
    // Find the latest completion time among dependencies
    for (const depId of node.dependencies) {
      const depNode = this.graph.nodes.find(n => n.id === depId);
      if (depNode) {
        // If dependency has a schedule, use that. Otherwise assume it runs immediately
        const depExecutionTime = depNode.scheduledFor || depNode.schedule?.executeAt || now;
        
        // Estimate dependency completion time (could be made more sophisticated)
        const estimatedCompletionTime = new Date(depExecutionTime.getTime() + (5 * 60 * 1000)); // +5 minutes estimate
        
        if (estimatedCompletionTime > latestDependencyTime) {
          latestDependencyTime = estimatedCompletionTime;
        }
      }
    }
    
    // Node can execute at the later of: its schedule time OR latest dependency completion
    return new Date(Math.max(earliestPossibleAt.getTime(), latestDependencyTime.getTime()));
  }

  // Check if node is ready to execute right now
  private isNodeReadyToExecute(node: GraphNode, now: Date, options: GraphSchedulingOptions): boolean {
    // Check dependencies first (always respected)
    if (!this.areDependenciesCompleted(node)) {
      return false;
    }
    
    // Check schedule if enabled
    if (options.respectSchedules && node.isScheduled && node.scheduledFor && node.scheduledFor > now) {
      return false;
    }
    
    return node.status === 'pending' || node.status === 'scheduled';
  }

  // Update dependent nodes' schedules when a node completes
  private updateDependentNodeSchedules(completedNodeId: string): void {
    const dependentNodes = this.graph.nodes.filter(node => 
      node.dependencies.includes(completedNodeId)
    );
    
    for (const node of dependentNodes) {
      if (node.isScheduled && node.schedule) {
        // Recalculate schedule now that dependency is complete
        const earliestPossibleAt = new Date(Math.max(node.schedule.executeAt.getTime(), new Date().getTime()));
        node.scheduledFor = this.calculateNodeExecutionTime(node, earliestPossibleAt);
        
        this.log('debug', `Updated schedule for dependent node ${node.name}: ${node.scheduledFor.toISOString()}`, node.id);
      }
    }
  }

  // Check if there are nodes waiting for their scheduled time
  private hasScheduledNodes(): boolean {
    const now = new Date();
    return this.graph.nodes.some(node => 
      node.status === 'scheduled' && 
      node.scheduledFor && 
      node.scheduledFor <= now &&
      this.areDependenciesCompleted(node)
    );
  }

  // Schedule the entire graph for future execution
  async scheduleGraph(schedule: Schedule, options?: ScheduleOptions): Promise<ScheduledItem> {
    const scheduler = new Scheduler(this.agent!);
    await scheduler.initialize();

    if (!this.graph.id) {
      throw new Error('Graph must be saved before scheduling');
    }

    return await scheduler.scheduleGraph({
      graphId: this.graph.id,
      schedule,
      options
    });
  }

  // Schedule a specific node within this graph
  async scheduleGraphNode(nodeId: string, schedule: Schedule, options?: ScheduleOptions): Promise<ScheduledItem> {
    const scheduler = new Scheduler(this.agent!);
    await scheduler.initialize();

    if (!this.graph.id) {
      throw new Error('Graph must be saved before scheduling nodes');
    }

    const node = this.graph.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    return await scheduler.scheduleGraphNode({
      graphId: this.graph.id,
      nodeId,
      schedule,
      options
    });
  }

  // Get scheduled items for this graph
  async getScheduledItems(): Promise<ScheduledItem[]> {
    const scheduler = new Scheduler(this.agent!);
    await scheduler.initialize();

    const allScheduled = await scheduler.listScheduledItems();
    return allScheduled.filter(item => 
      item.type === 'graph' && item.targetId === this.graph.id ||
      item.type === 'graph_node' && String(item.targetId).startsWith(`${this.graph.id}:`)
    );
  }

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
}

export * from './types';