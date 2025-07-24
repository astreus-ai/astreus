import { IAgentModule, IAgent } from '../agent/types';
import { ToolDefinition } from '../plugin/types';
import OpenAI from 'openai';
import { Ollama } from 'ollama';
import { visionTools } from './tools';
import * as fs from 'fs';
import * as path from 'path';

export interface VisionConfig {
  provider: 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
  baseURL?: string;
}

export interface AnalysisOptions {
  prompt?: string;
  maxTokens?: number;
  detail?: 'low' | 'high';
}

export class Vision implements IAgentModule {
  readonly name = 'vision';
  private config: VisionConfig;
  private openai?: OpenAI;
  private ollama?: Ollama;

  constructor(private agent?: IAgent, config?: VisionConfig) {
    this.config = config || this.getConfigFromEnv();
    
    if (this.config.provider === 'openai') {
      this.openai = new OpenAI({
        apiKey: this.config.apiKey || process.env.OPENAI_VISION_API_KEY || process.env.OPENAI_API_KEY,
        baseURL: this.config.baseURL
      });
    } else {
      this.ollama = new Ollama({
        host: this.config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
      });
    }
  }

  async initialize(): Promise<void> {
    // Register vision tools if agent has plugin system
    if (this.agent && 'registerPlugin' in this.agent) {
      try {
        const visionPlugin = {
          name: 'vision-tools',
          version: '1.0.0',
          description: 'Built-in vision analysis tools',
          tools: visionTools
        };
        await (this.agent as IAgent & { registerPlugin: (plugin: { name: string; version: string; description?: string; tools?: ToolDefinition[] }) => Promise<void> }).registerPlugin(visionPlugin);
      } catch (error) {
        // Plugin registration failed, but vision module can still work
        console.warn('Failed to register vision tools:', error);
      }
    }
  }

  private getConfigFromEnv(): VisionConfig {
    const provider = process.env.VISION_PROVIDER as 'openai' | 'ollama' || 'openai';
    
    return {
      provider,
      model: process.env.VISION_MODEL || (provider === 'openai' ? 'gpt-4o' : 'llava'),
      apiKey: process.env.OPENAI_VISION_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: provider === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') : undefined
    };
  }

  async analyzeImage(imagePath: string, options: AnalysisOptions = {}): Promise<string> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    const ext = path.extname(imagePath).toLowerCase();
    
    if (!supportedFormats.includes(ext)) {
      throw new Error(`Unsupported image format: ${ext}. Supported formats: ${supportedFormats.join(', ')}`);
    }

    if (this.config.provider === 'openai') {
      return this.analyzeWithOpenAI(imagePath, options);
    } else {
      return this.analyzeWithOllama(imagePath, options);
    }
  }

  async analyzeImageFromBase64(base64Image: string, options: AnalysisOptions = {}): Promise<string> {
    if (this.config.provider === 'openai') {
      return this.analyzeWithOpenAIBase64(base64Image, options);
    } else {
      return this.analyzeWithOllamaBase64(base64Image, options);
    }
  }

  private async analyzeWithOpenAI(imagePath: string, options: AnalysisOptions): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });
    const mimeType = this.getMimeType(path.extname(imagePath));
    
    return this.analyzeWithOpenAIBase64(`data:${mimeType};base64,${imageBase64}`, options);
  }

  private async analyzeWithOpenAIBase64(base64Image: string, options: AnalysisOptions): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

    const response = await this.openai.chat.completions.create({
      model: this.config.model || 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: base64Image,
                detail: options.detail || 'auto'
              }
            }
          ]
        }
      ],
      max_tokens: options.maxTokens || 1000
    });

    return response.choices[0]?.message?.content || 'No analysis available';
  }

  private async analyzeWithOllama(imagePath: string, options: AnalysisOptions): Promise<string> {
    if (!this.ollama) {
      throw new Error('Ollama client not initialized');
    }

    const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });
    return this.analyzeWithOllamaBase64(imageBase64, options);
  }

  private async analyzeWithOllamaBase64(base64Image: string, options: AnalysisOptions): Promise<string> {
    if (!this.ollama) {
      throw new Error('Ollama client not initialized');
    }

    const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';

    const response = await this.ollama.generate({
      model: this.config.model || 'llava',
      prompt,
      images: [base64Image],
      options: {
        num_predict: options.maxTokens || 1000
      }
    });

    return response.response || 'No analysis available';
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    };
    
    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
  }
}

export { visionTools } from './tools';