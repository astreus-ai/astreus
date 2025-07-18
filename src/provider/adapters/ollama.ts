import {
  ProviderType,
  OllamaModelConfig,
  ProviderMessage,
  ProviderModel,
  CompletionOptions,
  StructuredCompletionResponse
} from "../../types/provider";
import { DEFAULT_OLLAMA_BASE_URL } from "../config";
import { logger } from "../../utils/logger";

/**
 * Create Ollama configuration helper
 */
export function createOllamaConfig(
  modelName: string,
  config?: Partial<OllamaModelConfig>
): OllamaModelConfig {
  return {
    name: modelName,
    baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
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
      config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  }

  async complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | StructuredCompletionResponse> {
    try {
      logger.debug("Unknown", "Ollama", `Starting complete with ${options?.tools?.length || 0} tools, stream: ${options?.stream}`);

      // Check if streaming is requested
      if (options?.stream && options?.onChunk) {
        // If tools are available, do tool calling first (no streaming for tool calls)
        if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
          logger.debug("Unknown", "Ollama", "Tool calling enabled - no streaming for tool calls");
          
          // Do regular completion with tools (no streaming)
          const regularResponse = await this.regularComplete(messages, options);
          
          // For tool calls, return the structured response immediately 
          if (typeof regularResponse === 'object' && regularResponse.tool_calls) {
            return regularResponse;
          }
          
          // If no tool calls but streaming requested, do artificial streaming
          if (typeof regularResponse === 'string' && regularResponse.length > 0) {
            return await this.artificialStream(regularResponse, options.onChunk);
          }
          
          return regularResponse;
        } else {
          // No tools - do normal streaming
          return await this.streamComplete(messages, options);
        }
      }

      // Format messages for Ollama
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      
      // Log request info
      logger.debug(`Ollama request: model=${this.name}`, { 
        messages: formattedMessages.length, 
        hasTools: !!options?.tools,
        toolCount: options?.tools?.length || 0 
      });

      // Call Ollama API
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestOptions),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      // Process the response
      return this.processResponse(data);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }
  
  private prepareMessages(messages: ProviderMessage[], systemMessage?: string) {
    // Convert to Ollama message format
    const formattedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    // Add system message if provided
    if (systemMessage) {
      formattedMessages.unshift({
        role: "system" as const,
        content: systemMessage
      });
    }
    
    return formattedMessages;
  }
  
  private buildRequestOptions(messages: any[], options?: CompletionOptions) {
    // Base request options for Ollama
    const requestOptions: any = {
      model: this.name,
      messages: messages,
      options: {
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? this.config.maxTokens
      },
      stream: options?.stream || false,
    };
    
    // Add tools if provided
    if (options?.tools && options.tools.length > 0 && options.toolCalling) {
      requestOptions.tools = options.tools.map((tool: any) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: this.formatToolParameters(tool.parameters)
        }
      }));
    }
    
    return requestOptions;
  }
  
  private formatToolParameters(parameters: any): Record<string, any> {
    // Default empty schema with proper type
    const schemaObject: Record<string, any> = {
      type: "object",
      properties: {},
      additionalProperties: false
    };
    
    if (!parameters) {
      return schemaObject;
    }
    
    // Handle already formatted parameters
    if (typeof parameters === 'object') {
      // If it's already a proper JSON Schema object, use it directly
      if ('type' in parameters && parameters.type === 'object') {
        return parameters;
      }
      
      // If it has properties field, use that
      if ('properties' in parameters) {
        schemaObject.properties = parameters.properties;
        if (Array.isArray(parameters.required) && parameters.required.length > 0) {
          schemaObject.required = parameters.required;
        }
        return schemaObject;
      }
      
      // Handle array of parameter definitions
      if (Array.isArray(parameters)) {
        const requiredParams: string[] = [];
        
        parameters.forEach(param => {
          if (typeof param === 'object' && param.name && param.type) {
            // Create a property definition based on the parameter type
            const propertyDef: Record<string, any> = {
              type: param.type,
              description: param.description || `Parameter ${param.name}`
            };
            
            // Handle array type specifically
            if (param.type === 'array') {
              // Ensure arrays have an items definition
              propertyDef.items = param.items || { type: 'string' };
              
              // Add array constraints if available
              if (param.minItems !== undefined) propertyDef.minItems = param.minItems;
              if (param.maxItems !== undefined) propertyDef.maxItems = param.maxItems;
            }
            
            // Add any default value
            if (param.default !== undefined) {
              propertyDef.default = param.default;
            }
            
            // Add property to schema
            (schemaObject.properties as Record<string, any>)[param.name] = propertyDef;
            
            if (param.required) {
              requiredParams.push(param.name);
            }
          }
        });
        
        if (requiredParams.length > 0) {
          schemaObject.required = requiredParams;
        }
      }
    }
    
    return schemaObject;
  }
  
  private processResponse(data: any): string | StructuredCompletionResponse {
    // Check if the response has the expected structure
    if (!data?.message) {
      logger.error('Unexpected Ollama API response structure:', {
        responseObject: JSON.stringify(data)
      });
      
      throw new Error(`Ollama API unexpected response structure: ${JSON.stringify(data)}`);
    }
    
    const message = data.message;
    const toolCalls = message.tool_calls;
    
    // Handle tool calls if present
    if (toolCalls?.length > 0) {
      // Log detailed raw tool calls for debugging
      logger.debug('Ollama raw tool calls:', JSON.stringify(toolCalls, null, 2));
      
      // Return structured data instead of formatted text
      return {
        content: message.content || '',
        tool_calls: toolCalls.map((call: any) => {
          try {
            if (call.type === 'function') {
              // Parse arguments to JavaScript object
              let args = {};
              if (call.function?.arguments) {
                try {
                  args = typeof call.function.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function.arguments;
                } catch (e) {
                  logger.error('Error parsing function arguments', { error: e });
                }
              }
              
              return {
                type: 'function',
                id: call.id,
                name: call.function?.name,
                arguments: args
              };
            }
            return call;
          } catch (e) {
            logger.error('Error processing tool call', { error: e });
            return { 
              type: 'error',
              error: e instanceof Error ? e.message : String(e)
            };
          }
        })
      };
    }
    
    // Return plain text response
    return message.content || '';
  }
  
  async streamComplete(
    messages: ProviderMessage[], 
    options?: CompletionOptions
  ): Promise<string> {
    try {
      logger.debug("Unknown", "Ollama", "Starting stream complete");

      // Format messages for Ollama
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options with streaming enabled
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      requestOptions.stream = true;
      
      // Log request info
      logger.debug(`Ollama streaming request: model=${this.name}`, { 
        messages: formattedMessages.length, 
        hasTools: !!requestOptions.tools,
        toolCount: requestOptions.tools?.length || 0 
      });
      
      // Make streaming API request
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestOptions),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.message && data.message.content) {
                const content = data.message.content;
                fullResponse += content;
                if (options?.onChunk) {
                  options.onChunk(content);
                }
              }
            } catch (parseError) {
              // Skip invalid JSON lines
              logger.debug("Unknown", "Ollama", `Skipping invalid JSON line: ${line}`);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      
      return fullResponse;
    } catch (error) {
      logger.error("Unknown", "Ollama", `Streaming error: ${error}`);
      this.handleError(error);
      throw error;
    }
  }

  // Regular completion without streaming (for tool calling)
  private async regularComplete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | StructuredCompletionResponse> {
    try {
      // Format messages for Ollama
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      
      // Call Ollama API
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestOptions),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      // Handle response
      return this.processResponse(data);
    } catch (error) {
      logger.error("Unknown", "Ollama", `Regular completion error: ${error}`);
      this.handleError(error);
      throw error;
    }
  }

  // Artificial streaming for tool calling results
  private async artificialStream(text: string, onChunk: (chunk: string) => void): Promise<string> {
    logger.debug("Unknown", "Ollama", `Starting artificial streaming of ${text.length} characters`);
    
    // Split text into chunks for more natural streaming
    const sentences = text.split(/(?<=[.!?])\s+/);
    let sentCount = 0;
    
    for (const sentence of sentences) {
      sentCount++;
      
      // For longer sentences, split into smaller chunks
      if (sentence.length > 80) {
        const words = sentence.split(' ');
        let chunk = '';
        
        for (let i = 0; i < words.length; i++) {
          chunk += (i === 0 ? '' : ' ') + words[i];
          
          // Send chunk every few words
          if (i % 5 === 4 || i === words.length - 1) {
            onChunk(chunk);
            chunk = '';
            
            // Small delay between chunks
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        }
      } else {
        // Send shorter sentences as a single chunk
        onChunk(sentence + (sentCount < sentences.length ? ' ' : ''));
        
        // Slightly longer delay between sentences
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    logger.debug("Unknown", "Ollama", "Artificial streaming completed");
    return text;
  }

  private handleError(error: any): void {
    if (!error) return;
    
    // Log the full error details
    logger.error('Ollama API error:', {
      message: error.message,
      status: error.status,
      type: error.type,
      stack: error.stack,
    });
  }
}
