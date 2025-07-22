import { Knex } from 'knex';
import { getDatabase } from '../database';
// Agent import removed - using agentId instead
import { Task } from '../task';
import { getGraphStorage } from './storage';
import { 
  Graph as GraphType, 
  GraphConfig, 
  GraphNode, 
  GraphEdge, 
  GraphExecutionResult,
  GraphExecutionLogEntry,
  AddAgentNodeOptions,
  AddTaskNodeOptions,
  GraphExecutionStatus 
} from './types';

export class Graph {
  private knex: Knex;
  private graph: GraphType;

  constructor(config: GraphConfig) {
    const db = getDatabase();
    this.knex = (db as any).knex;
    
    this.graph = {
      config,
      nodes: [],
      edges: [],
      status: 'idle',
      executionLog: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
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
    
    return nodeId;
  }

  addTaskNode(options: AddTaskNodeOptions): string {
    const nodeId = this.generateNodeId();
    
    const node: GraphNode = {
      id: nodeId,
      type: 'task',
      name: `Task-${nodeId.split('_')[1]}`,
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
  async run(options?: { stream?: boolean }): Promise<GraphExecutionResult> {
    this.log('info', 'Starting graph execution');
    this.graph.status = 'running';
    this.graph.startedAt = new Date();
    
    const results: Record<string, any> = {};
    const errors: Record<string, string> = {};
    let completedNodes = 0;
    let failedNodes = 0;
    
    try {
      const sortedNodes = this.topologicalSort();
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
          
          // Check if all dependencies are completed
          if (this.areDependenciesCompleted(node)) {
            executing.add(node.id);
            
            // Special handling for last node with streaming
            if (shouldStreamLastNode && node.id === lastNode.id) {
              this.executeNode(node, true) // Pass stream=true for last node
                .then(result => {
                  results[node.id] = result;
                  node.status = 'completed';
                  node.result = result;
                  completedNodes++;
                  executing.delete(node.id);
                  this.log('info', `Node ${node.name} completed (streamed)`, node.id);
                })
                .catch(error => {
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
                  results[node.id] = result;
                  node.status = 'completed';
                  node.result = result;
                  completedNodes++;
                  executing.delete(node.id);
                  this.log('info', `Node ${node.name} completed`, node.id);
                })
                .catch(error => {
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
            break;
          }
        }
        
        // Wait a bit before checking again
        if (executing.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Move past any nodes that can't be executed due to failed dependencies
        while (currentIndex < sortedNodes.length && !this.canNodeExecute(sortedNodes[currentIndex])) {
          const node = sortedNodes[currentIndex];
          node.status = 'skipped';
          this.log('warn', `Node ${node.name} skipped due to failed dependencies`, node.id);
          currentIndex++;
        }
      }
      
      this.graph.status = failedNodes > 0 ? 'failed' : 'completed';
      
    } catch (error) {
      this.graph.status = 'failed';
      this.log('error', `Graph execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    this.graph.completedAt = new Date();
    const duration = this.graph.completedAt.getTime() - this.graph.startedAt!.getTime();
    
    this.log('info', `Graph execution ${this.graph.status}. Completed: ${completedNodes}, Failed: ${failedNodes}`);
    
    return {
      graph: this.graph,
      success: this.graph.status === 'completed',
      completedNodes,
      failedNodes,
      duration,
      results,
      errors
    };
  }

  private async executeNode(node: GraphNode, forceStream?: boolean): Promise<any> {
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
      
      // Execute task using the assigned agent
      const task = new Task(node.agentId);
      await task.initializeTaskTable();
      
      const createdTask = await task.createTask({
        prompt: node.prompt,
        metadata: node.metadata
      });
      
      const taskResponse = await task.executeTask(createdTask.id!, { 
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

  private canNodeExecute(node: GraphNode): boolean {
    return node.dependencies.every(depId => {
      const depNode = this.graph.nodes.find(n => n.id === depId);
      return depNode?.status === 'completed' || depNode?.status === 'skipped';
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
  async getMemories(): Promise<any[]> {
    if (!this.graph.config.defaultAgentId) {
      throw new Error('No default agent set for this graph');
    }

    const { Agent } = await import('../agent');
    const agent = await Agent.findById(this.graph.config.defaultAgentId);
    
    if (!agent || !agent.hasMemory()) {
      return [];
    }

    return await (agent as any).listMemories({
      orderBy: 'createdAt',
      order: 'asc'
    });
  }

  async searchMemories(query: string, limit?: number): Promise<any[]> {
    if (!this.graph.config.defaultAgentId) {
      throw new Error('No default agent set for this graph');
    }

    const { Agent } = await import('../agent');
    const agent = await Agent.findById(this.graph.config.defaultAgentId);
    
    if (!agent || !agent.hasMemory()) {
      return [];
    }

    return await (agent as any).searchMemories(query, limit);
  }

  // Persistence methods
  async save(): Promise<number> {
    const storage = getGraphStorage();
    const graphId = await storage.saveGraph(this.graph);
    this.graph.id = graphId.toString();
    this.graph.config.id = graphId.toString();
    return graphId;
  }

  async update(): Promise<void> {
    if (!this.graph.id) {
      throw new Error('Graph must be saved before updating');
    }
    const storage = getGraphStorage();
    await storage.updateGraph(parseInt(this.graph.id), this.graph);
  }

  async delete(): Promise<boolean> {
    if (!this.graph.id) {
      throw new Error('Graph must be saved before deleting');
    }
    const storage = getGraphStorage();
    return await storage.deleteGraph(parseInt(this.graph.id));
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

  static async create(config: GraphConfig): Promise<Graph> {
    const graph = new Graph(config);
    await graph.save();
    return graph;
  }
}

export * from './types';
export * from './storage';