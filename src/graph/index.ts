import { IAgentModule, IAgent } from '../agent/types';
import { Agent } from '../agent';
import { getDatabase } from '../database';
import { Task } from '../task';
import { Memory } from '../memory';
import { getGraphStorage } from './storage';
import { Logger, LogData } from '../logger/types';
import { GraphNodeError } from '../errors';
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
  GraphSchedulingOptions,
  GraphUsage,
  NodeUsage,
  GraphStateChangeEvent,
  GraphStateChangeCallback,
} from './types';
import { Memory as MemoryType } from '../memory/types';
import { Knex } from 'knex';

interface TaskExecutionResult {
  type: 'task';
  taskId: string; // UUID
  response: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
  };
  // Sub-agent execution metadata
  subAgentUsed?: boolean;
  delegationStrategy?: 'auto' | 'manual' | 'sequential';
  coordinationPattern?: 'parallel' | 'sequential';
}

interface AgentExecutionResult {
  type: 'agent';
  agentId?: string; // UUID
}

type NodeExecutionResult = TaskExecutionResult | AgentExecutionResult;

export class Graph implements IAgentModule {
  readonly name = 'graph';
  private knex: Knex | null = null;
  private graph: GraphType;
  private initialized: boolean = false;
  private agent?: IAgent;
  private logger?: Logger;
  public lastNodeId: string | null = null; // Track last added node for auto-linking

  // Bounds limits for graph collections
  private static readonly MAX_NODES = 1000;
  private static readonly MAX_EDGES = 5000;

  // Promise-based mutex for preventing concurrent execution
  private executionLock: Promise<void> | null = null;
  private releaseLock: (() => void) | null = null;

  // State change callback for Agent state synchronization
  private stateChangeCallback: GraphStateChangeCallback | null = null;

  // Current execution state for tracking
  private executionState: Map<string, { status: string; result?: unknown; error?: string }> =
    new Map();

  // Track active timeouts for cleanup
  private activeNodeTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private overallTimeoutId: NodeJS.Timeout | null = null;

  constructor(config: GraphConfig, agent?: IAgent) {
    // Note: knex will be initialized in initialize() method
    this.agent = agent;
    this.logger = agent?.logger;

    // Log warning if no agent provided - note: logger may not be available yet
    // This is intentionally left as a silent case since logger depends on agent

    this.graph = {
      config,
      defaultAgentId: agent?.id, // Store default agent ID
      nodes: [],
      edges: [],
      status: 'idle',
      executionLog: [],
      createdAt: new Date(),
      updatedAt: new Date(),
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

  /**
   * Register a callback for graph state change events
   * This allows Agent to track state changes during graph execution
   */
  onStateChange(callback: GraphStateChangeCallback): void {
    this.stateChangeCallback = callback;
  }

  /**
   * Notify registered callback about state changes
   */
  private async notifyStateChange(event: GraphStateChangeEvent): Promise<void> {
    // Update internal execution state
    if (event.nodeId) {
      this.executionState.set(event.nodeId, {
        status: event.status,
        result: event.result,
        error: event.error,
      });
    }

    if (this.stateChangeCallback) {
      try {
        await this.stateChangeCallback(event);
      } catch (error) {
        this.log(
          'warn',
          `State change callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Get the current execution state of all nodes
   * Useful for Agent to sync its state with graph execution
   */
  getExecutionState(): Map<string, { status: string; result?: unknown; error?: string }> {
    return new Map(this.executionState);
  }

  /**
   * Get the current state of a specific node
   */
  getNodeExecutionState(
    nodeId: string
  ): { status: string; result?: unknown; error?: string } | undefined {
    return this.executionState.get(nodeId);
  }

  /**
   * Clear execution state (useful after graph reset)
   */
  clearExecutionState(): void {
    this.executionState.clear();
  }

  // Node management
  addAgentNode(options: AddAgentNodeOptions): string {
    // Validate agentId is provided
    if (!options.agentId) {
      throw new Error('agentId is required for agent nodes');
    }

    const nodeId = this.generateNodeId();

    const dependencies: string[] = [...(options.dependencies ?? [])];
    const explicitDependencies: string[] = [];

    // Validate dependencies exist before adding
    for (const depId of dependencies) {
      const depNode = this.graph.nodes.find((n) => n.id === depId);
      if (!depNode) {
        throw new Error(`Dependency node not found: ${depId}`);
      }
    }

    // Auto-link: Link to previous node if autoLink is enabled
    if (this.graph.config.autoLink && this.lastNodeId && !dependencies.length) {
      dependencies.push(this.lastNodeId);
      explicitDependencies.push(this.lastNodeId);
      this.log('debug', `Auto-linked node to previous: ${this.lastNodeId}`, nodeId);
    } else if (dependencies.length > 0) {
      explicitDependencies.push(...dependencies);
    }

    const node: GraphNode = {
      id: nodeId,
      type: 'agent',
      name: `Agent-${options.agentId}`,
      agentId: options.agentId,
      status: 'pending',
      priority: options.priority ?? 0,
      dependencies,
      metadata: options.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Bounds check: prevent unbounded growth of nodes
    if (this.graph.nodes.length >= Graph.MAX_NODES) {
      throw new Error(`Maximum number of nodes (${Graph.MAX_NODES}) exceeded`);
    }

    this.graph.nodes.push(node);
    this.graph.updatedAt = new Date();

    // Auto-create edges for dependencies
    for (const depId of explicitDependencies) {
      this.addEdge(depId, nodeId);
    }

    // Track this node as last added for auto-linking
    this.lastNodeId = nodeId;

    this.log('debug', `Added agent node: ${node.name} (agentId: ${options.agentId})`, nodeId);

    return nodeId;
  }

  addTaskNode(options: AddTaskNodeOptions): string {
    // Validate prompt is provided
    if (!options.prompt || options.prompt.trim() === '') {
      throw new Error('prompt is required for task nodes');
    }

    const nodeId = this.generateNodeId();

    // Handle dependsOn (node names) vs dependencies (node IDs)
    let dependencies: string[] = options.dependencies ?? [];
    const explicitDependencies: string[] = [];

    // Validate dependencies exist before adding
    for (const depId of dependencies) {
      const depNode = this.graph.nodes.find((n) => n.id === depId);
      if (!depNode) {
        throw new Error(`Dependency node not found: ${depId}`);
      }
    }

    if (options.dependsOn && options.dependsOn.length > 0) {
      // Convert node names to node IDs
      const dependencyIds = options.dependsOn
        .map((nodeName) => {
          const depNode = this.graph.nodes.find(
            (n) => n.metadata?.name === nodeName || n.name === nodeName
          );
          if (!depNode) {
            this.log('warn', `Dependency node not found: ${nodeName}`, nodeId);
            return null;
          }
          return depNode.id;
        })
        .filter((id): id is string => id !== null);

      dependencies = [...dependencies, ...dependencyIds];
      explicitDependencies.push(...dependencyIds);
    }

    // Auto-link: Link to previous node if autoLink is enabled
    if (this.graph.config.autoLink && this.lastNodeId && !explicitDependencies.length) {
      if (!dependencies.includes(this.lastNodeId)) {
        dependencies.push(this.lastNodeId);
        explicitDependencies.push(this.lastNodeId);
        this.log('debug', `Auto-linked node to previous: ${this.lastNodeId}`, nodeId);
      }
    }

    // Check if schedule is provided (no validation needed - just store the string)
    if (options.schedule) {
      this.log('debug', `Schedule provided: ${options.schedule}`, nodeId);
    }

    // Validate agentId - task nodes require an agent
    const agentId = options.agentId || this.agent?.id;
    if (!agentId) {
      throw new Error(
        'Agent ID required for task node - either provide agentId in options or attach an agent to the graph'
      );
    }

    const node: GraphNode = {
      id: nodeId,
      type: 'task',
      name: options.name || `Task-${nodeId.split('_')[1]}-${nodeId.split('_')[2]}`,
      prompt: options.prompt,
      model: options.model,
      stream: options.stream,
      agentId,
      // Sub-agent delegation options
      useSubAgents: options.useSubAgents,
      subAgentDelegation: options.subAgentDelegation,
      subAgentCoordination: options.subAgentCoordination,
      status: 'pending',
      priority: options.priority ?? 0,
      dependencies,
      schedule: options.schedule,
      metadata: {
        ...options.metadata,
        ...(options.name ? { name: options.name } : {}),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Bounds check: prevent unbounded growth of nodes
    if (this.graph.nodes.length >= Graph.MAX_NODES) {
      throw new Error(`Maximum number of nodes (${Graph.MAX_NODES}) exceeded`);
    }

    this.graph.nodes.push(node);
    this.graph.updatedAt = new Date();

    // Auto-create edges for explicit dependencies (dependsOn or autoLink)
    for (const depId of explicitDependencies) {
      this.addEdge(depId, nodeId);
    }

    // Track this node as last added for auto-linking
    this.lastNodeId = nodeId;

    const scheduleInfo = options.schedule ? ` (scheduled: ${options.schedule})` : '';
    this.log(
      'debug',
      `Added task node: ${node.name} (prompt: "${options.prompt.slice(0, 50)}...")${scheduleInfo}`,
      nodeId
    );

    return nodeId;
  }

  addEdge(fromNodeId: string, toNodeId: string, condition?: string): string {
    // Bounds check: prevent unbounded growth of edges
    if (this.graph.edges.length >= Graph.MAX_EDGES) {
      throw new Error(`Maximum number of edges (${Graph.MAX_EDGES}) exceeded`);
    }

    // Validate that both nodes exist
    const fromNode = this.graph.nodes.find((n) => n.id === fromNodeId);
    if (!fromNode) {
      throw new Error(`Source node not found: ${fromNodeId}`);
    }

    const toNode = this.graph.nodes.find((n) => n.id === toNodeId);
    if (!toNode) {
      throw new Error(`Target node not found: ${toNodeId}`);
    }

    // Prevent self-referencing edges
    if (fromNodeId === toNodeId) {
      throw new Error(`Cannot create self-referencing edge: ${fromNodeId}`);
    }

    // Check for duplicate edges
    const existingEdge = this.graph.edges.find(
      (e) => e.fromNodeId === fromNodeId && e.toNodeId === toNodeId
    );
    if (existingEdge) {
      this.log('warn', `Duplicate edge ignored: ${fromNodeId} -> ${toNodeId}`);
      return existingEdge.id;
    }

    const edgeId = this.generateEdgeId();

    const edge: GraphEdge = {
      id: edgeId,
      fromNodeId,
      toNodeId,
      condition,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.graph.edges.push(edge);

    // Add dependency to target node
    if (!toNode.dependencies.includes(fromNodeId)) {
      toNode.dependencies.push(fromNodeId);
    }

    this.graph.updatedAt = new Date();

    return edgeId;
  }

  /**
   * Acquire the execution lock, waiting if another execution is in progress
   * Returns a release function to be called when execution is complete
   * @param timeout - Maximum time to wait for lock acquisition (default: 30000ms)
   * @throws Error if lock acquisition times out
   */
  private async acquireLock(timeout = 30000): Promise<() => void> {
    const startTime = Date.now();

    // Wait for any existing execution to complete with timeout
    while (this.executionLock) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Lock acquisition timeout after ${timeout}ms - possible deadlock detected`);
      }

      // Create timeout promise with proper cleanup
      let timeoutId: NodeJS.Timeout | null = null;
      const remainingTime = Math.max(100, Math.min(1000, timeout - (Date.now() - startTime)));
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(); // Resolve instead of reject to avoid unhandled rejection
        }, remainingTime);
      });

      try {
        // Wait for either lock release or timeout
        await Promise.race([
          this.executionLock.then(() => {
            if (timeoutId) clearTimeout(timeoutId);
          }),
          timeoutPromise,
        ]);
      } finally {
        // Ensure timeout is cleared even if promise race throws
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    // Create a new lock with proper initialization
    let releaseFunction: (() => void) | null = null;
    this.executionLock = new Promise<void>((resolve) => {
      releaseFunction = () => {
        this.executionLock = null;
        this.releaseLock = null;
        resolve();
      };
    });

    // At this point, releaseFunction is guaranteed to be set by the Promise executor
    // which runs synchronously
    if (!releaseFunction) {
      throw new Error('Failed to initialize lock release function');
    }

    this.releaseLock = releaseFunction;
    return releaseFunction;
  }

  // Execution
  async run(
    options?: {
      stream?: boolean;
      onChunk?: (chunk: string) => void;
      onToolCall?: (
        toolName: string,
        args: Record<string, unknown>,
        status: 'start' | 'end',
        result?: string
      ) => void;
      timeout?: number;
      nodeTimeout?: number;
    } & GraphSchedulingOptions
  ): Promise<GraphExecutionResult> {
    // Acquire Promise-based lock - prevents concurrent execution race conditions
    const release = await this.acquireLock();

    try {
      return await this.executeGraph(options);
    } finally {
      release();
    }
  }

  private async executeGraph(
    options?: {
      stream?: boolean;
      onChunk?: (chunk: string) => void;
      onToolCall?: (
        toolName: string,
        args: Record<string, unknown>,
        status: 'start' | 'end',
        result?: string
      ) => void;
      timeout?: number;
      nodeTimeout?: number;
    } & GraphSchedulingOptions
  ): Promise<GraphExecutionResult> {
    await this.initialize();

    // Clear previous execution state
    this.clearExecutionState();

    // Set status to running before save
    this.graph.status = 'running';
    this.graph.startedAt = new Date();

    // Notify state change: graph started
    await this.notifyStateChange({
      type: 'graph_started',
      graphId: this.graph.id,
      status: 'running',
      timestamp: new Date(),
    });

    // Auto-save if not already saved
    if (!this.graph.id) {
      this.log('info', 'Auto-saving graph before execution');
      await this.save();
    }

    // Detect scheduled nodes
    const hasScheduledNodes = this.graph.nodes.some((node) => node.schedule);
    if (hasScheduledNodes) {
      this.log('info', 'Detected scheduled nodes in graph');
    }

    this.log('info', 'Starting graph execution with scheduling support');

    const results: Record<string, NodeExecutionResult> = {};
    const errors: Record<string, string> = {};
    let completedNodes = 0;
    let failedNodes = 0;

    // Default scheduling options with timeout support
    // SubAgent nodes need longer timeout (5 minutes) vs regular nodes (1 minute)
    const defaultNodeTimeout = 60000; // 1 minute per node default
    const subAgentNodeTimeout = this.graph.config.subAgentNodeTimeout || 300000; // 5 minutes for sub-agent nodes

    const schedulingOptions = {
      respectSchedules: true,
      waitForScheduled: true,
      schedulingCheckInterval: 1000,
      timeout: options?.timeout || 300000, // 5 minutes default
      nodeTimeout: options?.nodeTimeout || defaultNodeTimeout,
      subAgentNodeTimeout: subAgentNodeTimeout,
      ...options,
    };

    // Set up overall graph timeout with Promise-based rejection
    // Store reject function with proper cleanup to prevent memory leak
    let timeoutReject: ((error: Error) => void) | null = null;
    let timeoutResolved = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = (error: Error) => {
        if (!timeoutResolved) {
          timeoutResolved = true;
          reject(error);
        }
      };
    });
    this.overallTimeoutId = setTimeout(() => {
      this.graph.status = 'failed';
      this.log('error', `Graph execution timed out after ${schedulingOptions.timeout}ms`);
      if (timeoutReject && !timeoutResolved) {
        timeoutReject(new Error(`Graph execution timed out after ${schedulingOptions.timeout}ms`));
      }
    }, schedulingOptions.timeout);

    // Cleanup function to mark timeout as resolved and prevent memory leak
    const markTimeoutResolved = () => {
      timeoutResolved = true;
    };

    // Clear any existing node timeouts from previous runs
    this.activeNodeTimeouts.clear();

    try {
      // Ultra-simplified scheduler - no complex schedule calculation needed

      const sortedNodes = this.topologicalSort();
      this.log(
        'debug',
        `Execution plan: ${sortedNodes.length} nodes, max concurrency: ${this.graph.config.maxConcurrency || 1}, scheduling enabled: ${schedulingOptions.respectSchedules}`
      );

      const maxConcurrency = this.graph.config.maxConcurrency ?? 1;
      const executing = new Set<string>();
      let currentIndex = 0;

      // Find the last PENDING node for streaming (skip already completed nodes)
      const pendingNodes = sortedNodes.filter((n) => n.status !== 'completed');
      const lastNode = pendingNodes[pendingNodes.length - 1];
      const shouldStreamLastNode = options?.stream && lastNode?.type === 'task';

      // Wrap execution loop in a Promise that can race with timeout
      const executionPromise = (async () => {
        // Prevent infinite loops with max iterations guard
        const MAX_ITERATIONS = sortedNodes.length * 2 + 100; // Allow extra iterations for async processing
        let iterations = 0;

        while (
          (currentIndex < sortedNodes.length || executing.size > 0) &&
          iterations < MAX_ITERATIONS
        ) {
          iterations++;
          // Start new nodes if we have capacity
          while (executing.size < maxConcurrency && currentIndex < sortedNodes.length) {
            const node = sortedNodes[currentIndex];

            // Skip already completed nodes
            if (node.status === 'completed') {
              currentIndex++;
              continue;
            }

            // Check if node is ready to execute (dependencies only in ultra-simplified mode)
            if (this.areDependenciesCompleted(node)) {
              this.log(
                'debug',
                `Node ${node.name} ready to execute - all dependencies completed`,
                node.id
              );
              executing.add(node.id);

              // Determine timeout based on whether node uses sub-agents
              // SubAgent nodes need longer timeout to accommodate delegation + execution phases
              const usesSubAgents = this.shouldUseSubAgents(node);
              const effectiveNodeTimeout = usesSubAgents
                ? schedulingOptions.subAgentNodeTimeout
                : schedulingOptions.nodeTimeout;

              // Set up node timeout with proper state change notification
              const nodeTimeoutId = setTimeout(async () => {
                if (executing.has(node.id)) {
                  errors[node.id] = `Node execution timed out after ${effectiveNodeTimeout}ms`;
                  node.status = 'failed';
                  node.error = `Node execution timed out after ${effectiveNodeTimeout}ms`;
                  failedNodes++;
                  executing.delete(node.id);
                  this.activeNodeTimeouts.delete(node.id);
                  this.log(
                    'error',
                    `Node ${node.name} timed out after ${effectiveNodeTimeout}ms${usesSubAgents ? ' (sub-agent node)' : ''}`,
                    node.id
                  );

                  // Notify state change: node timed out (wrapped to prevent unhandled rejection)
                  try {
                    await this.notifyStateChange({
                      type: 'node_failed',
                      nodeId: node.id,
                      nodeName: node.name,
                      graphId: this.graph.id,
                      status: 'failed',
                      error: `Node execution timed out after ${effectiveNodeTimeout}ms`,
                      timestamp: new Date(),
                    });
                  } catch (notifyError) {
                    this.log(
                      'warn',
                      `Failed to notify state change for timed out node ${node.name}: ${notifyError instanceof Error ? notifyError.message : 'Unknown error'}`,
                      node.id
                    );
                  }
                }
              }, effectiveNodeTimeout);
              this.activeNodeTimeouts.set(node.id, nodeTimeoutId);

              // Special handling for last node with streaming
              if (shouldStreamLastNode && node.id === lastNode.id) {
                this.executeNode(node, true, options?.onChunk, options?.onToolCall) // Pass stream=true and onChunk for last node
                  .then(async (result) => {
                    const timeoutId = this.activeNodeTimeouts.get(node.id);
                    if (timeoutId) {
                      clearTimeout(timeoutId);
                      this.activeNodeTimeouts.delete(node.id);
                    }
                    results[node.id] = result;
                    node.status = 'completed';
                    node.result = JSON.stringify(result);

                    // Track usage for task nodes
                    if (result.type === 'task' && result.usage) {
                      node.usage = {
                        promptTokens: result.usage.promptTokens,
                        completionTokens: result.usage.completionTokens,
                        totalTokens: result.usage.totalTokens,
                        cost: result.usage.cost,
                        model: result.model,
                      };
                    }

                    completedNodes++;
                    executing.delete(node.id);
                    this.log('info', `Node ${node.name} completed (streamed)`, node.id);

                    // Notify state change: node completed
                    await this.notifyStateChange({
                      type: 'node_completed',
                      nodeId: node.id,
                      nodeName: node.name,
                      graphId: this.graph.id,
                      status: 'completed',
                      result: node.result,
                      usage: node.usage,
                      timestamp: new Date(),
                    });

                    // Save assistant response to memory (wrapped to prevent unhandled rejection)
                    try {
                      await this.saveResponseToMemory(node, result);
                    } catch (memoryError) {
                      this.log(
                        'warn',
                        `Failed to save response to memory for node ${node.name}: ${memoryError instanceof Error ? memoryError.message : 'Unknown error'}`,
                        node.id
                      );
                    }
                  })
                  .catch(async (error) => {
                    const timeoutId = this.activeNodeTimeouts.get(node.id);
                    if (timeoutId) {
                      clearTimeout(timeoutId);
                      this.activeNodeTimeouts.delete(node.id);
                    }
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    errors[node.id] = errorMessage;
                    node.status = 'failed';
                    node.error = errorMessage;
                    failedNodes++;
                    executing.delete(node.id);
                    this.log('error', `Node ${node.name} failed: ${errorMessage}`, node.id);

                    // Notify state change: node failed (wrapped to prevent unhandled rejection)
                    try {
                      await this.notifyStateChange({
                        type: 'node_failed',
                        nodeId: node.id,
                        nodeName: node.name,
                        graphId: this.graph.id,
                        status: 'failed',
                        error: errorMessage,
                        timestamp: new Date(),
                      });
                    } catch (notifyError) {
                      this.log(
                        'warn',
                        `Failed to notify state change for failed node ${node.name}: ${notifyError instanceof Error ? notifyError.message : 'Unknown error'}`,
                        node.id
                      );
                    }
                  });
              } else {
                this.executeNode(node, false, options?.onChunk, options?.onToolCall)
                  .then(async (result) => {
                    const timeoutId = this.activeNodeTimeouts.get(node.id);
                    if (timeoutId) {
                      clearTimeout(timeoutId);
                      this.activeNodeTimeouts.delete(node.id);
                    }
                    results[node.id] = result;
                    node.status = 'completed';
                    node.result = JSON.stringify(result);

                    // Track usage for task nodes
                    if (result.type === 'task' && result.usage) {
                      node.usage = {
                        promptTokens: result.usage.promptTokens,
                        completionTokens: result.usage.completionTokens,
                        totalTokens: result.usage.totalTokens,
                        cost: result.usage.cost,
                        model: result.model,
                      };
                    }

                    completedNodes++;
                    executing.delete(node.id);
                    this.log('info', `Node ${node.name} completed`, node.id);

                    // Notify state change: node completed
                    await this.notifyStateChange({
                      type: 'node_completed',
                      nodeId: node.id,
                      nodeName: node.name,
                      graphId: this.graph.id,
                      status: 'completed',
                      result: node.result,
                      usage: node.usage,
                      timestamp: new Date(),
                    });

                    // Save assistant response to memory (wrapped to prevent unhandled rejection)
                    try {
                      await this.saveResponseToMemory(node, result);
                    } catch (memoryError) {
                      this.log(
                        'warn',
                        `Failed to save response to memory for node ${node.name}: ${memoryError instanceof Error ? memoryError.message : 'Unknown error'}`,
                        node.id
                      );
                    }
                  })
                  .catch(async (error) => {
                    const timeoutId = this.activeNodeTimeouts.get(node.id);
                    if (timeoutId) {
                      clearTimeout(timeoutId);
                      this.activeNodeTimeouts.delete(node.id);
                    }
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    errors[node.id] = errorMessage;
                    node.status = 'failed';
                    node.error = errorMessage;
                    failedNodes++;
                    executing.delete(node.id);
                    this.log('error', `Node ${node.name} failed: ${errorMessage}`, node.id);

                    // Notify state change: node failed (wrapped to prevent unhandled rejection)
                    try {
                      await this.notifyStateChange({
                        type: 'node_failed',
                        nodeId: node.id,
                        nodeName: node.name,
                        graphId: this.graph.id,
                        status: 'failed',
                        error: errorMessage,
                        timestamp: new Date(),
                      });
                    } catch (notifyError) {
                      this.log(
                        'warn',
                        `Failed to notify state change for failed node ${node.name}: ${notifyError instanceof Error ? notifyError.message : 'Unknown error'}`,
                        node.id
                      );
                    }
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
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          // Skip nodes that have failed dependencies (not running/pending ones)
          while (
            currentIndex < sortedNodes.length &&
            this.hasFailedDependencies(sortedNodes[currentIndex])
          ) {
            const node = sortedNodes[currentIndex];
            node.status = 'skipped';

            // Debug: show which dependencies failed
            const failedDeps = node.dependencies.filter((depId) => {
              const depNode = this.graph.nodes.find((n) => n.id === depId);
              return depNode?.status === 'failed';
            });

            this.log(
              'warn',
              `Node ${node.name} skipped due to failed dependencies: ${failedDeps
                .map((id) => {
                  const depNode = this.graph.nodes.find((n) => n.id === id);
                  return `${depNode?.name || id}(${depNode?.status || 'unknown'})`;
                })
                .join(', ')}`,
              node.id
            );
            currentIndex++;
          }
        }

        // Check if we hit the max iterations limit
        if (iterations >= MAX_ITERATIONS) {
          throw new Error(
            'Graph execution exceeded max iterations - possible infinite loop detected'
          );
        }
      })();

      // Race execution against timeout
      await Promise.race([executionPromise, timeoutPromise]);

      // Mark timeout as resolved to prevent memory leak from pending promise
      markTimeoutResolved();

      this.graph.status = failedNodes > 0 ? 'failed' : 'completed';
    } catch (error) {
      // Mark timeout as resolved even on error to prevent memory leak
      markTimeoutResolved();
      this.graph.status = 'failed';
      this.log(
        'error',
        `Graph execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // Clean up all timeouts
      if (this.overallTimeoutId) {
        clearTimeout(this.overallTimeoutId);
        this.overallTimeoutId = null;
      }
      for (const [nodeId, timeoutId] of this.activeNodeTimeouts.entries()) {
        clearTimeout(timeoutId);
        this.log('debug', `Cleaned up timeout for node ${nodeId}`);
      }
      this.activeNodeTimeouts.clear();
    }

    this.graph.completedAt = new Date();
    const duration = this.graph.startedAt
      ? this.graph.completedAt.getTime() - this.graph.startedAt.getTime()
      : 0;

    // Aggregate usage statistics
    const usage = this.aggregateUsage();
    this.graph.usage = usage;

    this.log(
      'info',
      `Graph execution ${this.graph.status}. Completed: ${completedNodes}, Failed: ${failedNodes}, Tokens: ${usage.totalTokens} (${duration}ms)`
    );

    // Persist updated graph state (node statuses) to database
    await this.update();

    // Notify state change: graph completed or failed
    await this.notifyStateChange({
      type: this.graph.status === 'completed' ? 'graph_completed' : 'graph_failed',
      graphId: this.graph.id,
      status: this.graph.status,
      timestamp: new Date(),
    });

    return {
      graph: this.graph,
      success: this.graph.status === 'completed',
      completedNodes,
      failedNodes,
      duration,
      results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, JSON.stringify(v)])),
      errors,
      usage,
    };
  }

  /**
   * Aggregate usage statistics from all completed nodes
   */
  private aggregateUsage(): GraphUsage {
    const nodeUsages: Record<string, NodeUsage> = {};
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    let totalContextTokens = 0;
    let totalCost = 0;
    const modelsUsed = new Set<string>();

    for (const node of this.graph.nodes) {
      if (node.usage) {
        nodeUsages[node.id] = node.usage;
        totalPromptTokens += node.usage.promptTokens;
        totalCompletionTokens += node.usage.completionTokens;
        totalTokens += node.usage.totalTokens;
        totalContextTokens += node.usage.contextTokens ?? 0;
        totalCost += node.usage.cost ?? 0;
        if (node.usage.model) {
          modelsUsed.add(node.usage.model);
        }
      }
    }

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      totalContextTokens,
      totalCost,
      nodeUsages,
      modelsUsed: Array.from(modelsUsed),
    };
  }

  /**
   * Check context size and warn if approaching limits
   */
  private checkContextSize(node: GraphNode): void {
    if (!this.agent) return;

    try {
      // Get context window info from agent
      const contextWindow = (this.agent as Agent).getContextWindow?.();
      if (!contextWindow) return;

      const { totalTokens, maxTokens } = contextWindow;

      // Check against graph config limits if set
      const maxContextTokens = this.graph.config.maxContextTokens || maxTokens;
      const warningThreshold = this.graph.config.contextWarningThreshold || 0.8;

      const utilization = totalTokens / maxContextTokens;

      if (utilization >= 1.0) {
        this.log(
          'error',
          `Context limit exceeded! Using ${totalTokens}/${maxContextTokens} tokens (${(utilization * 100).toFixed(1)}%)`,
          node.id
        );
      } else if (utilization >= warningThreshold) {
        this.log(
          'warn',
          `Context approaching limit: ${totalTokens}/${maxContextTokens} tokens (${(utilization * 100).toFixed(1)}%)`,
          node.id
        );
      } else {
        this.log(
          'debug',
          `Context usage: ${totalTokens}/${maxContextTokens} tokens (${(utilization * 100).toFixed(1)}%)`,
          node.id
        );
      }

      // Track context tokens in node usage
      if (node.usage) {
        node.usage.contextTokens = totalTokens;
      }
    } catch (error) {
      this.log(
        'debug',
        `Failed to check context size: ${error instanceof Error ? error.message : String(error)}`,
        node.id
      );
    }
  }

  private async executeNode(
    node: GraphNode,
    forceStream?: boolean,
    onChunk?: (chunk: string) => void,
    onToolCall?: (
      toolName: string,
      args: Record<string, unknown>,
      status: 'start' | 'end',
      result?: string
    ) => void
  ): Promise<NodeExecutionResult> {
    this.log('info', `Executing node ${node.name}`, node.id);
    node.status = 'running';
    node.updatedAt = new Date();

    // Notify state change: node started
    await this.notifyStateChange({
      type: 'node_started',
      nodeId: node.id,
      nodeName: node.name,
      graphId: this.graph.id,
      status: 'running',
      timestamp: new Date(),
    });

    // Find parent node ID for error chain tracking
    const parentNodeId = node.dependencies.length > 0 ? node.dependencies[0] : undefined;

    if (node.type === 'agent') {
      // For agent nodes, we just mark them as completed
      // The actual agent work would be defined by connected task nodes
      return { type: 'agent', agentId: node.agentId };
    } else if (node.type === 'task') {
      if (!node.agentId) {
        throw new GraphNodeError(
          `Task node ${node.name} has no assigned agent`,
          node.id,
          node.name,
          'initialization',
          this.graph.id,
          parentNodeId
        );
      }

      if (!node.prompt) {
        throw new GraphNodeError(
          `Task node ${node.name} has no prompt`,
          node.id,
          node.name,
          'initialization',
          this.graph.id,
          parentNodeId
        );
      }

      // Load conversation history from Memory if agent has memory enabled
      if (this.graph.id && this.agent && this.agent.loadGraphContext) {
        try {
          // Use isolated=true for graph-only memories (no general agent memories)
          await this.agent.loadGraphContext(this.graph.id, 100, true);
          this.log(
            'debug',
            `Loaded isolated conversation history for graph ${this.graph.id}`,
            node.id
          );

          // Monitor context size and warn if approaching limits
          this.checkContextSize(node);
        } catch (error) {
          this.log(
            'warn',
            `Failed to load conversation history: ${error instanceof Error ? error.message : String(error)}`,
            node.id
          );
        }
      }

      // Save user prompt to memory before execution (this also adds to context)
      if (this.graph.id && node.prompt && this.agent && this.agent.addMemory) {
        try {
          const metadata: Record<string, string | boolean | number> = {
            type: 'user_message',
            role: 'user',
            graphId: this.graph.id,
            graphNodeId: node.id,
          };
          if (node.taskId) {
            metadata.taskId = node.taskId;
          }
          await this.agent.addMemory(node.prompt, metadata);
          this.log('debug', `Saved user prompt to memory`, node.id);
        } catch (error) {
          this.log(
            'warn',
            `Failed to save user prompt: ${error instanceof Error ? error.message : String(error)}`,
            node.id
          );
        }
      }

      // Use the original prompt (context is already loaded in ContextManager)
      const enhancedPrompt = node.prompt;

      // Execute task using the assigned agent
      if (!this.agent) {
        throw new GraphNodeError(
          `No agent available for task node ${node.name}`,
          node.id,
          node.name,
          'initialization',
          this.graph.id,
          parentNodeId
        );
      }

      // Determine if sub-agents should be used
      const shouldUseSubAgents = this.shouldUseSubAgents(node);

      // Always use Task module for proper tool support and consistency
      if (shouldUseSubAgents) {
        this.log('info', `Using sub-agent delegation for task node ${node.name}`, node.id);

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

        // Use Task module with sub-agent delegation
        const taskModule = new Task(this.agent);
        await taskModule.initialize();

        const createdTask = await taskModule.createTask({
          prompt: contextualPrompt,
          metadata: {
            ...node.metadata,
            useSubAgents: true,
            subAgentDelegation:
              node.subAgentDelegation ||
              (this.graph.config.subAgentCoordination === 'adaptive'
                ? 'auto'
                : this.graph.config.subAgentCoordination) ||
              'auto',
            subAgentCoordination:
              node.subAgentCoordination ||
              (this.graph.config.subAgentCoordination === 'adaptive'
                ? 'sequential'
                : this.graph.config.subAgentCoordination) ||
              'sequential',
          },
        });

        if (!createdTask.id) {
          throw new GraphNodeError(
            `Task creation failed for node ${node.name}: no task ID returned`,
            node.id,
            node.name,
            'execution',
            this.graph.id,
            parentNodeId
          );
        }

        try {
          const taskResponse = await taskModule.executeTask(createdTask.id, {
            model: node.model,
            stream: forceStream || node.stream,
            onChunk,
            onToolCall,
          });

          return {
            type: 'task',
            taskId: createdTask.id,
            response: taskResponse.response,
            model: taskResponse.model,
            usage: taskResponse.usage,
            subAgentUsed: true,
            delegationStrategy: node.subAgentDelegation ?? 'auto',
            coordinationPattern: node.subAgentCoordination ?? 'sequential',
          };
        } catch (execError) {
          throw new GraphNodeError(
            `Task execution failed for node ${node.name}: ${execError instanceof Error ? execError.message : String(execError)}`,
            node.id,
            node.name,
            'execution',
            this.graph.id,
            parentNodeId,
            execError instanceof Error ? execError : undefined
          );
        }
      } else {
        // Use traditional Task module execution
        const taskModule = new Task(this.agent);
        await taskModule.initialize();

        const createdTask = await taskModule.createTask({
          prompt: enhancedPrompt,
          graphId: this.graph.id, // Link task to graph (UUID)
          graphNodeId: node.id, // Node ID (string)
          metadata: node.metadata,
        });

        if (!createdTask.id) {
          throw new GraphNodeError(
            `Task creation failed for node ${node.name}: no task ID returned`,
            node.id,
            node.name,
            'execution',
            this.graph.id,
            parentNodeId
          );
        }

        // Update node with task ID
        node.taskId = createdTask.id;

        try {
          const taskResponse = await taskModule.executeTask(createdTask.id, {
            model: node.model,
            stream: forceStream || node.stream,
            onChunk,
            onToolCall,
          });

          return {
            type: 'task',
            taskId: createdTask.id,
            response: taskResponse.response,
            model: taskResponse.model,
            usage: taskResponse.usage,
          };
        } catch (execError) {
          throw new GraphNodeError(
            `Task execution failed for node ${node.name}: ${execError instanceof Error ? execError.message : String(execError)}`,
            node.id,
            node.name,
            'execution',
            this.graph.id,
            parentNodeId,
            execError instanceof Error ? execError : undefined
          );
        }
      }
    }

    throw new GraphNodeError(
      `Unknown node type: ${node.type}`,
      node.id,
      node.name,
      'initialization',
      this.graph.id,
      parentNodeId
    );
  }

  /**
   * Save task response to memory with graph context
   */
  private async saveResponseToMemory(node: GraphNode, result: NodeExecutionResult): Promise<void> {
    if (!this.agent || !this.agent.addMemory || !this.graph.id || result.type !== 'task') {
      return;
    }

    try {
      const metadata: Record<string, string | boolean | number> = {
        type: 'assistant_response',
        role: 'assistant',
        graphId: this.graph.id,
        graphNodeId: node.id,
        taskId: result.taskId,
      };
      if (result.model) {
        metadata.model = result.model;
      }
      if (result.usage) {
        metadata.promptTokens = result.usage.promptTokens;
        metadata.completionTokens = result.usage.completionTokens;
        metadata.totalTokens = result.usage.totalTokens;
      }
      await this.agent.addMemory(result.response, metadata);
      this.log('debug', `Saved assistant response to memory`, node.id);
    } catch (error) {
      this.log(
        'warn',
        `Failed to save response to memory: ${error instanceof Error ? error.message : String(error)}`,
        node.id
      );
    }
  }

  private areDependenciesCompleted(node: GraphNode): boolean {
    return node.dependencies.every((depId) => {
      const depNode = this.graph.nodes.find((n) => n.id === depId);
      if (!depNode) {
        this.log('warn', `Dependency node not found: ${depId}`, node.id);
        return false;
      }
      return depNode.status === 'completed';
    });
  }

  private hasFailedDependencies(node: GraphNode): boolean {
    return node.dependencies.some((depId) => {
      const depNode = this.graph.nodes.find((n) => n.id === depId);
      return depNode?.status === 'failed';
    });
  }

  /**
   * Build contextual information about the graph for sub-agent coordination
   */
  private buildGraphContext(currentNode: GraphNode): string | null {
    const completedNodes = this.graph.nodes.filter(
      (n) => n.status === 'completed' && n.id !== currentNode.id
    );

    if (completedNodes.length === 0) {
      return null;
    }

    const contextParts: string[] = [];

    // Add graph structure overview
    contextParts.push(
      `This task is part of a ${this.graph.nodes.length}-node workflow: "${this.graph.config.name || 'Unnamed Graph'}"`
    );

    // Add completed node summaries
    const completedSummaries = completedNodes.map((node) => {
      let summary = `- ${node.name}: ${node.status}`;
      if (node.result) {
        try {
          const result = JSON.parse(String(node.result));
          if (result.response) {
            const truncatedResponse =
              result.response.length > 150
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
    const pendingNodes = this.graph.nodes.filter(
      (n) => n.status === 'pending' && n.id !== currentNode.id
    );

    if (pendingNodes.length > 0) {
      const pendingSummaries = pendingNodes.map((node) => `- ${node.name}: pending`);
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
      const promptLength = node.prompt?.length ?? 0;
      return promptLength > 100; // Threshold for "complex" tasks
    }

    return false;
  }

  /**
   * Iterative topological sort to prevent stack overflow on large graphs
   * Uses Kahn's algorithm with in-degree tracking
   */
  private topologicalSort(): GraphNode[] {
    const nodeMap = new Map<string, GraphNode>();
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // Initialize data structures
    for (const node of this.graph.nodes) {
      nodeMap.set(node.id, node);
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    // Build adjacency list and calculate in-degrees
    for (const node of this.graph.nodes) {
      for (const depId of node.dependencies) {
        if (!nodeMap.has(depId)) {
          throw new Error(`Dependency node not found: ${depId}`);
        }
        // depId -> node.id (dependency points to dependent)
        const adj = adjacency.get(depId);
        if (adj) {
          adj.push(node.id);
        }
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    // Sort nodes by priority for deterministic ordering (higher priority first)
    const nodesByPriority = [...this.graph.nodes].sort((a, b) => b.priority - a.priority);

    // Initialize queue with nodes that have no dependencies (in-degree = 0)
    const queue: string[] = [];
    for (const node of nodesByPriority) {
      if ((inDegree.get(node.id) || 0) === 0) {
        queue.push(node.id);
      }
    }

    const result: GraphNode[] = [];
    let processedCount = 0;

    // Process nodes iteratively
    while (queue.length > 0) {
      // Sort queue by priority to maintain priority ordering
      queue.sort((a, b) => {
        const nodeA = nodeMap.get(a);
        const nodeB = nodeMap.get(b);
        return (nodeB?.priority || 0) - (nodeA?.priority || 0);
      });

      const nodeId = queue.shift();
      // This should never happen due to while condition, but check for safety
      if (!nodeId) {
        throw new Error('Queue unexpectedly empty during topological sort');
      }
      const node = nodeMap.get(nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found during topological sort`);
      }

      result.push(node);
      processedCount++;

      // Reduce in-degree for all dependent nodes
      const dependents = adjacency.get(nodeId) || [];
      for (const depId of dependents) {
        const newDegree = (inDegree.get(depId) || 1) - 1;
        inDegree.set(depId, newDegree);

        // If in-degree becomes 0, add to queue
        if (newDegree === 0) {
          queue.push(depId);
        }
      }
    }

    // Check for circular dependency
    if (processedCount !== this.graph.nodes.length) {
      // Find nodes involved in cycle for better error message
      const unprocessedNodes = this.graph.nodes
        .filter((n) => !result.find((r) => r.id === n.id))
        .map((n) => n.name || n.id);
      throw new Error(
        `Circular dependency detected involving nodes: ${unprocessedNodes.join(', ')}`
      );
    }

    return result;
  }

  private static readonly MAX_EXECUTION_LOG_SIZE = 10000;

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, nodeId?: string) {
    const entry: GraphExecutionLogEntry = {
      timestamp: new Date(),
      level,
      message,
      nodeId,
    };

    // Bounds check: prevent unbounded growth of execution log
    if (this.graph.executionLog.length >= Graph.MAX_EXECUTION_LOG_SIZE) {
      // Remove oldest entries (keep last 80%)
      const keepCount = Math.floor(Graph.MAX_EXECUTION_LOG_SIZE * 0.8);
      this.graph.executionLog = this.graph.executionLog.slice(-keepCount);
    }

    this.graph.executionLog.push(entry);

    // Also log to agent's logger if available
    if (this.logger) {
      const nodeContext = nodeId ? ` [Node: ${nodeId}]` : '';
      const fullMessage = message + nodeContext;

      // Use the logger's log method with 'Graph' as module name
      // Check if logger has the public log method (it should based on implementation)
      if ('log' in this.logger && typeof this.logger.log === 'function') {
        (
          this.logger as {
            log: (
              level: string,
              message: string,
              module?: string,
              data?: LogData,
              error?: Error,
              agentName?: string
            ) => void;
          }
        ).log(
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
    return `node_${crypto.randomUUID()}`;
  }

  private generateEdgeId(): string {
    return `edge_${crypto.randomUUID()}`;
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

  setStatus(status: GraphExecutionStatus): void {
    this.graph.status = status;
    this.graph.updatedAt = new Date();
  }

  getExecutionLog(): GraphExecutionLogEntry[] {
    return this.graph.executionLog;
  }

  // Utility methods
  getNode(id: string): GraphNode | undefined {
    return this.graph.nodes.find((n) => n.id === id);
  }

  getNodesByType(type: 'agent' | 'task'): GraphNode[] {
    return this.graph.nodes.filter((n) => n.type === type);
  }

  getNodesByStatus(status: GraphNode['status']): GraphNode[] {
    return this.graph.nodes.filter((n) => n.status === status);
  }

  // Memory methods for graph
  // Note: Extended version with graphId filtering is at the end of the class

  async searchMemories(query: string, limit?: number): Promise<MemoryType[]> {
    if (!this.agent) {
      throw new Error('No agent available for this graph');
    }

    if (!this.agent.hasMemory()) {
      return [];
    }

    // Check if agent has searchMemories method (dynamically bound)
    if (
      'searchMemories' in this.agent &&
      typeof (
        this.agent as Agent & {
          searchMemories?: (query: string, limit?: number) => Promise<MemoryType[]>;
        }
      ).searchMemories === 'function'
    ) {
      try {
        const agentWithMemory = this.agent as Agent & {
          searchMemories: (query: string, limit?: number) => Promise<MemoryType[]>;
        };
        return await agentWithMemory.searchMemories(query, limit);
      } catch (error) {
        this.log(
          'error',
          `Failed to search memories: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    }
    return [];
  }

  // Persistence methods
  async save(): Promise<string> {
    await this.initialize();
    try {
      const storage = getGraphStorage();
      const graphId = await storage.saveGraph(this.graph);

      this.graph.id = graphId;
      this.graph.config.id = graphId;
      return graphId;
    } catch (error) {
      this.log(
        'error',
        `Failed to save graph: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async update(): Promise<void> {
    await this.initialize();
    if (!this.graph.id) {
      throw new Error('Graph must be saved before updating');
    }
    try {
      const storage = getGraphStorage();
      await storage.updateGraph(this.graph.id, this.graph);
    } catch (error) {
      this.log(
        'error',
        `Failed to update graph: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async delete(): Promise<boolean> {
    await this.initialize();
    if (!this.graph.id) {
      throw new Error('Graph must be saved before deleting');
    }
    try {
      const storage = getGraphStorage();
      return await storage.deleteGraph(this.graph.id);
    } catch (error) {
      this.log(
        'error',
        `Failed to delete graph: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  // Ultra-simplified scheduler - complex scheduling methods removed
  // Schedule detection happens at runtime with simple string parsing

  // Ultra-simplified scheduler - these methods not needed
  // Use simple schedule strings in addTaskNode() instead

  // Static methods
  static async findById(graphId: string, agent?: IAgent): Promise<Graph | null> {
    const storage = getGraphStorage();
    const graphData = await storage.loadGraph(graphId);

    if (!graphData) {
      return null;
    }

    const graph = new Graph(graphData.config, agent);
    graph.graph = graphData;

    // Restore lastNodeId for autoLink to work on loaded graphs
    if (graphData.nodes.length > 0) {
      // Find the most recently created node
      const sortedNodes = [...graphData.nodes].sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      graph.lastNodeId = sortedNodes[0].id;
    }

    return graph;
  }

  static async list(): Promise<{ id: string; name: string; status: string; createdAt: Date }[]> {
    // UUID
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
  configureSubAgentDelegation(
    nodeIds: string[],
    delegation: 'auto' | 'manual' | 'sequential'
  ): void {
    let configuredCount = 0;

    nodeIds.forEach((nodeId) => {
      const node = this.graph.nodes.find((n) => n.id === nodeId);
      if (node && node.type === 'task') {
        node.subAgentDelegation = delegation;
        node.updatedAt = new Date();
        configuredCount++;
      }
    });

    this.graph.updatedAt = new Date();
    this.log(
      'info',
      `Configured sub-agent delegation (${delegation}) for ${configuredCount} nodes`
    );
  }

  /**
   * Configure sub-agent coordination for specific nodes
   */
  configureSubAgentCoordination(nodeIds: string[], coordination: 'parallel' | 'sequential'): void {
    let configuredCount = 0;

    nodeIds.forEach((nodeId) => {
      const node = this.graph.nodes.find((n) => n.id === nodeId);
      if (node && node.type === 'task') {
        node.subAgentCoordination = coordination;
        node.updatedAt = new Date();
        configuredCount++;
      }
    });

    this.graph.updatedAt = new Date();
    this.log(
      'info',
      `Configured sub-agent coordination (${coordination}) for ${configuredCount} nodes`
    );
  }

  /**
   * Get nodes that are currently using sub-agents
   */
  getSubAgentEnabledNodes(): GraphNode[] {
    return this.graph.nodes.filter(
      (node) =>
        node.type === 'task' &&
        (node.useSubAgents === true ||
          (this.graph.config.subAgentAware && this.agent?.config.subAgents?.length))
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
    const taskNodes = this.graph.nodes.filter((n) => n.type === 'task');
    const subAgentNodes = this.getSubAgentEnabledNodes();

    const delegationStats: Record<string, number> = {};
    const coordinationStats: Record<string, number> = {};

    subAgentNodes.forEach((node) => {
      const delegation =
        node.subAgentDelegation ?? this.graph.config.subAgentCoordination ?? 'auto';
      const coordination =
        node.subAgentCoordination ?? this.graph.config.subAgentCoordination ?? 'sequential';

      delegationStats[delegation] = (delegationStats[delegation] ?? 0) + 1;
      coordinationStats[coordination] = (coordinationStats[coordination] ?? 0) + 1;
    });

    return {
      totalNodes: taskNodes.length,
      subAgentEnabledNodes: subAgentNodes.length,
      delegationStrategies: delegationStats,
      coordinationPatterns: coordinationStats,
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
    this.graph.nodes.forEach((node) => {
      if (node.type === 'task' && node.prompt) {
        const promptLength = node.prompt.length;
        const hasDependencies = node.dependencies.length > 0;

        // Complex tasks: long prompts or nodes with dependencies
        if (promptLength > 200 || hasDependencies) {
          node.useSubAgents = true;
          node.subAgentDelegation = 'auto';
          node.subAgentCoordination = hasDependencies ? 'sequential' : 'parallel';
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
    const nodeMetrics = this.graph.nodes.map((node) => {
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
        status: node.status,
      };

      if (this.shouldUseSubAgents(node)) {
        nodeMetric.delegationStrategy =
          node.subAgentDelegation || this.graph.config.subAgentCoordination || 'auto';
        nodeMetric.coordinationPattern =
          node.subAgentCoordination || this.graph.config.subAgentCoordination || 'sequential';
      }

      // Calculate execution time if available
      if (node.status === 'completed' && this.graph.startedAt && this.graph.completedAt) {
        // Estimate based on graph timing (simplified)
        nodeMetric.executionTime =
          this.graph.completedAt.getTime() - this.graph.startedAt.getTime();
      }

      return nodeMetric;
    });

    const subAgentNodes = nodeMetrics.filter((n) => n.usedSubAgents);
    const completedNodes = nodeMetrics.filter((n) => n.status === 'completed');
    const totalExecutionTime = nodeMetrics.reduce((sum, n) => sum + (n.executionTime ?? 0), 0);

    return {
      nodePerformance: nodeMetrics,
      overallMetrics: {
        totalNodes: this.graph.nodes.length,
        subAgentNodes: subAgentNodes.length,
        averageExecutionTime: totalExecutionTime / Math.max(completedNodes.length, 1),
        successRate: completedNodes.length / this.graph.nodes.length,
        subAgentEfficiency:
          subAgentNodes.filter((n) => n.status === 'completed').length /
          Math.max(subAgentNodes.length, 1),
      },
    };
  }

  /**
   * Benchmark different sub-agent coordination strategies
   */
  async benchmarkSubAgentStrategies(
    testPrompt: string = 'Analyze market trends and provide recommendations'
  ): Promise<{
    strategies: Record<
      string,
      {
        duration: number;
        success: boolean;
        nodeResults: number;
      }
    >;
    recommendation: string;
  }> {
    if (!this.agent?.config.subAgents?.length) {
      throw new Error('No sub-agents available for benchmarking');
    }

    const strategies = ['parallel', 'sequential'] as const;
    const results: Record<
      string,
      {
        duration: number;
        success: boolean;
        nodeResults: number;
      }
    > = {};

    for (const strategy of strategies) {
      // Create test node
      const testNodeId = this.addTaskNode({
        name: `Benchmark Test - ${strategy}`,
        prompt: testPrompt,
        useSubAgents: true,
        subAgentDelegation: 'auto',
        subAgentCoordination: strategy,
      });

      const startTime = Date.now();

      try {
        // Execute just this node
        const testNode = this.graph.nodes.find((n) => n.id === testNodeId);
        if (!testNode) {
          throw new Error(`Test node ${testNodeId} not found`);
        }
        await this.executeNode(testNode, false, undefined);

        const duration = Date.now() - startTime;
        results[strategy] = {
          duration,
          success: true,
          nodeResults: 1,
        };

        this.log('info', `Benchmark ${strategy}: ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        results[strategy] = {
          duration,
          success: false,
          nodeResults: 0,
        };

        this.log(
          'error',
          `Benchmark ${strategy} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      // Remove test node and any associated edges
      this.graph.nodes = this.graph.nodes.filter((n) => n.id !== testNodeId);
      this.graph.edges = this.graph.edges.filter(
        (e) => e.fromNodeId !== testNodeId && e.toNodeId !== testNodeId
      );

      // Reset lastNodeId if it was the test node to prevent stale references
      if (this.lastNodeId === testNodeId) {
        const remainingNodes = this.graph.nodes;
        if (remainingNodes.length > 0) {
          // Restore to the most recently created remaining node
          const sortedNodes = [...remainingNodes].sort((a, b) => {
            const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return timeB - timeA;
          });
          this.lastNodeId = sortedNodes[0].id;
        } else {
          this.lastNodeId = null;
        }
      }
    }

    // Determine best strategy
    const successfulStrategies = Object.entries(results).filter(([, result]) => result.success);
    const recommendation =
      successfulStrategies.length > 0
        ? successfulStrategies.reduce((best, current) =>
            current[1].duration < best[1].duration ? current : best
          )[0]
        : 'sequential'; // Default fallback

    return {
      strategies: results,
      recommendation: `Based on performance testing, '${recommendation}' strategy is recommended for similar tasks.`,
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

    this.graph.nodes.forEach((node) => {
      if (node.type === 'task' && node.status === 'pending') {
        const promptComplexity = node.prompt?.length ?? 0;
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
    this.log(
      'info',
      `Auto-optimized sub-agent coordination based on efficiency: ${subAgentEfficiency.toFixed(2)}`
    );
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
      ...Object.entries(stats.delegationStrategies).map(
        ([strategy, count]) => `${strategy}: ${count} nodes`
      ),
      '',
      '--- Coordination Patterns ---',
      ...Object.entries(stats.coordinationPatterns).map(
        ([pattern, count]) => `${pattern}: ${count} nodes`
      ),
      '',
      '--- Node Performance ---',
      ...metrics.nodePerformance.map(
        (node) =>
          `${node.nodeName}: ${node.status} ${node.usedSubAgents ? `(${node.delegationStrategy}/${node.coordinationPattern})` : '(single agent)'}`
      ),
      '',
      '--- Recommendations ---',
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

  /**
   * Get all tasks created by this graph
   */
  async getTasks(options?: {
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<unknown[]> {
    if (!this.graph.id) {
      throw new Error('Graph must be saved before querying tasks');
    }

    if (!this.agent) {
      throw new Error('No agent available for this graph');
    }

    const taskModule = new Task(this.agent);
    await taskModule.initialize();

    return taskModule.listTasks({
      graphId: this.graph.id,
      limit: options?.limit,
      offset: options?.offset,
      status: options?.status as 'pending' | 'in_progress' | 'completed' | 'failed' | undefined,
    });
  }

  /**
   * Get task for a specific node
   */
  async getTaskByNode(nodeId: string): Promise<unknown | null> {
    const node = this.getNode(nodeId);
    if (!node || node.type !== 'task' || !node.taskId) {
      return null;
    }

    if (!this.agent) {
      throw new Error('No agent available for this graph');
    }

    const taskModule = new Task(this.agent);
    await taskModule.initialize();

    return taskModule.getTask(node.taskId);
  }

  /**
   * Get aggregated usage statistics for the graph
   */
  getUsage(): GraphUsage | undefined {
    return this.graph.usage || this.aggregateUsage();
  }

  /**
   * Get usage statistics for a specific node
   */
  getNodeUsage(nodeId: string): NodeUsage | undefined {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    return node?.usage;
  }

  /**
   * Get total token count across all nodes
   */
  getTotalTokens(): number {
    const usage = this.getUsage();
    return usage?.totalTokens ?? 0;
  }

  /**
   * Get total cost across all nodes
   */
  getTotalCost(): number {
    const usage = this.getUsage();
    return usage?.totalCost ?? 0;
  }

  /**
   * Get context size information
   */
  getContextInfo(): {
    currentTokens: number;
    maxTokens: number;
    utilization: number;
    isWarning: boolean;
    isExceeded: boolean;
  } | null {
    if (!this.agent) return null;

    try {
      const contextWindow = (this.agent as Agent).getContextWindow?.();
      if (!contextWindow) return null;

      const { totalTokens, maxTokens } = contextWindow;
      const maxContextTokens = this.graph.config.maxContextTokens || maxTokens;
      const warningThreshold = this.graph.config.contextWarningThreshold || 0.8;
      const utilization = totalTokens / maxContextTokens;

      return {
        currentTokens: totalTokens,
        maxTokens: maxContextTokens,
        utilization,
        isWarning: utilization >= warningThreshold,
        isExceeded: utilization >= 1.0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get usage summary as formatted string
   */
  getUsageSummary(): string {
    const usage = this.getUsage();
    if (!usage) return 'No usage data available';

    const lines = [
      `Total Tokens: ${usage.totalTokens.toLocaleString()}`,
      `  - Prompt: ${usage.totalPromptTokens.toLocaleString()}`,
      `  - Completion: ${usage.totalCompletionTokens.toLocaleString()}`,
      `  - Context: ${usage.totalContextTokens.toLocaleString()}`,
    ];

    if (usage.totalCost > 0) {
      lines.push(`Total Cost: $${usage.totalCost.toFixed(4)}`);
    }

    if (usage.modelsUsed.length > 0) {
      lines.push(`Models Used: ${usage.modelsUsed.join(', ')}`);
    }

    lines.push(`Nodes: ${Object.keys(usage.nodeUsages).length}`);

    return lines.join('\n');
  }

  /**
   * Get all memories created during this graph execution
   */
  async getMemories(options?: { limit?: number; sessionId?: string }): Promise<unknown[]> {
    if (!this.graph.id) {
      throw new Error('Graph must be saved before querying memories');
    }

    if (!this.agent) {
      throw new Error('No agent available for this graph');
    }

    const memoryModule = new Memory(this.agent);
    await memoryModule.initialize();

    return memoryModule.listMemories({
      graphId: this.graph.id,
      limit: options?.limit,
      sessionId: options?.sessionId,
    });
  }

  /**
   * Destroy graph resources and free memory.
   * Call this when the graph is no longer needed.
   */
  async destroy(): Promise<void> {
    // Clear active timeouts to prevent memory leaks
    if (this.overallTimeoutId) {
      clearTimeout(this.overallTimeoutId);
      this.overallTimeoutId = null;
    }

    // Clear all node timeouts
    for (const [, timeoutId] of this.activeNodeTimeouts.entries()) {
      clearTimeout(timeoutId);
    }
    this.activeNodeTimeouts.clear();

    // Release execution lock if held
    if (this.releaseLock) {
      try {
        this.releaseLock();
      } catch {
        // Ignore errors during lock release
      }
    }

    // Clear lock references
    this.executionLock = null;
    this.releaseLock = null;

    // Clear graph data
    this.graph.nodes = [];
    this.graph.edges = [];
    this.graph.executionLog = [];
    this.lastNodeId = null;

    // Clear knex reference (shared database, don't close)
    this.knex = null;

    // Clear agent reference
    this.agent = undefined;
    this.logger = undefined;

    // Reset initialization state
    this.initialized = false;
  }
}

export * from './types';
