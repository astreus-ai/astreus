![Astreus](assets/intro.webp)

Open-source AI agent framework for building autonomous systems that solve real-world tasks effectively.

[![npm version](https://badge.fury.io/js/@astreus-ai%2Fastreus.svg)](https://badge.fury.io/js/@astreus-ai%2Fastreus)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

- **Sub-Agents**: Intelligent task delegation with specialized agent coordination, hierarchical workflows, and LLM-powered assignment
- **Advanced Memory System**: Per-agent persistent memory with automatic context integration and vector search capabilities
- **Task Orchestration**: Structured task execution with status tracking, dependency management, and streaming support
- **Graph Workflows**: Complex workflow orchestration with conditional execution, parallel processing, and sub-agent integration
- **MCP Integration**: Model Context Protocol support for seamless external tool and service connections
- **Plugin System**: Extensible tool integration with JSON schema validation and automatic LLM function calling
- **Vision Processing**: Built-in image analysis and document processing capabilities for multimodal interactions
- **Knowledge Base**: RAG integration with document chunking, vector embeddings, and similarity search
- **Multi-LLM Integration**: Unified interface for OpenAI, Claude, Gemini, and Ollama with automatic model routing

## 📖 Documentation

For detailed documentation and advanced features, visit:
- [Official Documentation](https://astreus.org/docs)
- [Examples](https://astreus.org/docs/examples)

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