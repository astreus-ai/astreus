import {
  ProviderType,
  OllamaModelConfig,
  ProviderMessage,
  ProviderModel,
} from "../types/provider";
import logger from "../utils/logger";

// Default Ollama API URL
const DEFAULT_OLLAMA_API_URL = "http://localhost:11434";

/**
 * Create Ollama configuration helper
 */
export function createOllamaConfig(
  modelName: string,
  config?: Partial<OllamaModelConfig>
): OllamaModelConfig {
  return {
    name: modelName,
    baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_API_URL,
    temperature: 0.7,
    maxTokens: 2048,
    ...config,
  };
}

// Ollama Provider implementation
export class OllamaProvider implements ProviderModel {
  public provider: ProviderType;
  public name: string;
  public config: OllamaModelConfig;
  private baseUrl: string;

  constructor(provider: ProviderType, config: OllamaModelConfig) {
    this.provider = provider;
    this.name = config.name;
    this.config = config;
    this.baseUrl =
      config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_API_URL;
  }

  async complete(messages: ProviderMessage[]): Promise<string> {
    try {
      // Format messages for Ollama
      const ollamaMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Call Ollama API
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.name,
          messages: ollamaMessages,
          options: {
            temperature: this.config.temperature ?? 0.7,
            num_predict: this.config.maxTokens,
          },
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      // Type the data response
      return (data as any).message?.content || "";
    } catch (error) {
      logger.error("Error calling Ollama API:", error);
      throw error;
    }
  }
}
