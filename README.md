![Astreus](src/assets/astreus-logo-bg-wide.webp)

<h1 align="center">Astreus</h1>

Open-source AI agent framework for creating, deploying and managing intelligent conversational AI agents.

## 🌟 Key Features

- **Multi-Provider Support**: OpenAI, Claude, Gemini, and Ollama
- **Advanced Memory System**: Hierarchical memory with vector search and adaptive context management
- **Personality System**: Create and manage distinct AI personalities
- **Task Orchestration**: Break complex requests into manageable tasks with dependencies
- **Plugin System**: Extend capabilities with custom tools
- **RAG Support**: Vector and document-based retrieval
- **Chat Management**: Advanced chat system with metadata and search
- **Media Analysis**: AI-powered image and document analysis
- **Type Safety**: Fully typed with TypeScript

## 🚀 Quick Start

### Installation

```bash
npm install @astreus-ai/astreus
```

### Basic Usage

```typescript
import { 
  createAgent, 
  createProvider,
  createMemory,
  createDatabase,
  logger
} from '@astreus-ai/astreus';

// Initialize components
const db = await createDatabase();
const memory = await createMemory({ database: db });
const provider = createProvider({
  type: 'openai',
  model: 'gpt-4o-mini'
});

// Create an agent
const agent = await createAgent({
  name: 'MyAssistant',
  provider: provider,
  memory: memory,
  database: db,
  systemPrompt: "You are a helpful AI assistant."
});

// Chat with your agent
const response = await agent.chat({
  message: "Tell me about TypeScript",
  sessionId: "user-123"
});

logger.info("Agent", "Response", response);
```

### 🎭 Using Personalities

Create agents with distinct personalities:

```typescript
import { createPersonalityManager } from '@astreus-ai/astreus';

// Create personality manager
const personalityManager = await createPersonalityManager(db);

// Use built-in personalities
const creativeWriter = await personalityManager.getByName('creative-writer');
const technicalExpert = await personalityManager.getByName('technical-expert');

// Create custom personality
const customPersonality = await personalityManager.create({
  name: 'friendly-teacher',
  description: 'A patient and encouraging teacher',
  prompt: 'You are a friendly, patient teacher who loves helping students learn.'
});

// Create agent with personality
const agent = await createAgent({
  name: 'TeacherBot',
  provider: provider,
  memory: memory,
  personality: customPersonality  // Personality automatically integrated!
});
```

### 🔌 Using Plugins

Extend your agent with plugins:

```typescript
import { XPlugin } from 'astreus-x-plugin';

const xPlugin = new XPlugin();
await xPlugin.init();

const agent = await createAgent({
  name: 'SocialAgent',
  provider: provider,
  memory: memory,
  plugins: [xPlugin]  // Tools automatically registered
});
```

### ⚡ Task System

Create complex workflows with tasks:

```typescript
// Create tasks with dependencies
const researchTask = await agent.createTask({
  name: "Research Topic",
  description: "Research information about quantum computing"
});

const summaryTask = await agent.createTask({
  name: "Create Summary",
  description: "Summarize the research findings",
  dependsOn: [researchTask.id]  // Runs after research
});

// Execute tasks
const results = await agent.executeTask(summaryTask.id);
```

### 📚 RAG (Retrieval Augmented Generation)

Add document knowledge to your agent:

```typescript
import { createRAG, parsePDF, RAGType } from '@astreus-ai/astreus';

// Parse and add documents
const document = await parsePDF('path/to/document.pdf');

const rag = await createRAG({
  type: RAGType.VECTOR,
  database: db,
  provider: provider
});

await rag.addDocument({
  content: document.content,
  metadata: { filename: 'document.pdf' }
});

// Create agent with RAG
const agent = await createAgent({
  name: 'DocumentExpert',
  provider: provider,
  memory: memory,
  rag: rag  // Agent can now answer questions about documents
});
```

## 🔧 Configuration

### Environment Variables

```bash
# Global Model Configuration (applies to all providers)
MODEL_NAME=gpt-4o-mini           # Main model name
TEMPERATURE=0.7                  # Model temperature (0.0 - 1.0)
MAX_TOKENS=2048                 # Maximum tokens per response
EMBEDDING_MODEL=text-embedding-3-small  # Embedding model for RAG

# Provider API Keys
OPENAI_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
GOOGLE_API_KEY=your-key

# Database (optional)
DATABASE_TYPE=sqlite  # or postgresql
DATABASE_URL=postgresql://user:pass@localhost:5432/db

# Logging
LOG_LEVEL=info  # debug, info, warn, error
```

## 📖 Documentation

For detailed documentation and advanced features, visit:
- [Official Documentation](https://astreus.org/docs)
- [Plugins](https://astreus.org/docs/plugins)
- [Guides](https://astreus.org/docs/guides)

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