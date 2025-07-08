import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderModel,
  ProviderType,
  ProviderMessage,
  CompletionOptions,
  ClaudeModelConfig,
  StructuredCompletionResponse,
  ProviderToolCall,
} from "../types/provider";
import { logger, validateRequiredParam } from "../utils";
import { DEFAULT_CLAUDE_BASE_URL, DEFAULT_CLAUDE_API_VERSION } from "../constants";

/**
 * Create Claude configuration with defaults
 */
export function createClaudeConfig(
  modelName: string,
  config?: Partial<ClaudeModelConfig>
): ClaudeModelConfig {
  return {
    name: modelName,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
    apiVersion: DEFAULT_CLAUDE_API_VERSION,
    temperature: 0.7,
    maxTokens: 4096,
    ...config,
  };
}

/**
 * Claude Provider implementation
 */
export class ClaudeProvider implements ProviderModel {
  public provider: ProviderType;
  public name: string;
  public config: ClaudeModelConfig;
  public client: Anthropic;
  
  constructor(type: ProviderType, config: ClaudeModelConfig) {
    // Validate required parameters
    validateRequiredParam(type, "type", "Claude constructor");
    validateRequiredParam(config, "config", "Claude constructor");
    validateRequiredParam(config.name, "config.name", "Claude constructor");

    logger.info("System", "Claude", `Initializing Claude model: ${config.name}`);

    this.provider = type;
    this.name = config.name;
    this.config = {
      ...config,
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
      baseUrl: config.baseUrl || process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_BASE_URL,
      apiVersion: config.apiVersion || DEFAULT_CLAUDE_API_VERSION,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096,
    };

    // Validate API key
    if (!this.config.apiKey) {
      logger.error("System", "Claude", "Claude API key is required");
      throw new Error("Claude API key is required. Set ANTHROPIC_API_KEY environment variable or provide apiKey in config.");
    }

    // Initialize Claude client
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
    
    logger.success("System", "Claude", `Claude model initialized: ${config.name}`);
  }
  
  async complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | StructuredCompletionResponse> {
    try {
      logger.debug("Unknown", "Claude", `Starting complete with ${options?.tools?.length || 0} tools`);

      // Convert messages to Claude format
      const claudeMessages = this.convertMessages(messages);
      
      // Extract system message
      const systemMessage = options?.systemMessage || messages.find(m => m.role === 'system')?.content || undefined;
      
      // Build request parameters
      const params: any = {
        model: this.name,
        messages: claudeMessages.filter(m => m.role !== 'system'),
        max_tokens: options?.maxTokens || this.config.maxTokens,
        temperature: options?.temperature ?? this.config.temperature,
      };

      if (systemMessage) {
        params.system = typeof systemMessage === 'string' ? systemMessage : JSON.stringify(systemMessage);
      }

      // Handle tool calling
      if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
        params.tools = this.convertToolsToClaudeFormat(options.tools);
        params.tool_choice = { type: "auto" };
      }

      // Handle streaming
      if (options?.stream && options?.onChunk) {
        return await this.streamComplete(messages, options);
      }

      // Regular completion
      const response = await this.client.messages.create(params);
      
      // Handle tool calls
      if (response.content.some((c: any) => c.type === 'tool_use')) {
        const toolCalls: ProviderToolCall[] = response.content
          .filter((c: any) => c.type === 'tool_use')
          .map((toolUse: any) => ({
            type: 'function',
            id: toolUse.id,
            name: toolUse.name,
            arguments: toolUse.input,
          }));
        
        const textContent = response.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
        
        return {
          content: textContent,
          tool_calls: toolCalls,
        };
      }
      
      // Extract text content
      const textContent = response.content
        .filter(c => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      
      return textContent;
    } catch (error) {
      logger.error("Unknown", "Claude", `Error in complete: ${error}`);
      throw error;
    }
  }
  
  async streamComplete(
    messages: ProviderMessage[], 
    options?: CompletionOptions
  ): Promise<string> {
    try {
      logger.debug("Unknown", "Claude", "Starting stream complete");

      // Convert messages to Claude format
      const claudeMessages = this.convertMessages(messages);
      
      // Extract system message
      const systemMessage = options?.systemMessage || messages.find(m => m.role === 'system')?.content || undefined;
      
      // Build request parameters
      const params: any = {
        model: this.name,
        messages: claudeMessages.filter(m => m.role !== 'system'),
        max_tokens: options?.maxTokens || this.config.maxTokens,
        temperature: options?.temperature ?? this.config.temperature,
        stream: true,
      };

      if (systemMessage) {
        params.system = typeof systemMessage === 'string' ? systemMessage : JSON.stringify(systemMessage);
      }

      // Handle tool calling
      if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
        params.tools = this.convertToolsToClaudeFormat(options.tools);
        params.tool_choice = { type: "auto" };
      }

      // Stream the response
      const stream = await this.client.messages.create(params) as any;
      
      let fullResponse = '';
      
      for await (const chunk of stream) {
        if ((chunk as any).type === 'content_block_delta' && (chunk as any).delta?.type === 'text_delta') {
          const text = (chunk as any).delta.text;
          fullResponse += text;
          if (options?.onChunk) {
            options.onChunk(text);
          }
        }
      }
      
      return fullResponse;
    } catch (error) {
      logger.error("Unknown", "Claude", `Error in streamComplete: ${error}`);
      throw error;
    }
  }
  
  /**
   * Convert provider messages to Claude format
   */
  private convertMessages(messages: ProviderMessage[]): any[] {
    return messages.map(msg => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
          content: msg.content,
        };
      }
      
      // Handle multimodal content
      const claudeContent = msg.content.map(content => {
        if (content.type === 'text') {
          return {
            type: 'text',
            text: content.text,
          };
        } else if (content.type === 'image_url') {
          // Claude expects base64 images
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg', // You might need to determine this from the URL
              data: content.image_url.url.split(',')[1] || content.image_url.url,
            },
          };
        }
        // Handle other content types as needed
        return null;
      }).filter(Boolean);
      
      return {
        role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
        content: claudeContent,
      };
    });
  }
  
  /**
   * Convert tools to Claude format
   */
  private convertToolsToClaudeFormat(tools: any[]): any[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.parameters || {
        type: 'object',
        properties: {},
        required: [],
      },
    }));
  }
  
  /**
   * Generate embeddings - not supported by Claude
   */
  async generateEmbedding(_text: string): Promise<number[]> {
    throw new Error("Claude does not support embedding generation. Use OpenAI for embeddings.");
  }
}