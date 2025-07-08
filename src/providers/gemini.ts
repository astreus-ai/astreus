import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import {
  ProviderModel,
  ProviderType,
  ProviderMessage,
  CompletionOptions,
  GeminiModelConfig,
  StructuredCompletionResponse,
  ProviderToolCall,
} from "../types/provider";
import { logger, validateRequiredParam } from "../utils";
import { DEFAULT_GEMINI_BASE_URL } from "../constants";

/**
 * Create Gemini configuration with defaults
 */
export function createGeminiConfig(
  modelName: string,
  config?: Partial<GeminiModelConfig>
): GeminiModelConfig {
  return {
    name: modelName,
    apiKey: process.env.GOOGLE_API_KEY,
    baseUrl: process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
    temperature: 0.7,
    maxTokens: 8192,
    ...config,
  };
}

/**
 * Gemini Provider implementation
 */
export class GeminiProvider implements ProviderModel {
  public provider: ProviderType;
  public name: string;
  public config: GeminiModelConfig;
  public client: GoogleGenerativeAI;
  public model: GenerativeModel;
  
  constructor(type: ProviderType, config: GeminiModelConfig) {
    // Validate required parameters
    validateRequiredParam(type, "type", "Gemini constructor");
    validateRequiredParam(config, "config", "Gemini constructor");
    validateRequiredParam(config.name, "config.name", "Gemini constructor");

    logger.info("System", "Gemini", `Initializing Gemini model: ${config.name}`);

    this.provider = type;
    this.name = config.name;
    this.config = {
      ...config,
      apiKey: config.apiKey || process.env.GOOGLE_API_KEY || "",
      baseUrl: config.baseUrl || process.env.GOOGLE_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 8192,
    };

    // Validate API key
    if (!this.config.apiKey) {
      logger.error("System", "Gemini", "Gemini API key is required");
      throw new Error("Gemini API key is required. Set GOOGLE_API_KEY environment variable or provide apiKey in config.");
    }

    // Initialize Gemini client
    this.client = new GoogleGenerativeAI(this.config.apiKey);
    this.model = this.client.getGenerativeModel({ model: this.name });
    
    logger.success("System", "Gemini", `Gemini model initialized: ${config.name}`);
  }
  
  async complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | StructuredCompletionResponse> {
    try {
      logger.debug("Unknown", "Gemini", `Starting complete with ${options?.tools?.length || 0} tools`);

      // Convert messages to Gemini format
      const { history, lastMessage } = this.convertMessages(messages);
      
      // Build generation config
      const generationConfig = {
        temperature: options?.temperature ?? this.config.temperature,
        maxOutputTokens: options?.maxTokens || this.config.maxTokens,
      };

      // Handle tool calling
      let tools = undefined;
      if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
        tools = [{
          functionDeclarations: this.convertToolsToGeminiFormat(options.tools),
        }];
      }

      // Create chat session
      const chat = this.model.startChat({
        history,
        generationConfig,
        tools,
      });

      // Handle streaming
      if (options?.stream && options?.onChunk) {
        return await this.streamComplete(messages, options);
      }

      // Send message and get response
      const result = await chat.sendMessage(lastMessage);
      const response = await result.response;
      
      // Handle function calls
      const functionCalls = response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const toolCalls: ProviderToolCall[] = functionCalls.map((call, index) => ({
          type: 'function',
          id: `call_${index}`,
          name: call.name,
          arguments: call.args || {},
        }));
        
        return {
          content: response.text() || '',
          tool_calls: toolCalls,
        };
      }
      
      return response.text();
    } catch (error) {
      logger.error("Unknown", "Gemini", `Error in complete: ${error}`);
      throw error;
    }
  }
  
  async streamComplete(
    messages: ProviderMessage[], 
    options?: CompletionOptions
  ): Promise<string> {
    try {
      logger.debug("Unknown", "Gemini", "Starting stream complete");

      // Convert messages to Gemini format
      const { history, lastMessage } = this.convertMessages(messages);
      
      // Build generation config
      const generationConfig = {
        temperature: options?.temperature ?? this.config.temperature,
        maxOutputTokens: options?.maxTokens || this.config.maxTokens,
      };

      // Handle tool calling
      let tools = undefined;
      if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
        tools = [{
          functionDeclarations: this.convertToolsToGeminiFormat(options.tools),
        }];
      }

      // Create chat session
      const chat = this.model.startChat({
        history,
        generationConfig,
        tools,
      });

      // Stream the response
      const result = await chat.sendMessageStream(lastMessage);
      
      let fullResponse = '';
      
      for await (const chunk of result.stream) {
        const text = chunk.text();
        fullResponse += text;
        if (options?.onChunk) {
          options.onChunk(text);
        }
      }
      
      return fullResponse;
    } catch (error) {
      logger.error("Unknown", "Gemini", `Error in streamComplete: ${error}`);
      throw error;
    }
  }
  
  /**
   * Convert provider messages to Gemini format
   */
  private convertMessages(messages: ProviderMessage[]): { history: any[], lastMessage: string } {
    // Gemini expects a different format - history of parts
    const history: any[] = [];
    let lastMessage = '';
    
    // Process all messages except the last one as history
    const messagesToProcess = [...messages];
    const lastMsg = messagesToProcess.pop();
    
    for (const msg of messagesToProcess) {
      const parts = this.convertMessageContent(msg.content);
      history.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
    
    // Process the last message
    if (lastMsg) {
      if (typeof lastMsg.content === 'string') {
        lastMessage = lastMsg.content;
      } else {
        // For multimodal content, we need to handle it differently
        lastMessage = lastMsg.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
    }
    
    return { history, lastMessage };
  }
  
  /**
   * Convert message content to Gemini parts format
   */
  private convertMessageContent(content: string | any[]): any[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    
    return content.map(item => {
      if (item.type === 'text') {
        return { text: item.text };
      } else if (item.type === 'image_url') {
        // Gemini expects base64 images with MIME type
        const base64Data = item.image_url.url.split(',')[1] || item.image_url.url;
        return {
          inlineData: {
            mimeType: 'image/jpeg', // You might need to determine this
            data: base64Data,
          },
        };
      }
      return null;
    }).filter(Boolean);
  }
  
  /**
   * Convert tools to Gemini format
   */
  private convertToolsToGeminiFormat(tools: any[]): any[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || {
        type: 'object',
        properties: {},
        required: [],
      },
    }));
  }
  
  /**
   * Generate embeddings - not supported by Gemini in this implementation
   */
  async generateEmbedding(_text: string): Promise<number[]> {
    throw new Error("Gemini embedding generation is not implemented. Use OpenAI for embeddings.");
  }
}