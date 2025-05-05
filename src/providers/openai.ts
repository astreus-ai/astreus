import { 
  ProviderType,
  OpenAIModelConfig,
  ProviderMessage,
  ProviderModel
} from '../types/provider';
import logger from "../utils/logger";
import { OpenAI } from "openai";

/**
 * Create OpenAI configuration helper
 */
export function createOpenAIConfig(
  modelName: string,
  config?: Partial<OpenAIModelConfig>
): OpenAIModelConfig {
  return {
    name: modelName,
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    temperature: 0.7,
    maxTokens: 2048,
    ...config,
  };
}

// OpenAI Provider implementation
export class OpenAIProvider implements ProviderModel {
  public provider: ProviderType;
  public name: string;
  public config: OpenAIModelConfig;
  private client: OpenAI;
  
  constructor(provider: ProviderType, config: OpenAIModelConfig) {
    this.provider = provider;
    this.name = config.name;
    this.config = config;
    
    // Initialize OpenAI client
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl || process.env.OPENAI_BASE_URL,
    });
  }
  
  async complete(messages: ProviderMessage[]): Promise<string> {
    try {
      // Convert our message format to OpenAI format
      const openaiMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));
      
      // Call OpenAI API
      const response = await this.client.chat.completions.create({
        model: this.name,
        messages: openaiMessages,
        temperature: this.config.temperature ?? 0.7,
        max_tokens: this.config.maxTokens,
      });
      
      // Safely handle response with proper error checking
      if (!response || !response.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
        throw new Error('Invalid response format from OpenAI API');
      }
      
      // Return the text response with proper null checking
      const result = response.choices[0]?.message?.content || '';
      return result;
    } catch (error) {
      logger.error('Error calling OpenAI API:', error);
      throw error;
    }
  }
} 