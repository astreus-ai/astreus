<p align="center">
   <img src="https://raw.githubusercontent.com/astreus-ai/astreus/main/src/assets/astreus-logo.svg" alt="Astreus Logo" width="150" />
</p>

<h1 align="center">Astreus</h1>

An AI Agent Framework designed to help you easily build, deploy, and manage intelligent conversational agents powered by large language models (LLMs).

## 🌟 Features

- **Unified Agent API**: Create and manage AI agents with a consistent interface 
- **Multi-Provider Support**: Works with OpenAI and Ollama models out of the box
- **Memory Management**: Built-in conversation history with vector search capabilities
- **Task Orchestration**: Break complex requests into manageable sub-tasks
- **Plugin System**: Extend agent capabilities with custom tools
- **Persistence Layer**: Automatic storage using SQLite or PostgreSQL
- **RAG Support**: Built-in Retrieval Augmented Generation with PDF parsing
- **Embeddings Support**: Semantic search across conversations and documents
- **Type Safety**: Fully typed with TypeScript
- **Advanced Logging**: Structured logging system for improved debugging and monitoring
- **Flexible Configuration**: Enhanced parameter validation and smart defaults

## 🚀 Getting Started

### 🛠 Prerequisites

- Node.js 16 or higher
- Git
- OpenAI API key or local Ollama setup

### 💿 Installation

You can install Astreus directly from npm:

```bash
npm install @astreus-ai/astreus
# or using yarn
# yarn add @astreus-ai/astreus
```

Or clone the repository for development:

```bash
git clone https://github.com/astreus-ai/astreus.git
cd astreus
npm install
# or using yarn
# yarn install
```

## ⚡ Quick Start

```typescript
import { 
  createAgent, 
  createProvider,
  createMemory,
  createDatabase,
  logger
} from '@astreus-ai/astreus';

(async () => {
  // Initialize the database
  const db = await createDatabase();
  
  // Create memory instance
  const memory = await createMemory({
    database: db,
    tableName: "memories",
    maxEntries: 100,
    enableEmbeddings: true
  });

  // Configure your provider
  const provider = createProvider({
    type: 'openai',
    model: 'gpt-4o-mini'  // Simply specify a single model name
  });

  // Create an agent instance
  const agent = await createAgent({
    name: 'MyAssistant',
    description: 'A helpful AI assistant',
    provider: provider,
    memory: memory,
    database: db,
    systemPrompt: "You are a helpful AI assistant."
  });

  // Chat with your agent
  const response = await agent.chat("Tell me about TypeScript");
  logger.info('Agent response:', response);
})();
```

## 🧰 Usage

### Creating Agents with Different Providers

You can use different LLM providers:

```typescript
// For OpenAI
const openaiProvider = createProvider({
  type: 'openai',
  model: 'gpt-4o-mini'
});

// For Ollama (local models)
const ollamaProvider = createProvider({
  type: 'ollama',
  baseUrl: "http://localhost:11434",
  model: "llama3"
});
```

### Adding Custom Plugins

Extend your agent with custom plugins:

```typescript
import { XPlugin } from 'astreus-x-plugin';

// Create and initialize plugin
const xPlugin = new XPlugin();
await xPlugin.init();

// Create an agent with the plugin
const agent = await createAgent({
  name: 'Social Media Agent',
  description: 'An assistant that can interact with X',
  provider: provider,
  memory: memory,
  database: db,
  systemPrompt: `You are a helpful assistant that can interact with X (formerly Twitter).
Help the user search, post, and analyze content on X.`,
  plugins: [xPlugin]  // Add plugins directly, tools will be automatically registered
});
```

### Working with RAG (Retrieval Augmented Generation)

Astreus provides built-in RAG capabilities:

```typescript
import { createRAG, parsePDF } from '@astreus-ai/astreus';

// Parse a PDF document
const document = await parsePDF('path/to/document.pdf');

// Create a RAG system
const rag = await createRAG({
  documents: [document],
  embeddings: provider.getEmbeddingModel(),
  database: db
});

// Use RAG with your agent
const agent = await createAgent({
  name: 'DocumentAssistant',
  description: 'An assistant that can answer questions about documents',
  provider: provider,
  memory: memory,
  database: db,
  rag: rag,
  systemPrompt: 'You are a helpful assistant that can answer questions about documents.'
});

// The agent will now be able to reference document content when answering questions
const response = await agent.chat("What does the document say about climate change?");
```

### Using the Task System

Creating and running tasks is straightforward:

```typescript
// Create a data processing task
const analysisTask = agent.createTask({
  name: "Analyze Data",
  description: "Analyze the provided data set and extract key insights",
  input: {
    dataSource: "sales_data_2024.csv",
    metrics: ["revenue", "growth", "customer_retention"]
  }
});

// Run the task
try {
  const taskResults = await agent.runTasks([analysisTask.id]);
  const analysisResult = taskResults.get(analysisTask.id);
  
  if (analysisResult?.success) {
    logger.success("Task completed successfully!");
    console.log(analysisResult.output);
  } else {
    logger.warn("Task failed");
    if (analysisResult?.output?.error) {
      logger.error(`Error: ${analysisResult.output.error}`);
    }
  }
} catch (error) {
  logger.error("Error running task:", error);
}
```

You can create complex workflows with task dependencies using the `dependsOn` property:

```typescript
// Create multiple tasks with dependencies
const researchTask = agent.createTask({
  name: "Research Tokyo Attractions",
  description: "Find top 5 tourist attractions in Tokyo",
  input: { city: "Tokyo" }
});

const plannerTask = agent.createTask({
  name: "Create Itinerary",
  description: "Create a 3-day itinerary based on research",
  dependsOn: [researchTask.id],  // This task depends on researchTask
  input: { duration: "3 days" }
});

// Run all tasks
const results = await agent.runTasks([researchTask.id, plannerTask.id]);

// Tasks run in proper order with dependency outputs automatically passed
// You can access outputs from each task
console.log("Research results:", results.get(researchTask.id).output);
console.log("Itinerary:", results.get(plannerTask.id).output);
```

When using `dependsOn`, the system automatically:
1. Executes tasks in the correct dependency order
2. Passes the outputs from dependency tasks to dependent tasks in `_dependencyOutputs`
3. Handles failed dependencies gracefully

## 🔧 Configuration

Environment variables:

- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_BASE_URL` - Optional custom base URL for OpenAI API
- `OPENAI_EMBEDDING_API_KEY` - Optional separate key for embeddings (falls back to main key)
- `DATABASE_TYPE` - Type of database to use (sqlite or postgresql)
- `DATABASE_PATH` - Path for SQLite database (if using SQLite)
- `DATABASE_URL` - Connection string for PostgreSQL (if using PostgreSQL)
- `OLLAMA_BASE_URL` - Base URL for Ollama API (if using Ollama)
- `LOG_LEVEL` - Logging level (default: "info")

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📬 Contact

Astreus Team - [https://astreus.org](https://astreus.org)

Project Link: [https://github.com/astreus-ai/astreus](https://github.com/astreus-ai/astreus) 