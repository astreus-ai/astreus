import {
  ProviderConfig,
  ProviderInstance,
  ProviderModel,
  ProviderType,
  ProviderModelConfig,
  OpenAIModelConfig,
  OllamaModelConfig,
  ClaudeModelConfig,
  GeminiModelConfig,
} from "../types/provider";
import dotenv from "dotenv";
import { OpenAIProvider, OllamaProvider, ClaudeProvider, GeminiProvider, Embedding } from "./adapters";
import { validateRequiredParam, validateRequiredParams } from "../utils/validation";
import { logger } from "../utils/logger";
import { 
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_MODEL_CONFIGS,
  AVAILABLE_MODELS
} from './config';

// Load environment variables
dotenv.config();

// Define types for default configurations (prefixed with _ to indicate intentionally unused)
type _OpenAIDefaultConfigs = {
  [key: string]: Omit<OpenAIModelConfig, 'name'>;
};

type _OllamaDefaultConfigs = {
  [key: string]: Omit<OllamaModelConfig, 'name'>;
};

type _ClaudeDefaultConfigs = {
  [key: string]: Omit<ClaudeModelConfig, 'name'>;
};

type _GeminiDefaultConfigs = {
  [key: string]: Omit<GeminiModelConfig, 'name'>;
};

// DefaultModelConfigs type is defined by the imported constants

// Using DEFAULT_MODEL_CONFIGS imported from constants

// Provider client
export class ProviderClient implements ProviderInstance {
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
    
    logger.info("System", "Provider", `Creating ${config.type} provider`);
    
    this.type = config.type;
    this.models = new Map();
    this.config = config;

    // Initialize models based on configuration
    this.initializeModels();
    
    // Initialize embedding model
    this.initializeEmbeddingModel();
    
    logger.success("System", "Provider", `${config.type} provider initialized with ${this.models.size} models`);
  }

  private initializeModels(): void {
    const { config } = this;
    
    logger.debug("System", "Provider", `Initializing models for ${config.type} provider`);
    
    // Ensure we have either model or models specified
    if (!config.model && (!config.models || config.models.length === 0)) {
      logger.error("System", "Provider", "Either 'model' or 'models' must be specified in provider config");
      throw new Error(`Either 'model' or 'models' must be specified in provider config`);
    }

    // Handle simple format (single model string)
    if (config.model && typeof config.model === 'string') {
      logger.debug("System", "Provider", `Processing single model: ${config.model}`);
      this.processModels(config.type, [config.model]);
      return;
    }

    // Handle array format
    if (config.models && Array.isArray(config.models)) {
      logger.debug("System", "Provider", `Processing ${config.models.length} models`);
      this.processModels(config.type, config.models);
      return;
    }

    logger.error("System", "Provider", "Invalid model configuration - no models found");
    throw new Error("Invalid model configuration");
  }

  private processModels(type: ProviderType, modelsList: (ProviderModelConfig | string)[]): void {
    logger.debug("System", "Provider", `Processing ${modelsList.length} models for ${type} provider`);
    
    for (const modelItem of modelsList) {
      let modelConfig: ProviderModelConfig;
      
      if (typeof modelItem === 'string') {
        // String format - use defaults from constants
        const defaultConfigs = DEFAULT_MODEL_CONFIGS[type] as any;
        const defaultConfig = defaultConfigs?.[modelItem];
        
        if (defaultConfig) {
          logger.debug("System", "Provider", `Using default config for model: ${modelItem}`);
          modelConfig = {
            ...defaultConfig,
            name: modelItem
          };
        } else {
          logger.warn("System", "Provider", `No default config found for model: ${modelItem}, using basic config`);
          // Fallback configuration
          modelConfig = {
            name: modelItem,
            temperature: 0.7,
            maxTokens: 2048
          };
          
          // Add provider-specific defaults
          if (type === 'openai') {
            (modelConfig as OpenAIModelConfig).apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || '';
            (modelConfig as OpenAIModelConfig).baseUrl = this.config.baseUrl || process.env.OPENAI_BASE_URL;
          } else if (type === 'ollama') {
            (modelConfig as OllamaModelConfig).baseUrl = this.config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
          } else if (type === 'claude') {
            (modelConfig as ClaudeModelConfig).apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
            (modelConfig as ClaudeModelConfig).baseUrl = this.config.baseUrl || process.env.ANTHROPIC_BASE_URL;
          } else if (type === 'gemini') {
            (modelConfig as GeminiModelConfig).apiKey = this.config.apiKey || process.env.GOOGLE_API_KEY || '';
            (modelConfig as GeminiModelConfig).baseUrl = this.config.baseUrl || process.env.GOOGLE_BASE_URL;
          }
        }
      } else {
        // Object format - use as provided
        logger.debug("System", "Provider", `Using custom config for model: ${modelItem.name}`);
        modelConfig = modelItem;
      }

      // Override with provider-level settings if provided
      if (type === 'openai') {
        const openaiConfig = modelConfig as OpenAIModelConfig;
        if (this.config.apiKey) openaiConfig.apiKey = this.config.apiKey;
        if (this.config.baseUrl) openaiConfig.baseUrl = this.config.baseUrl;
        if (this.config.organization) openaiConfig.organization = this.config.organization;
      } else if (type === 'ollama') {
        const ollamaConfig = modelConfig as OllamaModelConfig;
        if (this.config.baseUrl) ollamaConfig.baseUrl = this.config.baseUrl;
      } else if (type === 'claude') {
        const claudeConfig = modelConfig as ClaudeModelConfig;
        if (this.config.apiKey) claudeConfig.apiKey = this.config.apiKey;
        if (this.config.baseUrl) claudeConfig.baseUrl = this.config.baseUrl;
      } else if (type === 'gemini') {
        const geminiConfig = modelConfig as GeminiModelConfig;
        if (this.config.apiKey) geminiConfig.apiKey = this.config.apiKey;
        if (this.config.baseUrl) geminiConfig.baseUrl = this.config.baseUrl;
      }

      // Create the provider model instance
      let providerModel: ProviderModel;
      
      if (type === 'openai') {
        providerModel = new OpenAIProvider(type, modelConfig as OpenAIModelConfig);
      } else if (type === 'ollama') {
        providerModel = new OllamaProvider(type, modelConfig as OllamaModelConfig);
      } else if (type === 'claude') {
        providerModel = new ClaudeProvider(type, modelConfig as ClaudeModelConfig);
      } else if (type === 'gemini') {
        providerModel = new GeminiProvider(type, modelConfig as GeminiModelConfig);
      } else {
        logger.error("System", "Provider", `Unsupported provider type: ${type}`);
        throw new Error(`Unsupported provider type: ${type}`);
      }

      // Store the model
      this.models.set(modelConfig.name, providerModel);
      logger.debug("System", "Provider", `Model registered: ${modelConfig.name}`);
    }
    
    logger.success("System", "Provider", `Successfully processed ${modelsList.length} models`);
  }

  private async initializeEmbeddingModel(): Promise<void> {
    if (this.config.embeddingModel) {
      logger.debug("System", "Provider", `Initializing embedding model: ${this.config.embeddingModel}`);
      try {
        // Test if the embedding model is available
        const isAvailable = await this.testEmbeddingModel(this.config.embeddingModel);
        if (isAvailable) {
          this.embeddingModel = this.config.embeddingModel;
          logger.success("System", "Provider", `Embedding model initialized: ${this.config.embeddingModel}`);
        } else {
          logger.warn("System", "Provider", `Embedding model not available: ${this.config.embeddingModel}`);
        }
      } catch (error) {
        logger.error("System", "Provider", `Error initializing embedding model: ${error}`);
      }
    } else {
      logger.debug("System", "Provider", "No embedding model specified");
    }
  }

  getModel(name: string): ProviderModel {
    validateRequiredParam(name, "name", "getModel");
    
    logger.debug("System", "Provider", `Retrieving model: ${name}`);
    
    const model = this.models.get(name);
    if (!model) {
      logger.error("System", "Provider", `Model not found: ${name}. Available models: ${Array.from(this.models.keys()).join(', ')}`);
      throw new Error(`Model '${name}' not found in provider. Available models: ${Array.from(this.models.keys()).join(', ')}`);
    }
    
    logger.debug("System", "Provider", `Model retrieved: ${name}`);
    return model;
  }

  // Get the default model name
  getDefaultModel(): string | null {
    return this.config.defaultModel || null;
  }

  listModels(): string[] {
    return Array.from(this.models.keys());
  }

  /**
   * Get all available models for this provider type
   */
  getAvailableModels(): string[] {
    return [...(AVAILABLE_MODELS[this.type] || [])];
  }

  getEmbeddingModel(): string | null {
    return this.embeddingModel;
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    // Validate required parameters
    validateRequiredParam(text, "text", "generateEmbedding");
    
    if (!this.embeddingModel) {
      logger.warn("System", "Provider", "No embedding model configured");
      return null;
    }

    try {
      // Use the Embedding utility to generate embeddings
      return await Embedding.generateEmbedding(text, this.embeddingModel);
    } catch (error) {
      logger.error("System", "Provider", `Error generating embedding: ${error}`);
      return null;
    }
  }

  async testEmbeddingModel(name?: string): Promise<boolean> {
    try {
      const modelToUse = name || this.embeddingModel || this.config.embeddingModel || 
        process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
      
      logger.info("System", "Provider", `Testing embedding model: ${modelToUse}`);
      
      // First check which embedding models are available (for debugging)
      const availableModels = await Embedding.listAvailableModels();
      if (availableModels.length > 0) {
        logger.debug(`Available embedding models: ${availableModels.join(", ")}`);
      }

      // Test if the embedding utility actually works by generating a test embedding
      const isWorking = await Embedding.isAvailable(modelToUse);

      if (isWorking) {
        logger.info("System", "Provider", `Embedding model initialized: ${modelToUse}`);
        this.embeddingModel = modelToUse;
        return true;
      } else {
        logger.warn("System", "Provider", `Embedding model failed to initialize: ${modelToUse}`);
        this.embeddingModel = null;
        return false;
      }
    } catch (error) {
      logger.error("System", "Provider", `Error initializing embedding model: ${error}`);
      this.embeddingModel = null;
      return false;
    }
  }
}