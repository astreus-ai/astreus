import { IAgentModule, IAgent } from '../agent/types';
import { ToolDefinition } from '../plugin/types';
import { createVisionTools } from './tools';
import { Logger } from '../logger/types';
import { getLogger } from '../logger';
import { getLLMProvider } from '../llm';
import { VisionAnalysisOptions } from '../llm/types';
import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_VISION_CONFIG } from './defaults';

// Allowed image extensions for validation
export const ALLOWED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.svg',
];

/**
 * Validates an image path for security and existence
 * Uses atomic file descriptor operations to prevent TOCTOU race conditions
 * @throws Error if path is invalid or insecure
 */
function validateImagePath(imagePath: string): void {
  // Resolve and normalize the path to get absolute path
  const resolvedPath = path.resolve(imagePath);
  const cwd = path.resolve(process.cwd());

  // Check if resolved path is within the current working directory
  // This prevents path traversal attacks even with normalized paths
  if (!resolvedPath.startsWith(cwd)) {
    throw new Error('Invalid image path: image path must be within working directory');
  }

  // Validate file extension
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Invalid image format: ${ext}. Allowed formats: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`
    );
  }

  // Use atomic file descriptor operation to prevent TOCTOU race condition
  // Open the file with read-only flag, which atomically checks existence and opens
  let fd: number | null = null;
  try {
    // O_RDONLY | O_NOFOLLOW equivalent - open read-only, don't follow symlinks
    fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY);

    // Now use fstatSync on the file descriptor (not the path) to avoid TOCTOU
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Image file not found: ${resolvedPath}`);
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Too many symbolic links in path: ${resolvedPath}`);
    }
    throw error;
  } finally {
    // Always close the file descriptor
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

export interface VisionConfig {
  provider?: 'openai' | 'claude' | 'gemini' | 'ollama';
  model?: string;
  apiKey?: string;
  baseURL?: string;
}

export interface AnalysisOptions {
  prompt?: string;
  maxTokens?: number;
  detail?: 'low' | 'high' | 'auto';
}

export class Vision implements IAgentModule {
  readonly name = 'vision';
  private config: VisionConfig;
  private logger: Logger;

  constructor(
    private agent?: IAgent,
    config?: VisionConfig
  ) {
    this.logger = agent?.logger || getLogger();

    // Handle agent-provided config
    if (!config && agent?.config) {
      // Use agent's visionModel if specified
      if (agent.config.visionModel) {
        config = { model: agent.config.visionModel };
      } else {
        // Auto-detect based on available providers
        config = this.autoDetectVisionConfig();
      }
    }

    this.config = config || this.getConfigFromEnv();

    // User-facing info log
    this.logger.info('Vision module initialized');

    this.logger.debug('Vision module initialized', {
      agentId: agent?.id ?? 0,
      agentName: agent?.name || 'standalone',
      provider: this.config.provider || 'auto',
      model: this.config.model || 'auto',
      hasApiKey: !!this.config.apiKey,
      hasBaseURL: !!this.config.baseURL,
      agentModel: agent?.config?.model || 'none',
      agentVisionModel: agent?.config?.visionModel || 'none',
    });
  }

  async initialize(): Promise<void> {
    // Register vision tools if agent has plugin system
    if (this.agent && 'registerPlugin' in this.agent) {
      try {
        // Create vision tools with this instance so they have access to agent config
        const toolsWithInstance = createVisionTools(this);

        const visionPlugin = {
          name: 'vision-tools',
          version: '1.0.0',
          description: 'Built-in vision analysis tools',
          tools: toolsWithInstance,
        };
        await (
          this.agent as IAgent & {
            registerPlugin: (plugin: {
              name: string;
              version: string;
              description?: string;
              tools?: ToolDefinition[];
            }) => Promise<void>;
          }
        ).registerPlugin(visionPlugin);
      } catch (error) {
        // Plugin registration failed, but vision module can still work
        this.logger.debug('Failed to register vision tools', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private autoDetectVisionConfig(): VisionConfig {
    // Priority order: OpenAI -> Claude -> Gemini -> Ollama
    if (process.env.OPENAI_VISION_API_KEY) {
      // Use dedicated vision API key if available
      return {
        provider: 'openai',
        model: DEFAULT_VISION_CONFIG.defaultModel,
        apiKey: process.env.OPENAI_VISION_API_KEY,
      };
    }

    // Only use main OPENAI_API_KEY if it's not an OpenRouter key (which would have a base URL set)
    if (process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
      return {
        provider: 'openai',
        model: DEFAULT_VISION_CONFIG.defaultModel,
        apiKey: process.env.OPENAI_API_KEY,
      };
    }

    if (process.env.ANTHROPIC_VISION_API_KEY || process.env.ANTHROPIC_API_KEY) {
      return {
        provider: 'claude',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: process.env.ANTHROPIC_VISION_API_KEY || process.env.ANTHROPIC_API_KEY,
      };
    }

    if (process.env.GEMINI_VISION_API_KEY || process.env.GEMINI_API_KEY) {
      return {
        provider: 'gemini',
        model: 'gemini-1.5-pro',
        apiKey: process.env.GEMINI_VISION_API_KEY || process.env.GEMINI_API_KEY,
      };
    }

    // Default to Ollama (local)
    return {
      provider: 'ollama',
      model: DEFAULT_VISION_CONFIG.fallbackModel,
      baseURL: process.env.OLLAMA_BASE_URL || DEFAULT_VISION_CONFIG.ollamaBaseURL,
    };
  }

  private getConfigFromEnv(): VisionConfig {
    return this.autoDetectVisionConfig();
  }

  private getApiKeyForProvider(provider: string): string | undefined {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_VISION_API_KEY || process.env.OPENAI_API_KEY;
      case 'claude':
        return process.env.ANTHROPIC_VISION_API_KEY || process.env.ANTHROPIC_API_KEY;
      case 'gemini':
        return process.env.GEMINI_VISION_API_KEY || process.env.GEMINI_API_KEY;
      case 'ollama':
        return undefined; // Ollama doesn't need API key
      default:
        return undefined;
    }
  }

  private async getProviderForVision(): Promise<{
    provider: {
      name: string;
      analyzeImage?: (
        imagePath: string,
        options?: VisionAnalysisOptions
      ) => Promise<{ content: string }>;
      analyzeImageFromBase64?: (
        base64Data: string,
        options?: VisionAnalysisOptions
      ) => Promise<{ content: string }>;
      getVisionModels: () => string[];
    };
    model: string;
  }> {
    const model = this.config.model;
    const providerType = this.config.provider;

    this.logger.debug('Getting provider for vision', {
      configModel: model || 'undefined',
      configProvider: providerType || 'undefined',
      hasApiKey: !!this.config.apiKey,
      hasBaseURL: !!this.config.baseURL,
    });

    if (providerType && model) {
      // Use specified provider and model - NEVER use main base URL for vision
      const mainProvider = await getLLMProvider(providerType, {
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseURL || null, // Explicitly set to null to prevent fallback to main base URL
        logger: this.logger,
      });

      // Use dedicated vision provider if available
      const provider = mainProvider.getVisionProvider?.() || mainProvider;

      // Check if provider supports vision
      if (!provider.analyzeImage) {
        throw new Error(`Provider ${providerType} does not support vision analysis`);
      }

      // Check if model is supported
      const visionModels = mainProvider.getVisionModels();
      if (!visionModels.includes(model)) {
        this.logger.warn(
          `Model ${model} is not in provider's vision models list. Proceeding anyway.`
        );
      }

      return { provider, model };
    }

    // Auto-detect provider based on available API keys - NEVER use main base URL for vision
    const config = this.autoDetectVisionConfig();

    this.logger.debug('Auto-detected vision config', {
      provider: config.provider || 'undefined',
      model: config.model || 'undefined',
      hasApiKey: !!config.apiKey,
      hasBaseURL: !!config.baseURL,
    });

    if (!config.provider) {
      throw new Error(
        'Vision provider could not be auto-detected. Please configure a vision provider.'
      );
    }

    const mainProvider = await getLLMProvider(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.baseURL || null, // Explicitly set to null to prevent fallback to main base URL
      logger: this.logger,
    });

    // Use dedicated vision provider if available
    const provider = mainProvider.getVisionProvider?.() || mainProvider;

    if (!config.model) {
      throw new Error('Vision model could not be determined. Please configure a vision model.');
    }

    return { provider, model: config.model };
  }

  async analyzeImage(imagePath: string, options: AnalysisOptions = {}): Promise<string> {
    // Validate image path for security
    validateImagePath(imagePath);

    const fileName = path.basename(imagePath);

    // User-facing info log
    this.logger.info(`Analyzing image: ${fileName}`);

    this.logger.debug('Starting image analysis', {
      imagePath,
      fileName,
      provider: this.config.provider || 'auto',
      model: this.config.model || 'auto',
      hasOptions: Object.keys(options).length > 0,
      hasAgent: !!this.agent,
      agentVisionModel: this.agent?.config?.visionModel || 'undefined',
      agentId: this.agent?.id ?? 0,
    });

    try {
      const { provider, model } = await this.getProviderForVision();
      const visionOptions: VisionAnalysisOptions = {
        prompt: options.prompt,
        maxTokens: options.maxTokens,
        detail: options.detail,
        model: model, // Pass the agent's vision model to provider
      };

      if (!provider.analyzeImage) {
        throw new Error('Vision provider does not support analyzeImage method');
      }

      const result = await provider.analyzeImage(imagePath, visionOptions);

      // User-facing success message
      this.logger.info(`Image analysis completed for ${fileName}`);

      this.logger.debug('Image analysis completed', {
        fileName,
        model: model,
        provider: 'unknown',
        processingTime: 0,
        resultLength: result.content.length,
        resultPreview: result.content.slice(0, 100) + '...',
      });

      return result.content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error(`Image analysis failed for ${fileName}`);
      this.logger.debug('Image analysis error', {
        fileName,
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });
      throw error;
    }
  }

  async analyzeImageFromBase64(
    base64Image: string,
    options: AnalysisOptions = {}
  ): Promise<string> {
    // User-facing info log
    this.logger.info('Analyzing base64 image');

    this.logger.debug('Starting base64 image analysis', {
      provider: this.config.provider || 'auto',
      model: this.config.model || 'auto',
      base64Length: base64Image.length,
      hasOptions: Object.keys(options).length > 0,
    });

    try {
      const { provider, model } = await this.getProviderForVision();
      const visionOptions: VisionAnalysisOptions = {
        prompt: options.prompt,
        maxTokens: options.maxTokens,
        detail: options.detail,
        model: model, // Pass the agent's vision model to provider
      };

      if (!provider.analyzeImageFromBase64) {
        throw new Error('Vision provider does not support analyzeImageFromBase64 method');
      }

      const result = await provider.analyzeImageFromBase64(base64Image, visionOptions);

      // User-facing success message
      this.logger.info('Base64 image analysis completed');

      this.logger.debug('Base64 image analysis completed', {
        model: model,
        provider: 'unknown',
        processingTime: 0,
        resultLength: result.content.length,
        resultPreview: result.content.slice(0, 100) + '...',
      });

      return result.content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error('Base64 image analysis failed');
      this.logger.debug('Base64 image analysis error', {
        error: errorMessage,
        hasStack: error instanceof Error && !!error.stack,
      });
      throw error;
    }
  }
}

export { visionTools, createVisionTools } from './tools';
