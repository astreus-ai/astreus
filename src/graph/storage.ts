import { Knex } from 'knex';
import crypto from 'crypto';
import { getDatabase } from '../database/index';
import { Graph, GraphNode, GraphEdge } from './types';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { MetadataObject } from '../types';

export class GraphStorage {
  private knex: Knex;
  private logger: Logger;
  private initialized: boolean = false;

  constructor() {
    // Note: knex will be initialized in initialize() method
    this.knex = null!; // Will be initialized in initialize()
    this.logger = getLogger();
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
    // Enable UUID extension for PostgreSQL
    if (process.env.DATABASE_URL?.includes('postgres')) {
      await this.knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    }

    // Create graphs table
    const hasGraphsTable = await this.knex.schema.hasTable('graphs');
    if (!hasGraphsTable) {
      await this.knex.schema.createTable('graphs', (table) => {
        table.string('id', 36).primary(); // UUID generated in application layer
        table.string('name').notNullable();
        table.text('description').nullable();
        table.string('defaultAgentId', 36).nullable();
        table.integer('maxConcurrency').defaultTo(1);
        table.integer('timeout').nullable();
        table.integer('retryAttempts').defaultTo(0);
        table.boolean('autoLink').defaultTo(false);
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
        table.string('id', 36).primary(); // UUID generated in application layer
        table
          .string('graphId', 36)
          .notNullable()
          .references('id')
          .inTable('graphs')
          .onDelete('CASCADE');
        table.string('nodeId').notNullable(); // Internal node ID string (e.g., "node_1_abc")
        table.enu('type', ['agent', 'task']).notNullable();
        table.string('name').notNullable();
        table.text('description').nullable();
        table.string('agentId', 36).nullable();
        table.text('prompt').nullable();
        table.string('model').nullable();
        table.boolean('stream').defaultTo(false);
        table.string('taskId', 36).nullable(); // Task ID created during execution
        table
          .enu('status', ['pending', 'running', 'completed', 'failed', 'skipped', 'scheduled'])
          .defaultTo('pending');
        table.integer('priority').defaultTo(0);
        table.json('dependencies').nullable();
        table.text('result').nullable(); // TEXT - stores encrypted string
        table.text('error').nullable();
        table.json('metadata').nullable(); // JSONB - stores actual JSON data
        table.timestamps(true, true);
        table.index(['graphId']);
        table.index(['nodeId']);
        table.index(['taskId']);
        table.index(['type']);
        table.index(['status']);
        table.index(['graphId', 'status']); // Composite index for graph execution tracking
        table.index(['graphId', 'priority']); // Composite index for priority queue
      });
    } else {
      // Check and add task relationship column
      const hasTaskId = await this.knex.schema.hasColumn('graph_nodes', 'taskId');

      if (!hasTaskId) {
        await this.knex.schema.alterTable('graph_nodes', (table) => {
          table.bigInteger('taskId').nullable();
        });

        // Add indexes
        await this.knex.schema.alterTable('graph_nodes', (table) => {
          table.index('taskId');
          table.index(['graphId', 'status']); // Composite index for graph execution tracking
          table.index(['graphId', 'priority']); // Composite index for priority queue
        });
      }

      // Fix result column type (from JSONB to TEXT for encrypted data)
      await this.knex.raw(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'graph_nodes'
            AND column_name = 'result'
            AND data_type = 'jsonb'
          ) THEN
            ALTER TABLE graph_nodes ALTER COLUMN result TYPE TEXT USING result::TEXT;
          END IF;
        END $$;
      `);
    }

    // Create graph_edges table
    const hasEdgesTable = await this.knex.schema.hasTable('graph_edges');
    if (!hasEdgesTable) {
      await this.knex.schema.createTable('graph_edges', (table) => {
        table.string('id', 36).primary(); // UUID generated in application layer
        table
          .string('graphId', 36)
          .notNullable()
          .references('id')
          .inTable('graphs')
          .onDelete('CASCADE');
        table.string('edgeId').notNullable(); // Internal edge ID string (e.g., "edge_1_abc")
        table.string('fromNodeId').notNullable(); // Internal node ID
        table.string('toNodeId').notNullable(); // Internal node ID
        table.string('condition').nullable();
        table.json('metadata').nullable();
        table.timestamps(true, true);
        table.index(['graphId']);
        table.index(['edgeId']);
      });
    }
  }

  async saveGraph(graph: Graph): Promise<string> {
    await this.initialize();

    // Prepare and encrypt graph data
    const graphData = {
      id: crypto.randomUUID(),
      name: graph.config.name,
      description: graph.config.description,
      defaultAgentId: graph.defaultAgentId || null, // Save default agent ID
      maxConcurrency: graph.config.maxConcurrency,
      timeout: graph.config.timeout,
      retryAttempts: graph.config.retryAttempts,
      autoLink: graph.config.autoLink || false,
      metadata: graph.config.metadata ? JSON.stringify(graph.config.metadata) : null,
      status: graph.status,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };

    const encryptedGraphData = await encryptSensitiveFields(
      graphData as Record<string, string | number | boolean | null | undefined | Date>,
      'graphs'
    );

    const [savedGraph] = await this.knex('graphs').insert(encryptedGraphData).returning('id');

    const graphId = savedGraph.id || savedGraph; // UUID string

    // Save nodes with encryption
    for (const node of graph.nodes) {
      const nodeData = {
        id: crypto.randomUUID(),
        graphId,
        nodeId: node.id,
        type: node.type,
        name: node.name,
        description: node.description,
        agentId: node.agentId,
        prompt: node.prompt,
        model: node.model,
        stream: node.stream,
        taskId: node.taskId, // Task ID created during execution
        status: node.status,
        priority: node.priority,
        dependencies: JSON.stringify(node.dependencies),
        result: node.result || null, // TEXT field - store as-is, no JSON.stringify
        error: node.error,
        metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      };

      const encryptedNodeData = await encryptSensitiveFields(
        nodeData as Record<string, string | number | boolean | null | undefined | Date>,
        'graph_nodes'
      );
      // No need to stringify - prompt/result are TEXT, metadata is handled in encryptSensitiveFields
      await this.knex('graph_nodes').insert(encryptedNodeData);
    }

    // Save edges with encryption
    for (const edge of graph.edges) {
      const edgeData = {
        id: crypto.randomUUID(),
        graphId,
        edgeId: edge.id,
        fromNode: edge.fromNodeId,
        toNode: edge.toNodeId,
        condition: edge.condition,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      };

      const encryptedEdgeData = await encryptSensitiveFields(
        edgeData as Record<string, string | number | boolean | null | undefined | Date>,
        'graph_edges'
      );
      // metadata is handled in encryptSensitiveFields
      await this.knex('graph_edges').insert(encryptedEdgeData);
    }

    return graphId;
  }

  async loadGraph(graphId: string): Promise<Graph | null> {
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
          agentId: decryptedNode.agentId as string | undefined,
          prompt: decryptedNode.prompt as string | undefined,
          model: decryptedNode.model as string | undefined,
          stream: decryptedNode.stream as boolean | undefined,
          taskId: decryptedNode.taskId as string | undefined, // Task ID from execution
          status: decryptedNode.status as GraphNode['status'],
          priority: decryptedNode.priority as number,
          dependencies: (() => {
            if (!decryptedNode.dependencies) return [];
            // If already parsed by DB driver (PostgreSQL/Knex behavior)
            if (typeof decryptedNode.dependencies === 'object') {
              return decryptedNode.dependencies;
            }
            // If string, parse it
            if (
              typeof decryptedNode.dependencies === 'string' &&
              decryptedNode.dependencies !== ''
            ) {
              return JSON.parse(decryptedNode.dependencies);
            }
            return [];
          })(),
          result: decryptedNode.result as string | undefined, // TEXT field - no JSON parse needed
          error: decryptedNode.error as string | undefined,
          metadata: (decryptedNode.metadata as unknown as MetadataObject) || undefined, // Already parsed by decryptSensitiveFields
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
          fromNodeId: decryptedEdge.fromNode as string,
          toNodeId: decryptedEdge.toNode as string,
          condition: decryptedEdge.condition as string | undefined,
          metadata: (decryptedEdge.metadata as unknown as MetadataObject) || undefined, // Already parsed by decryptSensitiveFields
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      })
    );

    const graph: Graph = {
      id: graphId,
      defaultAgentId: decryptedGraphData.defaultAgentId as string | undefined, // Load default agent ID
      config: {
        id: graphId,
        name: decryptedGraphData.name as string,
        description: decryptedGraphData.description as string | undefined,
        maxConcurrency: decryptedGraphData.maxConcurrency as number | undefined,
        timeout: decryptedGraphData.timeout as number | undefined,
        retryAttempts: decryptedGraphData.retryAttempts as number | undefined,
        autoLink: decryptedGraphData.autoLink as boolean | undefined,
        metadata: (decryptedGraphData.metadata as unknown as MetadataObject) || undefined, // Already parsed by decryptSensitiveFields
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

  async updateGraph(graphId: string, graph: Graph): Promise<void> {
    await this.initialize();

    this.logger.debug(
      `Updating graph ${graphId} with ${graph.nodes.length} nodes and ${graph.edges.length} edges`
    );

    // Prepare and encrypt graph update data
    const graphUpdateData = {
      status: graph.status,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };

    const encryptedGraphUpdate = await encryptSensitiveFields(
      graphUpdateData as Record<string, string | number | boolean | null | undefined | Date>,
      'graphs'
    );
    await this.knex('graphs').where({ id: graphId }).update(encryptedGraphUpdate);

    // Update or insert nodes with encryption
    for (const node of graph.nodes) {
      // Check if node exists
      const existingNode = await this.knex('graph_nodes')
        .where({ graphId, nodeId: node.id })
        .first();

      if (existingNode) {
        // Update existing node
        this.logger.debug(`Updating existing node ${node.id} in graph ${graphId}`);
        const nodeUpdateData = {
          status: node.status,
          taskId: node.taskId,
          result: node.result || null, // TEXT field - store as-is
          error: node.error,
        };

        const encryptedNodeUpdate = await encryptSensitiveFields(
          nodeUpdateData as Record<string, string | number | boolean | null | undefined | Date>,
          'graph_nodes'
        );
        await this.knex('graph_nodes')
          .where({ graphId, nodeId: node.id })
          .update(encryptedNodeUpdate);
      } else {
        // Insert new node
        this.logger.debug(`Inserting new node ${node.id} into graph ${graphId}`);
        const nodeData = {
          id: crypto.randomUUID(),
          graphId,
          nodeId: node.id,
          type: node.type,
          name: node.name,
          description: node.description,
          agentId: node.agentId,
          prompt: node.prompt,
          model: node.model,
          stream: node.stream,
          taskId: node.taskId,
          status: node.status,
          priority: node.priority,
          dependencies: JSON.stringify(node.dependencies),
          result: node.result || null, // TEXT field - store as-is
          error: node.error,
          metadata: node.metadata ? JSON.stringify(node.metadata) : null,
        };

        const encryptedNodeData = await encryptSensitiveFields(
          nodeData as Record<string, string | number | boolean | null | undefined | Date>,
          'graph_nodes'
        );
        // No need to stringify - prompt/result are TEXT, metadata is handled in encryptSensitiveFields
        await this.knex('graph_nodes').insert(encryptedNodeData);
        this.logger.debug(`Node ${node.id} inserted successfully`);
      }
    }

    // Update or insert edges with encryption
    for (const edge of graph.edges) {
      // Check if edge exists
      const existingEdge = await this.knex('graph_edges')
        .where({ graphId, edgeId: edge.id })
        .first();

      if (!existingEdge) {
        // Insert new edge
        this.logger.debug(
          `Inserting new edge ${edge.id} into graph ${graphId} (${edge.fromNodeId} → ${edge.toNodeId})`
        );
        const edgeData = {
          id: crypto.randomUUID(),
          graphId,
          edgeId: edge.id,
          fromNode: edge.fromNodeId,
          toNode: edge.toNodeId,
          condition: edge.condition,
          metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
        };

        const encryptedEdgeData = await encryptSensitiveFields(
          edgeData as Record<string, string | number | boolean | null | undefined | Date>,
          'graph_edges'
        );
        // metadata is handled in encryptSensitiveFields
        await this.knex('graph_edges').insert(encryptedEdgeData);
        this.logger.debug(`Edge ${edge.id} inserted successfully`);
      }
    }

    this.logger.debug(`Graph ${graphId} update completed`);
  }

  async deleteGraph(graphId: string): Promise<boolean> {
    await this.initialize();
    const deleted = await this.knex('graphs').where({ id: graphId }).delete();

    return deleted > 0;
  }

  async listGraphs(): Promise<{ id: string; name: string; status: string; createdAt: Date }[]> {
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
