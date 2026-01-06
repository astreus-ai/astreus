import { Knex } from 'knex';
import crypto from 'crypto';
import { getDatabase, Database } from '../database/index';
import { Graph, GraphNode, GraphEdge } from './types';
import { encryptSensitiveFields, decryptSensitiveFields } from '../database/utils';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { MetadataObject } from '../types';

export class GraphStorage {
  private knex: Knex | null = null;
  private db: Database | null = null;
  private logger: Logger;
  private initialized: boolean = false;

  constructor() {
    // Note: knex and db will be initialized in initialize() method
    this.logger = getLogger();
  }

  /**
   * Ensure database is initialized and return knex instance
   * @throws Error if database is not initialized
   */
  private getKnex(): Knex {
    if (!this.knex) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.knex;
  }

  /**
   * Ensure database is initialized and return db instance
   * @throws Error if database is not initialized
   */
  private getDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.db = await getDatabase();
    this.knex = this.db.getKnex();
    await this.createTables();
    this.initialized = true;
  }

  async initializeTables(): Promise<void> {
    await this.initialize();
  }

  private async createTables(): Promise<void> {
    const knex = this.getKnex();
    const db = this.getDb();

    // Enable UUID extension for PostgreSQL
    if (db.isPostgres()) {
      await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    }

    // Create graphs table
    const hasGraphsTable = await knex.schema.hasTable('graphs');
    if (!hasGraphsTable) {
      await knex.schema.createTable('graphs', (table) => {
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
    const hasNodesTable = await knex.schema.hasTable('graph_nodes');
    if (!hasNodesTable) {
      await knex.schema.createTable('graph_nodes', (table) => {
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
      const hasTaskId = await knex.schema.hasColumn('graph_nodes', 'taskId');

      if (!hasTaskId) {
        await knex.schema.alterTable('graph_nodes', (table) => {
          table.string('taskId', 36).nullable();
        });

        // Add indexes
        await knex.schema.alterTable('graph_nodes', (table) => {
          table.index('taskId');
          table.index(['graphId', 'status']); // Composite index for graph execution tracking
          table.index(['graphId', 'priority']); // Composite index for priority queue
        });
      }

      // Fix result column type (from JSONB to TEXT for encrypted data)
      // Only run this migration for PostgreSQL - SQLite doesn't have JSONB type
      if (db.isPostgres()) {
        await knex.raw(`
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
    }

    // Create graph_edges table
    const hasEdgesTable = await knex.schema.hasTable('graph_edges');
    if (!hasEdgesTable) {
      await knex.schema.createTable('graph_edges', (table) => {
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
    const knex = this.getKnex();

    const graphId = crypto.randomUUID();

    // Use transaction to ensure atomicity - all or nothing
    await knex.transaction(async (trx) => {
      // Prepare and encrypt graph data
      const graphData = {
        id: graphId,
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

      // Insert graph
      await trx('graphs').insert(encryptedGraphData);

      // Prepare and encrypt all nodes
      if (graph.nodes.length > 0) {
        const nodeDataList = await Promise.all(
          graph.nodes.map(async (node) => {
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

            return encryptSensitiveFields(
              nodeData as Record<string, string | number | boolean | null | undefined | Date>,
              'graph_nodes'
            );
          })
        );

        // Batch insert all nodes
        await trx('graph_nodes').insert(nodeDataList);
      }

      // Prepare and encrypt all edges
      if (graph.edges.length > 0) {
        const edgeDataList = await Promise.all(
          graph.edges.map(async (edge) => {
            const edgeData = {
              id: crypto.randomUUID(),
              graphId,
              edgeId: edge.id,
              fromNodeId: edge.fromNodeId,
              toNodeId: edge.toNodeId,
              condition: edge.condition,
              metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
            };

            return encryptSensitiveFields(
              edgeData as Record<string, string | number | boolean | null | undefined | Date>,
              'graph_edges'
            );
          })
        );

        // Batch insert all edges
        await trx('graph_edges').insert(edgeDataList);
      }
    });

    return graphId;
  }

  async loadGraph(graphId: string): Promise<Graph | null> {
    await this.initialize();
    const knex = this.getKnex();

    // Load graph config
    const graphData = await knex('graphs').where({ id: graphId }).first();

    if (!graphData) {
      return null;
    }

    // Decrypt graph data
    const decryptedGraphData = await decryptSensitiveFields(graphData, 'graphs');

    // Load nodes
    const nodesData = await knex('graph_nodes').where({ graphId }).orderBy('id');

    // Load edges
    const edgesData = await knex('graph_edges').where({ graphId }).orderBy('id');

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
          fromNodeId: decryptedEdge.fromNodeId as string,
          toNodeId: decryptedEdge.toNodeId as string,
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
    const knex = this.getKnex();

    this.logger.debug(
      `Updating graph ${graphId} with ${graph.nodes.length} nodes and ${graph.edges.length} edges`
    );

    // Use transaction for atomicity and batch queries to prevent N+1
    await knex.transaction(async (trx) => {
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
      await trx('graphs').where({ id: graphId }).update(encryptedGraphUpdate);

      // Batch query: Get all existing nodes in one query (prevents N+1)
      const existingNodes = await trx('graph_nodes')
        .where({ graphId })
        .whereIn(
          'nodeId',
          graph.nodes.map((n) => n.id)
        )
        .select('nodeId');

      const existingNodeIds = new Set(existingNodes.map((n) => n.nodeId));

      // Separate nodes into update and insert batches
      const nodesToUpdate = graph.nodes.filter((n) => existingNodeIds.has(n.id));
      const nodesToInsert = graph.nodes.filter((n) => !existingNodeIds.has(n.id));

      // Batch update existing nodes
      for (const node of nodesToUpdate) {
        const nodeUpdateData = {
          status: node.status,
          taskId: node.taskId,
          result: node.result || null,
          error: node.error,
        };

        const encryptedNodeUpdate = await encryptSensitiveFields(
          nodeUpdateData as Record<string, string | number | boolean | null | undefined | Date>,
          'graph_nodes'
        );
        await trx('graph_nodes').where({ graphId, nodeId: node.id }).update(encryptedNodeUpdate);
      }

      // Batch insert new nodes
      if (nodesToInsert.length > 0) {
        this.logger.debug(
          `Batch inserting ${nodesToInsert.length} new nodes into graph ${graphId}`
        );
        const nodeDataList = await Promise.all(
          nodesToInsert.map(async (node) => {
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
              result: node.result || null,
              error: node.error,
              metadata: node.metadata ? JSON.stringify(node.metadata) : null,
            };

            return encryptSensitiveFields(
              nodeData as Record<string, string | number | boolean | null | undefined | Date>,
              'graph_nodes'
            );
          })
        );

        await trx('graph_nodes').insert(nodeDataList);
      }

      // Batch query: Get all existing edges in one query (prevents N+1)
      const existingEdges = await trx('graph_edges')
        .where({ graphId })
        .whereIn(
          'edgeId',
          graph.edges.map((e) => e.id)
        )
        .select('edgeId');

      const existingEdgeIds = new Set(existingEdges.map((e) => e.edgeId));

      // Filter edges to insert (only new ones)
      const edgesToInsert = graph.edges.filter((e) => !existingEdgeIds.has(e.id));

      // Batch insert new edges
      if (edgesToInsert.length > 0) {
        this.logger.debug(
          `Batch inserting ${edgesToInsert.length} new edges into graph ${graphId}`
        );
        const edgeDataList = await Promise.all(
          edgesToInsert.map(async (edge) => {
            const edgeData = {
              id: crypto.randomUUID(),
              graphId,
              edgeId: edge.id,
              fromNodeId: edge.fromNodeId,
              toNodeId: edge.toNodeId,
              condition: edge.condition,
              metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
            };

            return encryptSensitiveFields(
              edgeData as Record<string, string | number | boolean | null | undefined | Date>,
              'graph_edges'
            );
          })
        );

        await trx('graph_edges').insert(edgeDataList);
      }
    });

    this.logger.debug(`Graph ${graphId} update completed`);
  }

  async deleteGraph(graphId: string): Promise<boolean> {
    await this.initialize();
    const knex = this.getKnex();

    const deleted = await knex('graphs').where({ id: graphId }).delete();

    return deleted > 0;
  }

  async listGraphs(): Promise<{ id: string; name: string; status: string; createdAt: Date }[]> {
    await this.initialize();
    const knex = this.getKnex();

    const graphs = await knex('graphs')
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

// Singleton pattern with proper async mutex for race condition prevention

/**
 * Simple async mutex for protecting initialization.
 * Replaces spin-wait anti-pattern with proper promise-based waiting.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

let storage: GraphStorage | null = null;
let initPromise: Promise<GraphStorage> | null = null;
const initMutex = new AsyncMutex();

export function getGraphStorage(): GraphStorage {
  if (!storage) {
    storage = new GraphStorage();
  }
  return storage;
}

/**
 * Get or create singleton GraphStorage instance with proper initialization
 * This prevents race conditions when multiple callers request the instance simultaneously
 */
export async function getGraphStorageAsync(): Promise<GraphStorage> {
  // Fast path: already initialized
  if (storage) return storage;

  // If already initializing, wait for the promise
  // Keep reference to avoid race condition where initPromise becomes null
  const existingPromise = initPromise;
  if (existingPromise) {
    return existingPromise;
  }

  // Use proper async mutex instead of spin-wait
  await initMutex.acquire();
  try {
    // Double-check after acquiring lock
    if (storage) return storage;

    // Check again if initialization started while waiting for lock
    const currentPromise = initPromise;
    if (currentPromise) {
      // Release mutex early since we'll wait on the promise
      initMutex.release();
      return currentPromise;
    }

    // Create and store the initialization promise
    // Keep the promise alive until storage is fully initialized
    initPromise = (async () => {
      try {
        const newStorage = new GraphStorage();
        await newStorage.initializeTables();
        storage = newStorage;
        return newStorage;
      } catch (error) {
        // On error, clear promise so next caller can retry
        initPromise = null;
        throw error;
      }
    })();

    // Wait for initialization to complete before releasing mutex
    const result = await initPromise;
    // Clear promise only after successful initialization
    // This prevents race condition where initPromise is null but storage is set
    initPromise = null;
    return result;
  } finally {
    initMutex.release();
  }
}

export async function initializeGraphStorage(): Promise<void> {
  const storage = getGraphStorage();
  await storage.initializeTables();
}
