import OpenAI from "openai";
import {
  ProviderModel,
  ProviderType,
  ProviderMessage,
  CompletionOptions,
  OpenAIModelConfig,
} from "../../types";
import { logger, validateRequiredParam } from "../../utils";
import fs from "fs";
import path from "path";
import mammoth from "mammoth";

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
  public client: OpenAI;
  
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
    const formattedMessages = messages.map(msg => {
      // Handle multimodal content
      if (Array.isArray(msg.content)) {
        const content = msg.content.map(item => {
          switch (item.type) {
            case "text":
              return {
                type: "text" as const,
                text: item.text
              };
            case "image_url":
              return {
                type: "image_url" as const,
                image_url: item.image_url
              };
            case "image_file":
              // Convert file path to base64 for OpenAI
              try {
                const fileBuffer = fs.readFileSync(item.image_file.path);
                const base64 = fileBuffer.toString('base64');
                const ext = path.extname(item.image_file.path).toLowerCase();
                const mimeType = this.getMimeType(ext);
                
                return {
                  type: "image_url" as const,
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                    detail: "auto"
                  }
                };
              } catch (error) {
                logger.error("Unknown", "OpenAI", `Failed to read image file: ${error}`);
                return {
                  type: "text" as const,
                  text: `[Error reading image file: ${item.image_file.path}]`
                };
              }
            case "document":
              // For documents, we'll provide a text representation
              return {
                type: "text" as const,
                text: `[Document: ${item.document.filename}]`
              };
            default:
              return {
                type: "text" as const,
                text: "[Unsupported content type]"
              };
          }
        });
        
        return {
          role: msg.role,
          content
        };
      } else {
        // Handle simple text content
        return {
          role: msg.role,
          content: msg.content
        };
      }
    });
    
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
    
    logger.debug("Unknown", "OpenAI", "Artificial streaming completed");
    return text;
  }

  // Get API key for specific service
  private getApiKey(serviceType: 'general' | 'embedding' | 'image'): string {
    let apiKey: string | undefined;
    
    switch (serviceType) {
      case 'embedding':
        apiKey = process.env.OPENAI_EMBEDDING_API_KEY || this.config.apiKey;
        break;
      case 'image':
        apiKey = process.env.OPENAI_VISION_API_KEY || this.config.apiKey;
        break;
      default:
        apiKey = this.config.apiKey;
    }
    
    if (!apiKey) {
      const envVar = serviceType === 'embedding' ? 'OPENAI_EMBEDDING_API_KEY' : 
                    serviceType === 'image' ? 'OPENAI_VISION_API_KEY' : 'OPENAI_API_KEY';
      throw new Error(`API key required for ${serviceType} service. Set ${envVar} environment variable.`);
    }
    
    return apiKey;
  }

  // Create OpenAI client for specific service
  private createServiceClient(serviceType: 'general' | 'embedding' | 'image'): OpenAI {
    const apiKey = this.getApiKey(serviceType);
    
    const openaiConfig: any = {
      apiKey,
    };

    // For vision/image analysis, always use standard OpenAI API
    if (serviceType === 'image') {
      // Use standard OpenAI base URL for vision
      openaiConfig.baseURL = process.env.OPENAI_VISION_BASE_URL || "https://api.openai.com/v1";
      logger.debug("Unknown", "OpenAI", `Using OpenAI base URL for vision: ${openaiConfig.baseURL}`);
    } else {
      // For other services, use configured base URL
      if (this.config.baseUrl) {
        openaiConfig.baseURL = this.config.baseUrl;
      }
    }

    if (this.config.organization) {
      openaiConfig.organization = this.config.organization;
    }

    return new OpenAI(openaiConfig);
  }

  // Media Analysis Methods
  async analyzeImage(
    imagePath?: string, 
    imageUrl?: string, 
    base64Data?: string,
    prompt?: string,
    detail: 'low' | 'high' | 'auto' = 'auto'
  ): Promise<string> {
    try {
      let imageContent: any;
      
      if (imageUrl) {
        imageContent = {
          type: "image_url",
          image_url: {
            url: imageUrl,
            detail
          }
        };
      } else if (base64Data) {
        imageContent = {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64Data}`,
            detail
          }
        };
      } else if (imagePath) {
        const fileBuffer = fs.readFileSync(imagePath);
        const base64 = fileBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = this.getMimeType(ext);
        
        imageContent = {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${base64}`,
            detail
          }
        };
      } else {
        throw new Error("No image source provided");
      }

      const messages = [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: prompt || "What do you see in this image?"
            },
            imageContent
          ]
        }
      ];

      // Use image-specific API key
      const imageClient = this.createServiceClient('image');
      logger.debug("Unknown", "OpenAI", "Using image analysis API key for image processing");

      const response = await imageClient.chat.completions.create({
        model: this.name.includes('gpt-4') ? this.name : 'gpt-4o',
        messages,
        max_tokens: 1000
      });

      return response.choices[0]?.message?.content || "No analysis available";
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Image analysis error: ${error}`);
      throw error;
    }
  }

  async analyzePDF(filePath: string, prompt?: string): Promise<{ text: string; analysis: string; pages: number }> {
    try {
      // Use our PDF parser with chunk system for RAG compatibility
      const { parsePDF } = await import("../../utils/pdf-parser");
      const parseResult = await parsePDF(filePath, {
        chunkSize: 2000,
        chunkOverlap: 200
      });
      
      // Combine all chunks into one text
      const text = parseResult.documents.map((doc: any) => doc.content).join('\n\n');
      
      const analysisPrompt = prompt || 
        "Analyze this PDF document and provide a comprehensive summary including key points, structure, and important information.";
      
      const messages = [
        {
          role: "system" as const,
          content: "You are a document analysis expert. Analyze the provided text content and give insights."
        },
        {
          role: "user" as const,
          content: `${analysisPrompt}\n\nDocument content:\n${text}`
        }
      ];

      const response = await this.client.chat.completions.create({
        model: this.name,
        messages,
        max_tokens: 2000
      });

      const analysis = response.choices[0]?.message?.content || "No analysis available";

      return {
        text,
        analysis,
        pages: parseResult.pdfMetadata.numPages
      };
    } catch (error) {
      logger.error("Unknown", "OpenAI", `PDF analysis error: ${error}`);
      throw error;
    }
  }

  async analyzeDocument(filePath: string, prompt?: string): Promise<{ text: string; analysis: string }> {
    try {
      const ext = path.extname(filePath).toLowerCase();
      let text = "";

      if (ext === '.pdf') {
        const pdfResult = await this.analyzePDF(filePath, prompt);
        return {
          text: pdfResult.text,
          analysis: pdfResult.analysis
        };
      } else if (ext === '.docx' || ext === '.doc') {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      } else {
        throw new Error(`Unsupported document format: ${ext}`);
      }

      const analysisPrompt = prompt || 
        "Analyze this document and provide a comprehensive summary including key points, structure, and important information.";
      
      const messages = [
        {
          role: "system" as const,
          content: "You are a document analysis expert. Analyze the provided text content and give insights."
        },
        {
          role: "user" as const,
          content: `${analysisPrompt}\n\nDocument content:\n${text}`
        }
      ];

      const response = await this.client.chat.completions.create({
        model: this.name,
        messages,
        max_tokens: 2000
      });

      const analysis = response.choices[0]?.message?.content || "No analysis available";

      return {
        text,
        analysis
      };
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Document analysis error: ${error}`);
      throw error;
    }
  }

  async analyzeMedia(
    filePath?: string,
    url?: string,
    base64Data?: string,
    prompt?: string,
    options?: { detail?: 'low' | 'high' | 'auto', maxTokens?: number }
  ): Promise<{ type: string; content: string; analysis: string; metadata?: any }> {
    try {
      let fileType: string;
      
      if (filePath) {
        fileType = this.detectFileType(filePath);
      } else if (url) {
        fileType = 'image'; // Assume URLs are images
      } else if (base64Data) {
        fileType = 'image'; // Assume base64 is image
      } else {
        throw new Error("No media source provided");
      }

      switch (fileType) {
        case 'image': {
          const analysis = await this.analyzeImage(
            filePath, 
            url, 
            base64Data, 
            prompt, 
            options?.detail
          );
          return {
            type: 'image',
            content: analysis,
            analysis
          };
        }
        case 'pdf': {
          if (!filePath) throw new Error("File path required for PDF analysis");
          const result = await this.analyzePDF(filePath, prompt);
          return {
            type: 'pdf',
            content: result.text,
            analysis: result.analysis,
            metadata: { pages: result.pages }
          };
        }
        case 'document': {
          if (!filePath) throw new Error("File path required for document analysis");
          const result = await this.analyzeDocument(filePath, prompt);
          return {
            type: 'document',
            content: result.text,
            analysis: result.analysis
          };
        }
        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Media analysis error: ${error}`);
      throw error;
    }
  }

  private detectFileType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const documentExtensions = ['.docx', '.doc'];
    
    if (imageExtensions.includes(ext)) {
      return 'image';
    } else if (ext === '.pdf') {
      return 'pdf';
    } else if (documentExtensions.includes(ext)) {
      return 'document';
    } else {
      throw new Error(`Unsupported file extension: ${ext}`);
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    
    return mimeTypes[extension] || 'image/jpeg';
  }

  // Embedding generation with dedicated API key
  async generateEmbedding(text: string, model?: string): Promise<number[]> {
    try {
      if (!text || typeof text !== 'string') {
        throw new Error('Invalid text input for embedding generation');
      }

      // Use embedding-specific API key
      const embeddingClient = this.createServiceClient('embedding');
      logger.debug("Unknown", "OpenAI", "Using embedding API key for embedding generation");

      const embeddingModel = model || process.env.EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

      const response = await embeddingClient.embeddings.create({
        model: embeddingModel,
        input: text,
        encoding_format: 'float'
      });

      return response.data[0].embedding;
    } catch (error) {
      logger.error("Unknown", "OpenAI", `Embedding generation error: ${error}`);
      throw error;
    }
  }
} 