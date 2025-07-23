![Astreus](assets/intro.webp)

Open-source AI agent framework for building autonomous systems that solve real-world tasks effectively.

## Installation

```bash
npm install @astreus-ai/astreus
```

## Basic Usage

```javascript
import { Agent } from '@astreus-ai/astreus';

const agent = await Agent.create({
  name: 'Assistant',
  model: 'gpt-4o',
  memory: true
});

const response = await agent.ask('How can you help me?');
```

## Core Features

- **Advanced Memory System**: Per-agent persistent memory with automatic context integration and vector search capabilities
- **Task Orchestration**: Structured task execution with status tracking, dependency management, and streaming support
- **Graph Workflows**: Complex workflow orchestration with conditional execution and parallel processing capabilities
- **Multi-Database Support**: Support for SQLite and PostgreSQL with automatic schema migrations and connection pooling
- **Plugin System**: Extensible tool integration with JSON schema validation and automatic LLM function calling
- **Vision Processing**: Built-in image analysis and document processing capabilities for multimodal interactions
- **Knowledge Base**: RAG integration with document chunking, vector embeddings, and similarity search
- **Multi-LLM Integration**: Unified interface for OpenAI, Claude, Gemini, and Ollama with automatic model routing

## 📖 Documentation

For detailed documentation and advanced features, visit:
- [Official Documentation](https://astreus.org/docs)
- [Guides](https://astreus.org/docs/examples)

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