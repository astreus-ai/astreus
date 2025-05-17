import { 
  ProviderType,
  OpenAIModelConfig,
  ProviderMessage,
  ProviderModel,
  CompletionOptions,
  ProviderTool
} from '../types/provider';
import logger from "../utils/logger";
import { OpenAI } from "openai";

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
  
  constructor(provider: ProviderType, config: OpenAIModelConfig) {
    this.provider = provider;
    this.name = config.name;
    this.config = config;
    
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl || process.env.OPENAI_BASE_URL,
    });
  }
  
  async complete(messages: ProviderMessage[], options?: CompletionOptions): Promise<string | any> {
    try {
      // Prepare messages
      const formattedMessages = this.prepareMessages(messages, options?.systemMessage);
      
      // Build request options
      const requestOptions = this.buildRequestOptions(formattedMessages, options);
      
      // Log request info
      logger.debug(`OpenAI request: model=${this.name}`, { 
        messages: formattedMessages.length, 
        hasTools: !!requestOptions.tools,
        toolCount: requestOptions.tools?.length || 0 
      });
      
      // Make API request
      const response = await this.client.chat.completions.create(requestOptions);
      
      // Handle response - now can return either string or object with tool calls
      return this.processResponse(response);
    } catch (error) {
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
      // Log detailed raw tool calls for debugging
      logger.debug('OpenAI raw tool calls:', JSON.stringify(toolCalls, null, 2));
      
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
} 