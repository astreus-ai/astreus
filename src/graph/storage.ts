import { Knex } from 'knex';
import { getDatabase } from '../database/index';
import { Graph, GraphNode, GraphEdge } from './types';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';

export class GraphStorage {
  private knex: Knex;
  private initialized: boolean = false;

  constructor() {
    // Note: knex will be initialized in initialize() method
    this.knex = null!; // Will be initialized in initialize()
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const db = await getDatabase();
    this.knex = db.getKnex();
    await this.createTables();
    this.initialized = true;
  }

  async initializeTables(): Promise<void> {
    await this.initialize();
  }

  private async createTables(): Promise<void> {
    // Create graphs table
    const hasGraphsTable = await this.knex.schema.hasTable('graphs');
    if (!hasGraphsTable) {
      await this.knex.schema.createTable('graphs', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.text('description').nullable();
        table.integer('defaultAgentId').nullable();
        table.integer('maxConcurrency').defaultTo(1);
        table.integer('timeout').nullable();
        table.integer('retryAttempts').defaultTo(0);
        table.json('metadata').nullable();
        table.enu('status', ['idle', 'running', 'completed', 'failed', 'paused']).defaultTo('idle');
        table.timestamp('startedAt').nullable();
        table.timestamp('completedAt').nullable();
        table.timestamps(true, true);
        table.index(['defaultAgentId']);
        table.index(['status']);
      });
    }

    // Create graph_nodes table
    const hasNodesTable = await this.knex.schema.hasTable('graph_nodes');
    if (!hasNodesTable) {
      await this.knex.schema.createTable('graph_nodes', (table) => {
        table.increments('id').primary();
        table
          .integer('graphId')
          .notNullable()
          .references('id')
          .inTable('graphs')
          .onDelete('CASCADE');
        table.string('nodeId').notNullable();
        table.enu('type', ['agent', 'task']).notNullable();
        table.string('name').notNullable();
        table.text('description').nullable();
        table.integer('agentId').nullable();
        table.text('prompt').nullable();
        table.string('model').nullable();
        table.boolean('stream').defaultTo(false);
        table
          .enu('status', ['pending', 'running', 'completed', 'failed', 'skipped'])
          .defaultTo('pending');
        table.integer('priority').defaultTo(0);
        table.json('dependencies').nullable();
        table.json('result').nullable();
        table.text('error').nullable();
        table.json('metadata').nullable();
        table.timestamps(true, true);
        table.index(['graphId']);
        table.index(['nodeId']);
        table.index(['type']);
        table.index(['status']);
      });
    }

    // Create graph_edges table
    const hasEdgesTable = await this.knex.schema.hasTable('graph_edges');
    if (!hasEdgesTable) {
      await this.knex.schema.createTable('graph_edges', (table) => {
        table.increments('id').primary();
        table
          .integer('graphId')
          .notNullable()
          .references('id')
          .inTable('graphs')
          .onDelete('CASCADE');
        table.string('edgeId').notNullable();
        table.string('fromNodeId').notNullable();
        table.string('toNodeId').notNullable();
        table.string('condition').nullable();
        table.json('metadata').nullable();
        table.timestamps(true, true);
        table.index(['graphId']);
        table.index(['edgeId']);
      });
    }
  }

  async saveGraph(graph: Graph): Promise<number> {
    await this.initialize();

    // Prepare and encrypt graph data
    const graphData = {
      name: graph.config.name,
      description: graph.config.description,
      maxConcurrency: graph.config.maxConcurrency,
      timeout: graph.config.timeout,
      retryAttempts: graph.config.retryAttempts,
      metadata: graph.config.metadata ? JSON.stringify(graph.config.metadata) : null,
      status: graph.status,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };

    const encryptedGraphData = await encryptSensitiveFields(graphData, 'graphs');

    const [savedGraph] = await this.knex('graphs').insert(encryptedGraphData).returning('id');

    const graphId = savedGraph.id || savedGraph;

    // Save nodes with encryption
    for (const node of graph.nodes) {
      const nodeData = {
        graphId,
        nodeId: node.id,
        type: node.type,
        name: node.name,
        description: node.description,
        agentId: node.agentId,
        prompt: node.prompt,
        model: node.model,
        stream: node.stream,
        status: node.status,
        priority: node.priority,
        dependencies: JSON.stringify(node.dependencies),
        result: node.result ? JSON.stringify(node.result) : null,
        error: node.error,
        metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      };

      const encryptedNodeData = await encryptSensitiveFields(nodeData, 'graph_nodes');
      await this.knex('graph_nodes').insert(encryptedNodeData);
    }

    // Save edges with encryption
    for (const edge of graph.edges) {
      const edgeData = {
        graphId,
        edgeId: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        condition: edge.condition,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      };

      const encryptedEdgeData = await encryptSensitiveFields(edgeData, 'graph_edges');
      await this.knex('graph_edges').insert(encryptedEdgeData);
    }

    return graphId;
  }

  async loadGraph(graphId: number): Promise<Graph | null> {
    await this.initialize();
    // Load graph config
    const graphData = await this.knex('graphs').where({ id: graphId }).first();

    if (!graphData) {
      return null;
    }

    // Decrypt graph data
    const decryptedGraphData = await decryptSensitiveFields(graphData, 'graphs');

    // Load nodes
    const nodesData = await this.knex('graph_nodes').where({ graphId }).orderBy('id');

    // Load edges
    const edgesData = await this.knex('graph_edges').where({ graphId }).orderBy('id');

    // Decrypt and map nodes
    const nodes: GraphNode[] = await Promise.all(
      nodesData.map(async (node) => {
        const decryptedNode = await decryptSensitiveFields(node, 'graph_nodes');
        return {
          id: decryptedNode.nodeId as string,
          type: decryptedNode.type as 'agent' | 'task',
          name: decryptedNode.name as string,
          description: decryptedNode.description as string | undefined,
          agentId: decryptedNode.agentId as number | undefined,
          prompt: decryptedNode.prompt as string | undefined,
          model: decryptedNode.model as string | undefined,
          stream: decryptedNode.stream as boolean | undefined,
          status: decryptedNode.status as GraphNode['status'],
          priority: decryptedNode.priority as number,
          dependencies: JSON.parse((decryptedNode.dependencies as string) || '[]'),
          result: decryptedNode.result ? JSON.parse(decryptedNode.result as string) : undefined,
          error: decryptedNode.error as string | undefined,
          metadata: decryptedNode.metadata
            ? JSON.parse(decryptedNode.metadata as string)
            : undefined,
          createdAt: new Date(node.created_at),
          updatedAt: new Date(node.updated_at),
        };
      })
    );

    // Decrypt and map edges
    const edges: GraphEdge[] = await Promise.all(
      edgesData.map(async (edge) => {
        const decryptedEdge = await decryptSensitiveFields(edge, 'graph_edges');
        return {
          id: decryptedEdge.edgeId as string,
          fromNodeId: decryptedEdge.fromNodeId as string,
          toNodeId: decryptedEdge.toNodeId as string,
          condition: decryptedEdge.condition as string | undefined,
          metadata: decryptedEdge.metadata
            ? JSON.parse(decryptedEdge.metadata as string)
            : undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      })
    );

    const graph: Graph = {
      id: graphId,
      config: {
        id: graphId,
        name: decryptedGraphData.name as string,
        description: decryptedGraphData.description as string | undefined,
        maxConcurrency: decryptedGraphData.maxConcurrency as number | undefined,
        timeout: decryptedGraphData.timeout as number | undefined,
        retryAttempts: decryptedGraphData.retryAttempts as number | undefined,
        metadata: decryptedGraphData.metadata
          ? JSON.parse(decryptedGraphData.metadata as string)
          : undefined,
      },
      nodes,
      edges,
      status: decryptedGraphData.status as Graph['status'],
      startedAt: decryptedGraphData.startedAt
        ? new Date(decryptedGraphData.startedAt as string)
        : undefined,
      completedAt: decryptedGraphData.completedAt
        ? new Date(decryptedGraphData.completedAt as string)
        : undefined,
      executionLog: [], // Execution log is runtime only
      createdAt: new Date(graphData.created_at),
      updatedAt: new Date(graphData.updated_at),
    };

    return graph;
  }

  async updateGraph(graphId: number, graph: Graph): Promise<void> {
    await this.initialize();

    // Prepare and encrypt graph update data
    const graphUpdateData = {
      status: graph.status,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };

    const encryptedGraphUpdate = await encryptSensitiveFields(graphUpdateData, 'graphs');
    await this.knex('graphs').where({ id: graphId }).update(encryptedGraphUpdate);

    // Update nodes with encryption
    for (const node of graph.nodes) {
      const nodeUpdateData = {
        status: node.status,
        result: node.result ? JSON.stringify(node.result) : null,
        error: node.error,
      };

      const encryptedNodeUpdate = await encryptSensitiveFields(nodeUpdateData, 'graph_nodes');
      await this.knex('graph_nodes')
        .where({ graphId, nodeId: node.id })
        .update(encryptedNodeUpdate);
    }
  }

  async deleteGraph(graphId: number): Promise<boolean> {
    await this.initialize();
    const deleted = await this.knex('graphs').where({ id: graphId }).delete();

    return deleted > 0;
  }

  async listGraphs(): Promise<{ id: number; name: string; status: string; createdAt: Date }[]> {
    await this.initialize();
    const graphs = await this.knex('graphs')
      .select('id', 'name', 'status', 'created_at')
      .orderBy('created_at', 'desc');

    return graphs.map((g) => ({
      id: g.id,
      name: g.name,
      status: g.status,
      createdAt: new Date(g.created_at),
    }));
  }
}

let storage: GraphStorage | null = null;

export function getGraphStorage(): GraphStorage {
  if (!storage) {
    storage = new GraphStorage();
  }
  return storage;
}

export async function initializeGraphStorage(): Promise<void> {
  const storage = getGraphStorage();
  await storage.initializeTables();
}
