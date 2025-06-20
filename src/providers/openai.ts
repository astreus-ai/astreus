import OpenAI from "openai";
import {
  ProviderModel,
  ProviderType,
  ProviderMessage,
  CompletionOptions,
  OpenAIModelConfig,
} from "../types";
import { logger, validateRequiredParam } from "../utils";

/**
 * Create OpenAI configuration with defaults
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

/**
 * OpenAI Provider implementation
 */
export class OpenAIProvider implements ProviderModel {
  public provider: ProviderType;
  public name: string;
  public config: OpenAIModelConfig;
  private client: OpenAI;
  
  constructor(type: ProviderType, config: OpenAIModelConfig) {
    // Validate required parameters
    validateRequiredParam(type, "type", "OpenAI constructor");
    validateRequiredParam(config, "config", "OpenAI constructor");
    validateRequiredParam(config.name, "config.name", "OpenAI constructor");

    logger.info("System", "OpenAI", `Initializing OpenAI model: ${config.name}`);

    this.provider = type;
    this.name = config.name;
    this.config = {
      ...config,
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      baseUrl: config.baseUrl || process.env.OPENAI_BASE_URL,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2048,
    };

    // Validate API key
    if (!this.config.apiKey) {
      logger.error("System", "OpenAI", "OpenAI API key is required");
      throw new Error("OpenAI API key is required. Set OPENAI_API_KEY environment variable or provide apiKey in config.");
    }

    // Initialize OpenAI client
    const openaiConfig: any = {
      apiKey: this.config.apiKey,
    };

    if (this.config.baseUrl) {
      openaiConfig.baseURL = this.config.baseUrl;
    }

    if (this.config.organization) {
      openaiConfig.organization = this.config.organization;
    }

    this.client = new OpenAI(openaiConfig);
    
    logger.success("System", "OpenAI", `OpenAI model initialized: ${config.name}`);
  }
  
  async complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | any> {
    try {
      logger.debug("Unknown", "OpenAI", `Starting complete with ${options?.tools?.length || 0} tools, stream: ${options?.stream}`);

      // Check if streaming is requested
      if (options?.stream && options?.onChunk) {
        // If tools are available, do tool calling first then artificial streaming
        if (options?.tools && options.tools.length > 0 && options?.toolCalling) {
          logger.debug("Unknown", "OpenAI", "Using tool calling with artificial streaming");
          
          // First do regular completion with tools
          const regularResponse = await this.regularComplete(messages, options);
          
          // Response structure logged for debugging
          
          // For tool calls, return the structured response immediately 
          // (streaming will be handled by the chat manager after tool execution)
          if (typeof regularResponse === 'object' && regularResponse.tool_calls) {
            return regularResponse;
          }
          
          // Then do artificial streaming of the result for non-tool responses
          if (typeof regularResponse === 'string' && regularResponse.length > 0) {
            return await this.artificialStream(regularResponse, options.onChunk);
          }
          
          return regularResponse;
        } else {
          return await this.streamComplete(messages, options, options.onChunk);
        }
      }
      
      // Prepare messages
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      
      // Log request info
      logger.debug("Unknown", "OpenAI", `Request with ${requestOptions.tools?.length || 0} tools`);
      
      // Make API request
      const response = await this.client.chat.completions.create(requestOptions);
      
      // Log response structure
      logger.debug("Unknown", "OpenAI", `Response with ${response.choices?.[0]?.message?.tool_calls?.length || 0} tool calls`);
      
      // Handle response - now can return either string or object with tool calls
      return this.processResponse(response);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }
  
  async streamComplete(
    messages: ProviderMessage[], 
    options?: CompletionOptions,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    try {
      // Prepare messages
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options with streaming enabled
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      requestOptions.stream = true;
      
      // Log request info
      logger.debug(`OpenAI streaming request: model=${this.name}`, { 
        messages: formattedMessages.length, 
        hasTools: !!requestOptions.tools,
        toolCount: requestOptions.tools?.length || 0 
      });
      
      // Make streaming API request
      const stream = await this.client.chat.completions.create(requestOptions) as any;
      
      let fullResponse = '';
      
      // Process streaming response
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          if (onChunk) {
            onChunk(content); // Send only the new chunk, not the full response
          }
        }
      }
      
      return fullResponse;
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Streaming error: ${error}`);
      this.handleError(error);
      throw error;
    }
  }
  
  private prepareMessages(messages: ProviderMessage[], systemMessage?: string) {
    // Convert to OpenAI message format
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
    // Base request options
    const requestOptions: any = {
      model: this.name,
      messages,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? this.config.maxTokens
    };
    
    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      requestOptions.tools = options.tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: this.formatToolParameters(tool.parameters)
        }
      }));
      
      // Set tool choice if enabled
      if (options.toolCalling) {
        requestOptions.tool_choice = "auto";
      }
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
  
  private processResponse(response: any): string | any {
    // Process OpenAI response
    
    // Check if the response has the expected structure
    if (!response.choices?.[0]?.message) {
      // Log the actual response structure for debugging
      logger.error('Unexpected OpenAI API response structure:', {
        responseId: response.id,
        responseObject: JSON.stringify(response),
        hasChoices: !!response.choices,
        choicesLength: response.choices?.length,
        firstChoice: response.choices?.[0] ? 'exists' : 'missing',
        hasMessage: !!response.choices?.[0]?.message
      });
      
      // Throw with more specific information about what's missing
      if (!response.choices) {
        throw new Error(`OpenAI API response missing 'choices' field: ${JSON.stringify(response)}`);
      } else if (!response.choices.length) {
        throw new Error(`OpenAI API response has empty 'choices' array: ${JSON.stringify(response)}`);
      } else if (!response.choices[0].message) {
        throw new Error(`OpenAI API response missing 'message' in first choice: ${JSON.stringify(response.choices[0])}`);
      } else {
        throw new Error(`OpenAI API unexpected response structure: ${JSON.stringify(response)}`);
      }
    }
    
    const message = response.choices[0].message;
    const toolCalls = message.tool_calls;
    
    // Handle tool calls if present - Return both message content and structured tool calls
    if (toolCalls?.length > 0) {
      logger.debug("Unknown", "OpenAI", `Found ${toolCalls.length} tool calls`);
      
      // Return structured data instead of formatted text
      const result = {
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
      
      logger.debug("Unknown", "OpenAI", `Returning structured response with ${result.tool_calls.length} tool calls`);
      
      return result;
    }
    
    // Return plain text response
    return message.content || '';
  }
  
  private handleError(error: any): void {
    if (!error) return;
    
    // Log the full error details
    logger.error('OpenAI API error:', {
      message: error.message,
      status: error.status,
      type: error.type,
      headers: error.headers,
      code: error.code,
      param: error.param,
      error: error.error
    });
    
    if (error.stack) {
      logger.debug(`Error stack: ${error.stack}`);
    }
  }
  
  // Regular completion without streaming (for tool calling)
  private async regularComplete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | any> {
    try {
      // Prepare messages
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      
      // Make API request
      const response = await this.client.chat.completions.create(requestOptions);
      
      // Handle response
      return this.processResponse(response);
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Regular completion error: ${error}`);
      this.handleError(error);
      throw error;
    }
  }
  
  // Artificial streaming for tool calling results
  private async artificialStream(text: string, onChunk: (chunk: string) => void): Promise<string> {
    logger.debug("Unknown", "OpenAI", `Starting artificial streaming of ${text.length} characters`);
    
    // Split text into chunks for more natural streaming
    // Use a mix of sentences and words for more natural flow
    const sentences = text.split(/(?<=[.!?])\s+/);
    let currentText = '';
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
            currentText += chunk;
            onChunk(chunk);
            chunk = '';
            
            // Small delay between chunks
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        }
      } else {
        // Send shorter sentences as a single chunk
        currentText += sentence + (sentCount < sentences.length ? ' ' : '');
        onChunk(sentence + (sentCount < sentences.length ? ' ' : ''));
        
        // Slightly longer delay between sentences
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    logger.debug("Unknown", "OpenAI", "Artificial streaming completed");
    return text;
  }
} 