import { Knex } from 'knex';
import { getDatabase } from '../database';
import { Graph, GraphConfig, GraphNode, GraphEdge } from './types';

export class GraphStorage {
  private knex: Knex;

  constructor() {
    const db = getDatabase();
    this.knex = (db as any).knex;
  }

  async initializeTables(): Promise<void> {
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
        table.integer('graphId').notNullable().references('id').inTable('graphs').onDelete('CASCADE');
        table.string('nodeId').notNullable();
        table.enu('type', ['agent', 'task']).notNullable();
        table.string('name').notNullable();
        table.text('description').nullable();
        table.integer('agentId').nullable();
        table.text('prompt').nullable();
        table.string('model').nullable();
        table.boolean('stream').defaultTo(false);
        table.enu('status', ['pending', 'running', 'completed', 'failed', 'skipped']).defaultTo('pending');
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
        table.integer('graphId').notNullable().references('id').inTable('graphs').onDelete('CASCADE');
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
    const [savedGraph] = await this.knex('graphs')
      .insert({
        name: graph.config.name,
        description: graph.config.description,
        defaultAgentId: graph.config.defaultAgentId,
        maxConcurrency: graph.config.maxConcurrency,
        timeout: graph.config.timeout,
        retryAttempts: graph.config.retryAttempts,
        metadata: graph.config.metadata ? JSON.stringify(graph.config.metadata) : null,
        status: graph.status,
        startedAt: graph.startedAt,
        completedAt: graph.completedAt,
      })
      .returning('id');

    const graphId = savedGraph.id || savedGraph;

    // Save nodes
    for (const node of graph.nodes) {
      await this.knex('graph_nodes').insert({
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
      });
    }

    // Save edges
    for (const edge of graph.edges) {
      await this.knex('graph_edges').insert({
        graphId,
        edgeId: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        condition: edge.condition,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      });
    }

    return graphId;
  }

  async loadGraph(graphId: number): Promise<Graph | null> {
    // Load graph config
    const graphData = await this.knex('graphs')
      .where({ id: graphId })
      .first();

    if (!graphData) {
      return null;
    }

    // Load nodes
    const nodesData = await this.knex('graph_nodes')
      .where({ graphId })
      .orderBy('id');

    // Load edges
    const edgesData = await this.knex('graph_edges')
      .where({ graphId })
      .orderBy('id');

    const nodes: GraphNode[] = nodesData.map(node => ({
      id: node.nodeId,
      type: node.type,
      name: node.name,
      description: node.description,
      agentId: node.agentId,
      prompt: node.prompt,
      model: node.model,
      stream: node.stream,
      status: node.status,
      priority: node.priority,
      dependencies: JSON.parse(node.dependencies || '[]'),
      result: node.result ? JSON.parse(node.result) : undefined,
      error: node.error,
      metadata: node.metadata ? JSON.parse(node.metadata) : undefined,
      createdAt: new Date(node.created_at),
      updatedAt: new Date(node.updated_at),
    }));

    const edges: GraphEdge[] = edgesData.map(edge => ({
      id: edge.edgeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      condition: edge.condition,
      metadata: edge.metadata ? JSON.parse(edge.metadata) : undefined,
    }));

    const graph: Graph = {
      id: graphId,
      config: {
        id: graphId.toString(),
        name: graphData.name,
        description: graphData.description,
        defaultAgentId: graphData.defaultAgentId,
        maxConcurrency: graphData.maxConcurrency,
        timeout: graphData.timeout,
        retryAttempts: graphData.retryAttempts,
        metadata: graphData.metadata ? JSON.parse(graphData.metadata) : undefined,
      },
      nodes,
      edges,
      status: graphData.status,
      startedAt: graphData.startedAt ? new Date(graphData.startedAt) : undefined,
      completedAt: graphData.completedAt ? new Date(graphData.completedAt) : undefined,
      executionLog: [], // Execution log is runtime only
      createdAt: new Date(graphData.created_at),
      updatedAt: new Date(graphData.updated_at),
    };

    return graph;
  }

  async updateGraph(graphId: number, graph: Graph): Promise<void> {
    // Update graph
    await this.knex('graphs')
      .where({ id: graphId })
      .update({
        status: graph.status,
        startedAt: graph.startedAt,
        completedAt: graph.completedAt,
      });

    // Update nodes
    for (const node of graph.nodes) {
      await this.knex('graph_nodes')
        .where({ graphId, nodeId: node.id })
        .update({
          status: node.status,
          result: node.result ? JSON.stringify(node.result) : null,
          error: node.error,
        });
    }
  }

  async deleteGraph(graphId: number): Promise<boolean> {
    const deleted = await this.knex('graphs')
      .where({ id: graphId })
      .delete();

    return deleted > 0;
  }

  async listGraphs(): Promise<{ id: number; name: string; status: string; createdAt: Date }[]> {
    const graphs = await this.knex('graphs')
      .select('id', 'name', 'status', 'created_at')
      .orderBy('created_at', 'desc');

    return graphs.map(g => ({
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