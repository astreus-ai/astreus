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
- **Type Safety**: Fully typed with TypeScript and Zod schema validation
- **Advanced Logging**: Structured logging system for improved debugging and monitoring
- **Flexible Configuration**: Enhanced parameter validation and smart defaults

## 🚀 Getting Started

### 🛠 Prerequisites

- Node.js 16 or higher
- Git
- OpenAI API key or local Ollama setup

### 💿 Installation

Clone the repository and install dependencies:

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
  createDatabase
} from 'astreus';

(async () => {
  // Initialize the database
  const db = await createDatabase({
    type: 'sqlite',
    filename: 'astreus.db'
  });
  
  // Create memory instance
  const memory = await createMemory({
    database: db,
    tableName: "memories",
    maxEntries: 100
  });

  // Configure your provider
  const provider = createProvider({
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4-turbo"
  });

  // Create an agent instance
  const agent = await createAgent({
    name: 'MyAssistant',
    model: provider.getModel(provider.getDefaultModel()),
    memory: memory,
    systemPrompt: "You are a helpful AI assistant.",
    database: db
  });

  // Chat with your agent
  const response = await agent.chat("Tell me about TypeScript");
  console.log('Agent response:', response);
})();
```

## 🧰 Usage

### Creating Agents with Different Providers

You can use different LLM providers:

```typescript
// For OpenAI
const openaiProvider = createProvider({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4-turbo"
});

// For Ollama (local models)
const ollamaProvider = createProvider({
  type: 'ollama',
  baseUrl: "http://localhost:11434",
  model: "llama3"
});
```

### Adding Custom Tools

Extend your agent with custom tools:

```typescript
const weatherTool = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: {
    location: {
      type: "string",
      description: "The city and state, e.g. San Francisco, CA"
    }
  },
  execute: async (params) => {
    // Implement weather lookup logic
    return { temperature: 72, conditions: "sunny" };
  }
};

agent.addTool(weatherTool);
```

### Working with RAG (Retrieval Augmented Generation)

Astreus provides built-in RAG capabilities:

```typescript
import { createRAG, parsePDF } from 'astreus';

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
  model: provider.getModel('gpt-4-turbo'),
  memory: memory,
  rag: rag,
  systemPrompt: 'You are a helpful assistant that can answer questions about documents.'
});

// The agent will now be able to reference document content when answering questions
const response = await agent.chat("What does the document say about climate change?");
```

### Using Plugins

Plugins provide a convenient way to add multiple related tools to your agent at once:

```typescript
import { PluginManager } from 'astreus';

// Create a plugin manager
const pluginManager = new PluginManager();

// Register a custom plugin
pluginManager.registerPlugin({
  name: 'weather',
  description: 'Get weather information',
  tools: [weatherTool]
});

// Create the agent with the plugin manager
const agent = await createAgent({
  name: 'Weather Assistant',
  model: provider.getModel('gpt-4-turbo'),
  memory: memory,
  systemPrompt: 'You are a helpful assistant that can provide weather information.',
  pluginManager: pluginManager
});

// All tools from the plugins will be automatically available to the agent
```

### Using the Task System

```typescript
// Enable task system for complex requests
const response = await agent.chat(
  "Plan a trip to Japan and create an itinerary", 
  "session123",
  "user456", 
  { useTaskSystem: true }
);
```

Tasks allow your agent to break down complex requests into manageable steps:

```typescript
import { createTask } from 'astreus';

// Create a new task
const task = await createTask({
  name: "Research Tokyo attractions",
  description: "Find top 5 tourist attractions in Tokyo",
  agent: agent,
  input: { city: "Tokyo" }
});

// Execute the task
const result = await task.execute();

// The task results will be stored in memory and can be accessed in future interactions
```

## 🔧 Configuration

Environment variables:

- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_EMBEDDING_MODEL` - Optional embedding model name (default: "text-embedding-3-small")
- `DATABASE_URL` - Connection string for PostgreSQL (if using PG)
- `SQLITE_PATH` - Path for SQLite database (if using SQLite)
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