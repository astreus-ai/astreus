import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Graph } from '../src/graph';
import type { GraphNode, GraphUsage, NodeUsage } from '../src/graph/types';
import { initializeLoggerSync } from '../src/logger';

initializeLoggerSync({ level: 'silent', enableConsole: false, enableFile: false });

function usage(cost?: number): NodeUsage {
  return {
    promptTokens: 2,
    completionTokens: 1,
    totalTokens: 3,
    ...(cost !== undefined ? { cost } : {}),
  };
}

interface Execution {
  usage?: NodeUsage;
  fail?: boolean;
  wait?: Promise<void>;
  onStarted?: () => void;
}

function executionGraph(context: TestContext, executions: Execution[]) {
  const graph = new Graph({ name: 'graph-cost-regression', maxConcurrency: 1 });
  graph.getGraph().id = randomUUID();
  context.mock.method(graph, 'initialize', async () => {});
  context.mock.method(graph, 'update', async () => {});
  let executionIndex = 0;

  // The scheduler, raw Graph.run result and public aggregate accessors are real.
  // Replace external task execution and storage so no credentials or provider calls are needed.
  Object.defineProperty(graph, 'executeNode', {
    value: async (node: GraphNode) => {
      if (node.type === 'agent') return { type: 'agent', agentId: node.agentId };
      const execution = executions[executionIndex++];
      assert.ok(execution, 'Unexpected task execution');
      node.status = 'running';
      node.usage = undefined;
      execution.onStarted?.();
      await execution.wait;
      if (execution.fail) throw new Error('Task ended without final pricing');
      return {
        type: 'task',
        taskId: randomUUID(),
        response: 'Completed task.',
        ...(execution.usage ? { usage: execution.usage } : {}),
      };
    },
  });

  return graph;
}

function addTask(graph: Graph): string {
  return graph.addTaskNode({ prompt: 'Run a cost regression.', agentId: randomUUID() });
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function assertUnknown(graph: Graph, aggregate: GraphUsage) {
  assert.equal(aggregate.totalCost, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(aggregate, 'totalCost'), false);
  assert.equal(graph.getTotalCost(), undefined);
  assert.equal(graph.getUsage()?.totalCost, undefined);
  assert.match(graph.getUsageSummary(), /Total Cost: unavailable/);
  assert.doesNotMatch(graph.getUsageSummary(), /Total Cost: \$/);
}

test('public graph cost types explicitly permit unavailable totals', () => {
  const aggregateCost: GraphUsage['totalCost'] = undefined;
  const accessorCost: ReturnType<Graph['getTotalCost']> = undefined;
  assert.equal(aggregateCost, accessorCost);
});

for (const stream of [false, true]) {
  const mode = stream ? 'streaming' : 'regular';

  test(`${mode}: Graph.run and getTotalCost preserve the full known amount`, async (context) => {
    const graph = executionGraph(context, [{ usage: usage(0.125) }, { usage: usage(0.25) }]);
    const first = addTask(graph);
    const second = addTask(graph);
    const result = await graph.run({ stream, timeout: 5000, nodeTimeout: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.usage.totalCost, 0.375);
    assert.equal(result.usage.totalTokens, 6);
    assert.equal(graph.getTotalCost(), 0.375);
    assert.equal(graph.getNodeUsage(first)?.cost, 0.125);
    assert.equal(graph.getNodeUsage(second)?.cost, 0.25);
    assert.match(graph.getUsageSummary(), /Total Cost: \$0\.3750/);
  });

  test(`${mode}: explicitly priced free tasks remain known zero`, async (context) => {
    const graph = executionGraph(context, [{ usage: usage(0) }, { usage: usage(0) }]);
    addTask(graph);
    addTask(graph);
    const result = await graph.run({ stream, timeout: 5000, nodeTimeout: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.usage.totalCost, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(result.usage, 'totalCost'), true);
    assert.equal(graph.getTotalCost(), 0);
    assert.match(graph.getUsageSummary(), /Total Cost: \$0\.0000/);
  });

  for (const [label, unpriced] of [
    ['missing usage', undefined],
    ['missing cost', usage()],
    ['negative cost', usage(-0.25)],
    ['NaN cost', usage(Number.NaN)],
    ['infinite cost', usage(Number.POSITIVE_INFINITY)],
  ] as const) {
    test(`${mode}: ${label} never turns a priced subtotal into the full total`, async (context) => {
      const graph = executionGraph(context, [{ usage: usage(0.125) }, { usage: unpriced }]);
      const priced = addTask(graph);
      const unknown = addTask(graph);
      const result = await graph.run({ stream, timeout: 5000, nodeTimeout: 5000 });
      assert.equal(result.success, true);
      assert.equal(result.completedNodes, 2);
      assert.equal(graph.getNodeUsage(priced)?.cost, 0.125);
      assert.equal(
        graph.getNodeUsage(unknown),
        unpriced ? result.usage.nodeUsages[unknown] : undefined
      );
      assertUnknown(graph, result.usage);
    });
  }

  test(`${mode}: failed executed tasks without final billing keep aggregate unknown`, async (context) => {
    const graph = executionGraph(context, [{ usage: usage(0.125) }, { fail: true }]);
    addTask(graph);
    const failed = addTask(graph);
    const result = await graph.run({ stream, timeout: 5000, nodeTimeout: 5000 });
    assert.equal(result.success, false);
    assert.equal(graph.getNode(failed)?.status, 'failed');
    assertUnknown(graph, result.usage);
  });
}

test('an active and then unpriced turn cannot reuse a previous cached graph total', async (context) => {
  const started = signal();
  const release = signal();
  const executions: Execution[] = [
    { usage: usage(0.125) },
    { wait: release.promise, onStarted: started.resolve },
  ];
  const graph = executionGraph(context, executions);
  const first = addTask(graph);
  const known = await graph.run({ timeout: 5000, nodeTimeout: 5000 });
  assert.equal(known.usage.totalCost, 0.125);
  assert.equal(graph.getGraph().usage?.totalCost, 0.125);
  const second = addTask(graph);
  const running = graph.run({ stream: true, timeout: 5000, nodeTimeout: 5000 });
  await started.promise;
  assert.equal(graph.getTotalCost(), undefined);
  release.resolve();
  const unknown = await running;
  assert.equal(graph.getNodeUsage(first)?.cost, 0.125);
  assert.equal(graph.getNodeUsage(second), undefined);
  assertUnknown(graph, unknown.usage);
});

test('never-executed tasks and non-billable agent nodes do not invent uncertainty', async (context) => {
  const graph = executionGraph(context, []);
  const empty = await graph.run({ timeout: 5000, nodeTimeout: 5000 });
  assert.equal(empty.usage.totalCost, 0);
  graph.addAgentNode({ agentId: randomUUID() });
  const agentOnly = await graph.run({ timeout: 5000, nodeTimeout: 5000 });
  assert.equal(agentOnly.usage.totalCost, 0);
  for (const status of ['pending', 'scheduled', 'skipped'] as const) {
    const id = addTask(graph);
    const node = graph.getNode(id);
    assert.ok(node);
    node.status = status;
  }
  assert.equal(graph.getTotalCost(), 0);
});

test('overflow is unavailable rather than an infinite aggregate charge', async (context) => {
  const graph = executionGraph(context, [
    { usage: usage(Number.MAX_VALUE) },
    { usage: usage(Number.MAX_VALUE) },
  ]);
  addTask(graph);
  addTask(graph);
  const result = await graph.run({ timeout: 5000, nodeTimeout: 5000 });
  assertUnknown(graph, result.usage);
});
