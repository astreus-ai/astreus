import { Agent, Graph } from './src';

// Streaming Graph Chat Example
async function streamingGraphChat() {
  console.log('=== Streaming Graph Chat ===');
  
  const chatAgent = await Agent.create({
    name: 'Streaming Chat Agent',
    model: 'gpt-4o',
    memory: true,
    systemPrompt: 'You are a helpful assistant. Keep responses conversational.'
  });

  const graph = new Graph({
    name: 'Streaming Chat Session',
    defaultAgentId: chatAgent.getId()
  });

  // Add streaming task nodes
  const node1 = graph.addTaskNode({
    prompt: "Hello! I'm learning React. Can you help me?",
    stream: true, // Enable streaming for this node
    priority: 10
  });

  const node2 = graph.addTaskNode({
    prompt: "What are React hooks and why should I use them?",
    stream: true, // Enable streaming for this node
    priority: 8,
    dependencies: [node1]
  });

  const node3 = graph.addTaskNode({
    prompt: "Can you give me a simple useState example?",
    stream: false, // No streaming for this one
    priority: 6,
    dependencies: [node2]
  });

  console.log('Executing graph with streaming nodes...\n');

  // Execute the graph
  const result = await graph.run();

  console.log('\n=== Graph Results ===');
  console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Duration: ${result.duration}ms`);

  // Show results for each node
  Object.entries(result.results).forEach(([nodeId, nodeResult]) => {
    const node = graph.getNode(nodeId);
    console.log(`\n--- ${node?.name} (Stream: ${node?.stream}) ---`);
    if (nodeResult.type === 'task') {
      console.log(`Response: ${nodeResult.response.substring(0, 100)}...`);
      console.log(`Model: ${nodeResult.model}`);
    }
  });
}

// Real-time streaming graph (concept)
async function realTimeStreamingGraph() {
  console.log('\n=== Real-time Streaming Graph Concept ===');
  
  const agent = await Agent.create({
    name: 'RT Stream Agent',
    model: 'claude-3-5-sonnet-20241022',
    memory: true
  });

  const graph = new Graph({
    name: 'RT Stream Session',
    defaultAgentId: agent.getId()
  });

  // For real-time streaming, we'd need to modify graph execution
  // This is conceptual - actual implementation would require:
  
  // 1. Graph.runWithStreaming() method
  // 2. Event emitters for node completion
  // 3. WebSocket/SSE integration
  
  console.log('Conceptual real-time streaming:');
  console.log('1. Client connects via WebSocket');
  console.log('2. Graph.runWithStreaming() starts execution');
  console.log('3. Each streaming node emits chunks in real-time');
  console.log('4. Client receives live updates per node');
  console.log('5. Graph completes with full results');
}

async function main() {
  await streamingGraphChat();
  await realTimeStreamingGraph();
}

main().catch(console.error);