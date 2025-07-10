![Astreus](src/assets/astreus-logo-bg-wide.webp)

<h1 align="center">Astreus</h1>

An AI Agent Framework designed to help you easily build, deploy, and manage intelligent conversational agents powered by large language models (LLMs) with advanced memory management, task orchestration, and plugin system.

## 🌟 Features

- **Unified Agent API**: Create and manage AI agents with a consistent interface 
- **Multi-Provider Client**: Works with OpenAI, Ollama, Claude (Anthropic), and Gemini (Google) models out of the box
- **Memory Storage**: Built-in conversation history with hierarchical memory layers and vector search capabilities
- **Chat Service**: Advanced chat system with metadata, search, and organization
- **Task Execution**: Break complex requests into manageable sub-tasks with dependency management and intelligent orchestration
- **Plugin System**: Extend agent capabilities with custom tools and integrations
- **Persistence Layer**: Automatic storage using SQLite or PostgreSQL
- **Advanced RAG Support**: Vector-based and document-based retrieval with external vector database support
- **PDF Processing**: Built-in PDF parsing and document processing capabilities
- **Media Analysis**: AI-powered image, document, and file analysis capabilities with context processing
- **Intent Recognition**: Intelligent tool selection using LLM-powered intent detection and context processing
- **Embeddings Support**: Semantic search across conversations and documents
- **Vector Database Integration**: Support for PostgreSQL with pgvector, Qdrant, Pinecone, and more
- **Enhanced Database Management**: Flexible table naming, automatic schema creation, and migration support with advanced memory storage
- **Structured Responses**: Built-in support for structured completion responses
- **Type Safety**: Fully typed with TypeScript for better development experience
- **Professional Logging**: Structured logging system with color-coded output and consistent formatting
- **Flexible Configuration**: Enhanced parameter validation, smart defaults, and environment-based setup
- **Plugin Registry**: Advanced plugin management with automatic tool registration and centralized registry
- **Adaptive Context Management**: Hierarchical memory layers with intelligent token budgeting and compression
- **Context Processor**: Advanced context window management with priority-based retention and automatic compression

## 🏗️ Architecture

Astreus follows a modern, semantic architecture with clearly defined components:

- **Memory Storage**: Hierarchical memory system with immediate, summarized, and persistent layers
- **Chat Service**: Dedicated chat session management with metadata and search capabilities  
- **Task Executor**: Intelligent task orchestration with dependency management
- **Plugin Registry**: Centralized plugin management with automatic tool registration
- **Provider Client**: Unified interface for multiple AI model providers
- **Context Processor**: Adaptive context window management with token budgeting

Each component is designed with semantic naming to clearly indicate its purpose and responsibility within the framework.

## 🚀 Getting Started

### 🛠 Prerequisites

- Node.js 16 or higher
- TypeScript (optional, but recommended for development)
- AI Provider API keys: OpenAI, Anthropic (Claude), Google (Gemini), or local Ollama setup
- PostgreSQL (optional, for advanced vector database features)

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
  logger.info("Agent", "Response", response);
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

// For Claude (Anthropic)
const claudeProvider = createProvider({
  type: 'claude',
  model: 'claude-3-5-sonnet-20241022'
});

// For Gemini (Google)
const geminiProvider = createProvider({
  type: 'gemini',
  model: 'gemini-1.5-pro'
});

// For Ollama (local models)
const ollamaProvider = createProvider({
  type: 'ollama',
  baseUrl: "http://localhost:11434",
  model: "llama3.1"
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

Astreus provides built-in RAG capabilities with support for both vector-based and document-based retrieval:

```typescript
import { createRAG, parsePDF, RAGType } from '@astreus-ai/astreus';

// Parse a PDF document
const document = await parsePDF('path/to/document.pdf');

// Create a vector-based RAG system (recommended for semantic search)
const vectorRAG = await createRAG({
  type: RAGType.VECTOR,
  database: db,
  provider: provider,
  tableName: 'knowledge_base',
  chunkSize: 1000,
  chunkOverlap: 200,
  maxResults: 10
});

// Add documents to the RAG system
await vectorRAG.addDocument({
  content: document.content,
  metadata: {
    filename: 'climate_report.pdf',
    type: 'research_paper'
  }
});

// Use RAG with your agent
const agent = await createAgent({
  name: 'DocumentAssistant',
  description: 'An assistant that can answer questions about documents',
  provider: provider,
  memory: memory,
  database: db,
  rag: vectorRAG,
  systemPrompt: 'You are a helpful assistant that can answer questions about documents.'
});

// The agent will now be able to reference document content when answering questions
const response = await agent.chat("What does the document say about climate change?");
```

### Chat Management System

Astreus includes a powerful chat management system that works seamlessly with the existing memory system:

```typescript
import { createChat } from '@astreus-ai/astreus';

// Create a chat management instance
const chat = await createChat({
  database: db,
  memory: memory,
  tableName: 'chats',
  maxChats: 100,
  autoGenerateTitles: true
});

// Create a new chat
const newChat = await chat.createChat({
  agentId: 'my-agent',
  userId: 'user123',
  title: 'AI Assistant Discussion'
});

// Add messages to the chat
await chat.addMessage({
  chatId: newChat.id,
  agentId: 'my-agent',
  userId: 'user123',
  role: 'user',
  content: 'How can I improve my coding skills?'
});

// Get chat messages (integrates with memory system)
const messages = await chat.getMessages(newChat.id);

// List user's chats
const userChats = await chat.listChats({
  userId: 'user123',
  status: 'active'
});

// Search through chats
const searchResults = await chat.searchChats({
  query: 'coding',
  userId: 'user123'
});

// Get chat statistics
const stats = await chat.getChatStats({
  userId: 'user123'
});

// Archive or delete chats
await chat.archiveChat(newChat.id);
await chat.deleteChat(newChat.id);
```

The chat system provides:
- **Metadata Management**: Store chat titles, status, and custom metadata
- **Auto-generated Titles**: Automatically create titles from first user message
- **Search Capabilities**: Search through chat titles and content
- **Status Management**: Active, archived, and deleted chat states
- **Statistics**: Get insights about chat usage
- **Memory Integration**: Chat IDs are compatible with session IDs in memory

### Adaptive Context Management

Astreus includes an advanced adaptive context management system that intelligently manages conversation context across multiple hierarchical layers. The system automatically optimizes context retention based on importance, recency, and token budgets.

#### Automatic Context Management (Recommended)

The easiest way to use adaptive context is through the memory system:

```typescript
import { createMemory, createAgent } from '@astreus-ai/astreus';

// Enable adaptive context management
const memory = await createMemory({
  database: db,
  tableName: "memories",
  enableAdaptiveContext: true,  // Enable adaptive context
  maxEntries: 100,
  // Optional: Custom token budget
  tokenBudget: {
    total: 4000,
    immediate: 1600,    // 40% - recent messages
    summarized: 1400,   // 35% - conversation summaries
    persistent: 1000    // 25% - important facts
  }
});

// Create agent with adaptive context
const agent = await createAgent({
  name: 'SmartAgent',
  provider: provider,
  memory: memory,  // Context management is automatic
  database: db,
  systemPrompt: 'You are an intelligent assistant with advanced memory.'
});

// Context is automatically managed during conversations
const response = await agent.chat("Remember that I prefer concise answers");
const response2 = await agent.chat("What did I just tell you about my preferences?");
// The agent will remember preferences even in long conversations
```

#### Manual Context Control

For advanced use cases, you can manually control the adaptive context:

```typescript
import { AdaptiveContextManager, DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS, CompressionStrategy } from '@astreus-ai/astreus';

// Get adaptive context for a session
const contextLayers = await memory.getAdaptiveContext("session-1", 4000);
console.log("Current context layers:", contextLayers);

// Update context with new information
await memory.updateContextLayers("session-1", {
  role: "user",
  content: "Important: I'm a software engineer",
  timestamp: new Date()
});

// Compress context when needed
const compressionResult = await memory.compressContext("session-1", CompressionStrategy.SUMMARIZE);
console.log("Compression result:", compressionResult);

// Get formatted context for display
const formattedContext = await memory.getFormattedContext("session-1", 4000);
console.log("Formatted context:", formattedContext);
```

#### Custom Configuration

You can customize the adaptive context behavior:

```typescript
import { createMemory } from '@astreus-ai/astreus';

const memory = await createMemory({
  database: db,
  enableAdaptiveContext: true,
  // Custom token budget allocation
  tokenBudget: {
    total: 6000,
    immediate: 3000,    // 50% for recent messages
    summarized: 2000,   // 33% for summaries
    persistent: 1000    // 17% for persistent data
  },
  // Custom priority weights
  priorityWeights: {
    recency: 0.4,       // Prioritize recent messages
    frequency: 0.1,     // Less weight to frequency
    importance: 0.4,    // High importance weight
    userInteraction: 0.1,
    sentiment: 0.0      // Ignore sentiment
  }
});
```

#### Through Chat Service

The chat service provides convenient access to adaptive context:

```typescript
import { createChat } from '@astreus-ai/astreus';

const chat = await createChat({
  database: db,
  memory: memory,
  tableName: 'chats',
  enableAdaptiveContext: true  // Enable for chat sessions
});

// Get adaptive context for a chat
const adaptiveContext = await chat.getAdaptiveContext("chat-1");

// Get formatted context for display
const formattedContext = await chat.getFormattedContext("chat-1", 4000);
```

The adaptive context system provides:
- **Hierarchical Memory**: Three-layer architecture (immediate, summarized, persistent)
- **Token Budgeting**: Intelligent allocation of context window space
- **Priority-Based Retention**: Important content stays longer based on multiple factors
- **Automatic Compression**: Context is compressed when token limits are reached
- **Compression Strategies**: SUMMARIZE, KEYWORD_EXTRACT, SEMANTIC_CLUSTER, TEMPORAL_COMPRESS
- **Session Isolation**: Each session has its own context manager
- **Seamless Integration**: Works transparently with all other components
- **Cleanup Management**: Automatic cleanup of inactive context managers

### Using the Task System

Creating and running tasks is straightforward with the new task executor:

```typescript
import { createTaskManager } from '@astreus-ai/astreus';

// Create a task executor (TaskManager is an alias for backward compatibility)
const taskExecutor = createTaskManager();

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
    logger.success("System", "Task", "Task completed successfully!");
    console.log(analysisResult.output);
  } else {
    logger.warn("System", "Task", "Task failed");
    if (analysisResult?.output?.error) {
      logger.error("System", "Task", `Error: ${analysisResult.output.error}`);
    }
  }
} catch (error) {
  logger.error("System", "Task", `Error running task: ${error}`);
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

### Advanced Logging System

Astreus includes a professional logging system with structured output:

```typescript
import { logger } from '@astreus-ai/astreus';

// Professional logging with consistent format: "Astreus [AgentName] Component → Message"
logger.info("MyAgent", "Database", "Connected to database successfully");
logger.debug("MyAgent", "Memory", "Storing conversation context");
logger.success("MyAgent", "Task", "Task completed successfully");
logger.warn("MyAgent", "Provider", "Rate limit approaching");
logger.error("MyAgent", "Plugin", "Plugin initialization failed");
```

The logging system features:
- **Color-coded output**: Different colors for different log levels
- **Consistent format**: Structured agent/component/message format
- **Professional appearance**: Clean, readable logs without emojis
- **Configurable levels**: Set LOG_LEVEL environment variable

### Plugin Management

Astreus includes an advanced plugin system with automatic tool registration and centralized registry:

```typescript
import { PluginRegistry } from '@astreus-ai/astreus';

// Create plugin registry
const pluginRegistry = new PluginRegistry();

// Load plugins
await pluginRegistry.loadPlugin(myCustomPlugin);

// Create agent with plugin registry
const agent = await createAgent({
  name: 'PluginAgent',
  provider: provider,
  memory: memory,
  database: db,
  pluginRegistry: pluginRegistry,
  systemPrompt: 'You are an assistant with extended capabilities.'
});

// Plugins are automatically registered and available to the agent
```

### Media Analysis

Astreus includes powerful media analysis capabilities powered by AI:

```typescript
import { analyzeMedia, analyzeImage, analyzeDocument } from '@astreus-ai/astreus';

// Analyze images with custom prompts
const imageAnalysis = await agent.analyzeImage({
  imagePath: './screenshot.png',
  prompt: 'What UI elements are visible in this screenshot?',
  detail: 'high'
});

// Analyze documents (PDF, Word, etc.)
const documentAnalysis = await agent.analyzeDocument({
  filePath: './contract.pdf',
  prompt: 'Extract key terms and conditions from this contract'
});

// General media analysis with context
const mediaAnalysis = await agent.analyzeMedia({
  filePath: './presentation.pptx',
  analysisType: 'detailed',
  prompt: 'Summarize the main points of this presentation'
});
```

### Intent Recognition & Smart Tool Selection

Astreus can automatically select the right tools for tasks using LLM-powered intent recognition:

```typescript
// The agent will automatically determine which tools to use based on the task
const task = agent.createTask({
  name: "Send Email Report",
  description: "Generate a sales report and send it via email to the team",
  input: { period: "Q1 2024" }
});

// Intent recognition will automatically select email and reporting tools
const result = await agent.runTasks([task.id]);
```

### Enhanced Database Features

Astreus provides flexible database management with custom table naming:

```typescript
// Create memory with custom table name
const memory = await createMemory({
  database: db,
  tableName: "custom_memories",  // Use your own table name
  maxEntries: 1000,
  enableEmbeddings: true
});

// Create chat manager with custom table
const chat = await createChat({
  database: db,
  memory: memory,
  tableName: "custom_chats",     // Use your own table name
  maxChats: 100,
  autoGenerateTitles: true
});
```

## 🔧 Configuration

### Environment Variables

- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_BASE_URL` - Optional custom base URL for OpenAI API
- `OPENAI_EMBEDDING_API_KEY` - Optional separate key for embeddings (falls back to main key)
- `OPENAI_EMBEDDING_MODEL` - Embedding model to use (default: "text-embedding-3-small")
- `ANTHROPIC_API_KEY` - Your Anthropic API key (for Claude)
- `ANTHROPIC_BASE_URL` - Optional custom base URL for Anthropic API
- `GOOGLE_API_KEY` - Your Google API key (for Gemini)
- `GOOGLE_BASE_URL` - Optional custom base URL for Google API
- `DATABASE_TYPE` - Type of database to use (sqlite or postgresql)
- `DATABASE_PATH` - Path for SQLite database (if using SQLite)
- `DATABASE_URL` - Connection string for PostgreSQL (if using PostgreSQL)
- `OLLAMA_BASE_URL` - Base URL for Ollama API (if using Ollama, default: "http://localhost:11434")
- `LOG_LEVEL` - Logging level (default: "info")

### Database Configuration

Astreus supports both SQLite and PostgreSQL databases:

```typescript
// SQLite (default)
const db = await createDatabase({
  type: 'sqlite',
  path: './astreus.db'
});

// PostgreSQL
const db = await createDatabase({
  type: 'postgresql',
  connectionString: 'postgresql://user:password@localhost:5432/astreus'
});
```

### Vector Database Support

For advanced RAG capabilities, Astreus supports external vector databases:

```typescript
import { VectorDatabaseType } from '@astreus-ai/astreus';

const vectorRAG = await createRAG({
  type: RAGType.VECTOR,
  database: db,
  provider: provider,
  vectorDatabase: {
    type: VectorDatabaseType.POSTGRES,
    connectionString: 'postgresql://user:password@localhost:5432/vector_db'
  }
});
```

### Additional Exports

Astreus also exports utility functions and types for advanced usage:

```typescript
import { 
  // Core functions
  createAgent, createProvider, createMemory, createDatabase, createRAG, createChat,
  
  // Task system
  createTaskManager, createTask, createTaskSync, TaskExecutor, Task,
  
  // RAG utilities
  parsePDF, parseDirectoryOfPDFs, createVectorDatabaseConnector, loadVectorDatabaseConfigFromEnv,
  
  // Plugin system
  PluginRegistry,
  
  // Media analysis and context processing
  analyzeMedia, analyzeImage, analyzeDocument, analyzeWithContext,
  
  // Context management
  AdaptiveContextManager, DEFAULT_TOKEN_BUDGET, DEFAULT_PRIORITY_WEIGHTS,
  
  // Intent recognition
  IntentRecognizer,
  
  // Utilities
  logger, validateRequiredParam, validateRequiredParams,
  
  // Types and constants
  RAGType, VectorDatabaseType
} from '@astreus-ai/astreus';
```

**Note**: Each component (createMemory, createChat, createAgent, etc.) automatically creates its required database tables when first used.

## 🔧 Troubleshooting

### Common Issues

**"Model not found" error**
```bash
Error: Model 'gpt-4o-mini' not found in provider
```
- Ensure the model name is correct
- Check that your API key has access to the specified model
- Verify the provider type matches the model

**Database connection issues**
```bash
Error: connect ECONNREFUSED
```
- For PostgreSQL: Ensure the database server is running and accessible
- Check connection string format and credentials
- For SQLite: Ensure the directory exists and has write permissions

**Embedding generation fails**
```bash
Error generating embedding: 401 Unauthorized
```
- Check `OPENAI_API_KEY` or `OPENAI_EMBEDDING_API_KEY` environment variables
- Verify API key has access to embedding models
- Ensure embedding model name is correct

**Plugin loading errors**
```bash
Plugin initialization failed
```
- Check plugin compatibility with current Astreus version
- Ensure plugin dependencies are installed
- Verify plugin configuration is correct

### Debug Mode

Enable debug logging to get more detailed information:

```bash
LOG_LEVEL=debug node your-app.js
```

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