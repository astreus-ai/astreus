import {
  ProviderConfig,
  ProviderInstance,
  ProviderModel,
  ProviderType,
  ProviderModelConfig,
  OpenAIModelConfig,
  OllamaModelConfig,
  ProviderFactory,
} from "./types/provider";
import dotenv from "dotenv";
import { OpenAIProvider, OllamaProvider, Embedding } from "./providers";
import { validateRequiredParam, validateRequiredParams } from "./utils/validation";
import { logger } from "./utils/logger";

// Load environment variables
dotenv.config();

// Define types for default configurations
type OpenAIDefaultConfigs = {
  [key: string]: Omit<OpenAIModelConfig, 'name'>;
};

type OllamaDefaultConfigs = {
  [key: string]: Omit<OllamaModelConfig, 'name'>;
};

type DefaultModelConfigs = {
  openai: OpenAIDefaultConfigs;
  ollama: OllamaDefaultConfigs;
};

// Default model configurations
const DEFAULT_MODEL_CONFIGS: DefaultModelConfigs = {
  openai: {
    "gpt-4o": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 4096
    },
    "gpt-4o-mini": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2048
    },
    "gpt-4": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 4096
    },
    "gpt-3.5-turbo": {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      temperature: 0.7,
      maxTokens: 2048
    }
  },
  ollama: {
    "llama3": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 2048
    },
    "mistral": {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.7,
      maxTokens: 2048
    }
  }
};

// Provider factory
class Provider implements ProviderInstance {
  public type: ProviderType;
  private models: Map<string, ProviderModel>;
  private embeddingModel: string | null = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    // Validate required parameters
    validateRequiredParam(config, "config", "Provider constructor");
    validateRequiredParams(
      config,
      ["type"],
      "Provider constructor"
    );
    
    // Ensure we have either model or models specified
    if (!config.model && (!config.models || config.models.length === 0)) {
      throw new Error(`Either 'model' or 'models' must be specified in provider config`);
    }
    
    this.type = config.type;
    this.config = config;
    this.models = new Map();

    // Initialize models
    this.initializeModels();

    // Initialize embedding provider if specified
    if (config.embeddingModel) {
      // We need to run this asynchronously since it contains async operations
      this.initializeEmbeddingModel().catch((error) => {
        logger.error("Error initializing embedding model:", error);
      });
    }
  }

  private initializeModels(): void {
    const { type, models, model } = this.config;

    // Handle simplified format with single model
    if (model) {
      // Convert the single model string to an array for processing
      this.processModels(type, [model]);
      
      // Set as default model if not already set
      if (!this.config.defaultModel) {
        this.config.defaultModel = model;
      }
      return;
    }

    // Handle traditional format with models array
    if (models && models.length > 0) {
      this.processModels(type, models);
      
      // Set default model if not specified
      if (!this.config.defaultModel && models.length > 0) {
        // Use the first model as default
        const firstModel = models[0];
        if (typeof firstModel === 'string') {
          this.config.defaultModel = firstModel;
        } else {
          this.config.defaultModel = firstModel.name;
        }
      }
    } else {
      throw new Error(`No models specified for provider: ${type}`);
    }
  }

  private processModels(type: ProviderType, modelsList: (ProviderModelConfig | string)[]): void {
    // Validate required parameters
    validateRequiredParam(type, "type", "processModels");
    validateRequiredParam(modelsList, "modelsList", "processModels");
    
    if (type === "openai") {
      for (const modelConfig of modelsList) {
        // If only model name is provided, use default config
        let fullModelConfig: OpenAIModelConfig;
        
        if (typeof modelConfig === 'string') {
          const defaultConfig = DEFAULT_MODEL_CONFIGS.openai[modelConfig];
          if (!defaultConfig) {
            throw new Error(`No default configuration found for OpenAI model: ${modelConfig}`);
          }
          fullModelConfig = {
            name: modelConfig,
            ...defaultConfig
          };
        } else {
          // Use provided config but fill in any missing defaults
          const openAIConfig = modelConfig as OpenAIModelConfig;
          const modelName = openAIConfig.name;
          const defaultConfig = DEFAULT_MODEL_CONFIGS.openai[modelName] || {};
          
          // Apply defaults for required parameters
          validateRequiredParam(modelName, "name", "OpenAI model configuration");
          
          fullModelConfig = {
            ...defaultConfig,
            ...openAIConfig,
            temperature: openAIConfig.temperature ?? defaultConfig.temperature ?? 0.7,
            maxTokens: openAIConfig.maxTokens ?? defaultConfig.maxTokens ?? 2048,
            apiKey: openAIConfig.apiKey ?? defaultConfig.apiKey ?? process.env.OPENAI_API_KEY,
            baseUrl: openAIConfig.baseUrl ?? defaultConfig.baseUrl ?? process.env.OPENAI_BASE_URL
          };
        }

        const model = new OpenAIProvider(type, fullModelConfig);
        this.models.set(model.name, model);
      }
    } else if (type === "ollama") {
      for (const modelConfig of modelsList) {
        // If only model name is provided, use default config
        let fullModelConfig: OllamaModelConfig;
        
        if (typeof modelConfig === 'string') {
          const defaultConfig = DEFAULT_MODEL_CONFIGS.ollama[modelConfig];
          if (!defaultConfig) {
            throw new Error(`No default configuration found for Ollama model: ${modelConfig}`);
          }
          fullModelConfig = {
            name: modelConfig,
            ...defaultConfig
          };
        } else {
          // Use provided config but fill in any missing defaults
          const ollamaConfig = modelConfig as OllamaModelConfig;
          const modelName = ollamaConfig.name;
          const defaultConfig = DEFAULT_MODEL_CONFIGS.ollama[modelName] || {};
          
          // Apply defaults for required parameters
          validateRequiredParam(modelName, "name", "Ollama model configuration");
          
          fullModelConfig = {
            ...defaultConfig,
            ...ollamaConfig,
            temperature: ollamaConfig.temperature ?? defaultConfig.temperature ?? 0.7,
            maxTokens: ollamaConfig.maxTokens ?? defaultConfig.maxTokens ?? 2048,
            baseUrl: ollamaConfig.baseUrl ?? defaultConfig.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
          };
        }

        const model = new OllamaProvider(type, fullModelConfig);
        this.models.set(model.name, model);
      }
    } else {
      throw new Error(`Unsupported provider type: ${type}`);
    }
  }

  private async initializeEmbeddingModel(): Promise<void> {
    const { embeddingModel } = this.config;

    // Default embedding model if not specified
    const defaultEmbeddingModel =
      process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
    const modelToUse = embeddingModel || defaultEmbeddingModel;

    try {
      // Test if the embedding utility works
      const isWorking = await Embedding.isAvailable(modelToUse);
      
      if (isWorking) {
        logger.info(`Embedding model initialized: ${modelToUse}`);
        this.embeddingModel = modelToUse;
      } else {
        logger.warn(`Embedding model failed to initialize: ${modelToUse}`);
        this.embeddingModel = null;
      }
    } catch (error) {
      logger.error("Error initializing embedding model:", error);
      this.embeddingModel = null;
    }
  }

  getModel(name: string): ProviderModel {
    // Validate required parameters
    validateRequiredParam(name, "name", "getModel");
    
    // If name is 'default', try to get the default model
    if (name === 'default' && this.config.defaultModel) {
      name = this.config.defaultModel;
    }
    
    const model = this.models.get(name);
    if (!model) {
      throw new Error(`Model '${name}' not found in provider: ${this.type}`);
    }
    return model;
  }

  // Get the default model name
  getDefaultModel(): string | null {
    return this.config.defaultModel || null;
  }

  listModels(): string[] {
    return Array.from(this.models.keys());
  }

  getEmbeddingModel(): string | null {
    return this.embeddingModel;
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    // Validate required parameters
    validateRequiredParam(text, "text", "generateEmbedding");
    
    if (!this.embeddingModel) {
      logger.warn("No embedding model configured");
      return null;
    }

    try {
      // Use the Embedding utility to generate embeddings
      return await Embedding.generateEmbedding(text, this.embeddingModel);
    } catch (error) {
      logger.error("Error generating embedding:", error);
      return null;
    }
  }

  async testEmbeddingModel(name?: string): Promise<boolean> {
    try {
      const modelToUse = name || this.embeddingModel || this.config.embeddingModel || 
        process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
      
      logger.info(`Testing embedding model: ${modelToUse}`);
      
      // First check which embedding models are available (for debugging)
      const availableModels = await Embedding.listAvailableModels();
      if (availableModels.length > 0) {
        logger.debug(`Available embedding models: ${availableModels.join(", ")}`);
      }

      // Test if the embedding utility actually works by generating a test embedding
      const isWorking = await Embedding.isAvailable(modelToUse);

      if (isWorking) {
        logger.info(`Embedding model initialized: ${modelToUse}`);
        this.embeddingModel = modelToUse;
        return true;
      } else {
        logger.warn(`Embedding model failed to initialize: ${modelToUse}`);
        this.embeddingModel = null;
        return false;
      }
    } catch (error) {
      logger.error(`Error initializing embedding model:`, error);
      this.embeddingModel = null;
      return false;
    }
  }
}

// Create provider factory
export const createProvider: ProviderFactory = (config: ProviderConfig) => {
  // Validate required parameters
  validateRequiredParam(config, "config", "createProvider");
  validateRequiredParams(
    config,
    ["type"],
    "createProvider"
  );
  
  return new Provider(config);
};
