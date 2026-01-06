import {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMConfig,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  EmbeddingResult,
  isStringContent,
} from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getLogger } from '../../logger';
import { Logger } from '../../logger/types';
import { LLMApiError, VisionError } from '../../errors';
import * as fs from 'fs';
import * as path from 'path';

// Retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
      }
    }
  }
  if (!lastError) {
    throw new Error('No retry attempts made');
  }
  throw lastError;
}

// Gemini response type definitions
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponseWithUsage {
  usageMetadata?: GeminiUsageMetadata;
}

// Type guard for Gemini response with usage metadata
function hasUsageMetadata(response: object | null): response is GeminiResponseWithUsage {
  return typeof response === 'object' && response !== null && 'usageMetadata' in response;
}

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private client: GoogleGenerativeAI;
  private embeddingClient: GoogleGenerativeAI;
  private visionClient: GoogleGenerativeAI;
  private logger: Logger;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.GEMINI_API_KEY;

    // Use provided logger or fallback to global logger
    this.logger = config?.logger || getLogger();

    if (!apiKey) {
      throw new Error('Gemini API key is required. Set GEMINI_API_KEY environment variable.');
    }

    this.logger.info('Gemini provider initialized');
    this.logger.debug('Gemini provider initialization', {
      hasConfigApiKey: !!config?.apiKey,
      hasEnvApiKey: !!process.env.GEMINI_API_KEY,
      hasEmbeddingApiKey: !!process.env.GEMINI_EMBEDDING_API_KEY,
      hasVisionApiKey: !!process.env.GEMINI_VISION_API_KEY,
      hasCustomBaseUrl: !!config?.baseUrl,
      supportsEmbeddings: true,
      supportsVision: true,
    });

    // Main client for chat completions
    this.client = new GoogleGenerativeAI(apiKey);

    // Dedicated embedding client with fallback logic
    const embeddingApiKey = process.env.GEMINI_EMBEDDING_API_KEY || apiKey;
    this.embeddingClient = new GoogleGenerativeAI(embeddingApiKey);

    // Dedicated vision client with fallback logic
    const visionApiKey = process.env.GEMINI_VISION_API_KEY || apiKey;
    this.visionClient = new GoogleGenerativeAI(visionApiKey);
  }

  getSupportedModels(): string[] {
    return [
      'gemini-2.5-pro',
      'gemini-2.5-pro-deep-think',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-thinking',
      'gemini-2.0-flash-lite',
      'gemini-2.0-pro-experimental',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-pro',
    ];
  }

  getVisionModels(): string[] {
    return [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro-vision-latest',
      'gemini-pro-vision',
    ];
  }

  getEmbeddingModels(): string[] {
    return ['text-embedding-004', 'embedding-001'];
  }

  // Helper to create generationConfig - prevents duplicate code
  private createGenerationConfig(options: LLMRequestOptions): {
    temperature: number;
    maxOutputTokens: number;
  } {
    return {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4096,
    };
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const { systemInstruction, contents } = this.prepareMessages(options);
    const generationConfig = this.createGenerationConfig(options);

    try {
      const model = this.client.getGenerativeModel({
        model: options.model,
        ...(systemInstruction && {
          systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] },
        }),
        generationConfig,
      });

      const result = await withRetry(() =>
        model.generateContent({
          contents,
          generationConfig,
        })
      );

      const response = result.response;
      const text = response.text() || '';

      return {
        content: text,
        model: options.model,
        usage: {
          promptTokens: hasUsageMetadata(response)
            ? response.usageMetadata?.promptTokenCount || 0
            : 0,
          completionTokens: hasUsageMetadata(response)
            ? response.usageMetadata?.candidatesTokenCount || 0
            : 0,
          totalTokens: hasUsageMetadata(response)
            ? response.usageMetadata?.totalTokenCount || 0
            : 0,
        },
      };
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Gemini generateResponse failed', originalError, {
        model: options.model,
        errorMessage: originalError.message,
      });
      throw new LLMApiError(
        `Gemini API request failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  async *generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { systemInstruction, contents } = this.prepareMessages(options);
    const generationConfig = this.createGenerationConfig(options);

    const model = this.client.getGenerativeModel({
      model: options.model,
      ...(systemInstruction && {
        systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] },
      }),
      generationConfig,
    });

    let result;
    try {
      result = await withRetry(() =>
        model.generateContentStream({
          contents,
          generationConfig,
        })
      );
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Gemini stream initialization failed', originalError, {
        model: options.model,
        errorMessage: originalError.message,
      });
      throw new LLMApiError(
        `Gemini API stream request failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }

    try {
      for await (const chunk of result.stream) {
        const text = chunk.text();

        if (text) {
          yield { content: text, done: false, model: options.model };
        }
      }

      yield { content: '', done: true, model: options.model };
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      throw new LLMApiError(
        `Gemini streaming error: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  private prepareMessages(options: LLMRequestOptions): {
    systemInstruction?: string;
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  } {
    let systemInstruction = options.systemPrompt;
    const messages = options.messages.filter((m) => m.role !== 'system');

    // Find system message if no explicit system prompt
    if (!systemInstruction) {
      const systemMessage = options.messages.find((m) => m.role === 'system');
      if (systemMessage) {
        systemInstruction = isStringContent(systemMessage.content) ? systemMessage.content : '';
      }
    }

    // Convert messages to Gemini format
    const contents = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text: isStringContent(msg.content)
            ? msg.content
            : 'Multi-modal content not fully supported by Gemini provider',
        },
      ],
    }));

    return { systemInstruction, contents };
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

    this.logger.info(`Generating embedding with model: ${embeddingModel}`);
    this.logger.debug('Gemini embedding request', {
      model: embeddingModel,
      textLength: text.length,
    });

    try {
      const genModel = this.embeddingClient.getGenerativeModel({ model: embeddingModel });
      const result = await genModel.embedContent(text);

      const embeddingValues = result?.embedding?.values;
      if (!embeddingValues || embeddingValues.length === 0) {
        throw new Error('No embedding data returned from Gemini API');
      }

      const embeddingResult: EmbeddingResult = {
        embedding: embeddingValues,
        model: embeddingModel,
        usage: {
          promptTokens: 0, // Gemini doesn't provide detailed usage for embeddings
          totalTokens: 0,
        },
      };

      this.logger.info('Embedding generated successfully');
      this.logger.debug('Gemini embedding result', {
        model: embeddingModel,
        dimensions: embeddingResult.embedding.length,
      });

      return embeddingResult;
    } catch (error) {
      const originalError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Embedding generation failed');
      this.logger.debug('Gemini embedding error', {
        model: embeddingModel,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });
      throw new LLMApiError(
        `Gemini embedding generation failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  async analyzeImage(
    imagePath: string,
    options: VisionAnalysisOptions = {}
  ): Promise<VisionAnalysisResult> {
    const fileName = path.basename(imagePath);

    this.logger.info(`Analyzing image: ${fileName}`);
    this.logger.debug('Gemini image analysis started', {
      imagePath,
      fileName,
      hasPrompt: !!options.prompt,
      maxTokens: options.maxTokens || 1000,
    });

    // Validate image file (async)
    try {
      await fs.promises.access(imagePath);
    } catch {
      this.logger.error(`Image file not found: ${imagePath}`);
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const ext = path.extname(imagePath).toLowerCase();
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!supportedFormats.includes(ext)) {
      this.logger.error(`Unsupported image format: ${ext}`);
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`
      );
    }

    // Read and encode image (async)
    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = this.getMimeType(ext);

    return this.analyzeImageFromBase64(base64Image, { ...options, mimeType });
  }

  async analyzeImageFromBase64(
    base64Data: string,
    options: VisionAnalysisOptions & { mimeType?: string } = {}
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.info('Analyzing base64 image');
    this.logger.debug('Gemini base64 image analysis started', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      maxTokens: options.maxTokens || 1000,
      mimeType: options.mimeType || 'image/jpeg',
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';
      const mimeType = options.mimeType || 'image/jpeg';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      const genModel = this.visionClient.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.1,
        },
      });

      const imagePart = {
        inlineData: {
          data: cleanBase64,
          mimeType: mimeType,
        },
      };

      const result = await genModel.generateContent([prompt, imagePart]);
      const response = await result.response;
      const content = response.text() || 'No analysis available';

      const processingTime = Date.now() - startTime;

      const analysisResult: VisionAnalysisResult = {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage:
            hasUsageMetadata(response) && response.usageMetadata
              ? {
                  promptTokens: response.usageMetadata.promptTokenCount || 0,
                  completionTokens: response.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: response.usageMetadata.totalTokenCount || 0,
                }
              : undefined,
        },
      };

      this.logger.info('Image analysis completed');
      this.logger.debug('Gemini image analysis result', {
        model,
        processingTime,
        contentLength: content.length,
        promptTokens: hasUsageMetadata(response)
          ? response.usageMetadata?.promptTokenCount || 0
          : 0,
        candidatesTokens: hasUsageMetadata(response)
          ? response.usageMetadata?.candidatesTokenCount || 0
          : 0,
        totalTokens: hasUsageMetadata(response) ? response.usageMetadata?.totalTokenCount || 0 : 0,
      });

      return analysisResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error(String(error));

      this.logger.error('Image analysis failed');
      this.logger.debug('Gemini image analysis error', {
        processingTime,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });

      throw new VisionError(
        `Gemini vision analysis failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };

    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
  }

  getEmbeddingProvider(): LLMProvider {
    return {
      name: 'gemini-embedding',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: () => [],
      getEmbeddingModels: this.getEmbeddingModels.bind(this),
      generateEmbedding: async (text: string, model?: string) => {
        const embeddingModel = model || this.getEmbeddingModels()[0]; // Use provided model or fallback to first available

        this.logger.debug('Using dedicated embedding client', {
          model: embeddingModel,
          textLength: text.length,
        });

        const genModel = this.embeddingClient.getGenerativeModel({ model: embeddingModel });
        const result = await genModel.embedContent(text);

        const embeddingValues = result?.embedding?.values;
        if (!embeddingValues || embeddingValues.length === 0) {
          throw new Error('No embedding data returned from Gemini API');
        }

        return {
          embedding: embeddingValues,
          model: embeddingModel,
          usage: {
            promptTokens: 0,
            totalTokens: 0,
          },
        };
      },
    };
  }

  getVisionProvider(): LLMProvider {
    return {
      name: 'gemini-vision',
      generateResponse: this.generateResponse.bind(this),
      generateStreamResponse: this.generateStreamResponse.bind(this),
      getSupportedModels: () => [],
      getVisionModels: this.getVisionModels.bind(this),
      getEmbeddingModels: () => [],
      analyzeImage: async (imagePath: string, options?: VisionAnalysisOptions) => {
        const imageBuffer = await fs.promises.readFile(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = this.getMimeType(ext);

        return this.analyzeImageFromBase64WithClient(
          base64Image,
          { ...options, mimeType },
          this.visionClient
        );
      },
      analyzeImageFromBase64: async (base64Data: string, options?: VisionAnalysisOptions) => {
        return this.analyzeImageFromBase64WithClient(base64Data, options, this.visionClient);
      },
    };
  }

  private async analyzeImageFromBase64WithClient(
    base64Data: string,
    options: VisionAnalysisOptions & { mimeType?: string } = {},
    client: GoogleGenerativeAI
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    this.logger.debug('Using dedicated vision client', {
      base64Length: base64Data.length,
      hasPrompt: !!options.prompt,
      mimeType: options.mimeType || 'image/jpeg',
    });

    try {
      const model = options.model || this.getVisionModels()[0]; // Use agent's model or fallback to first available
      const prompt = options.prompt || 'Analyze this image and describe what you see in detail.';
      const mimeType = options.mimeType || 'image/jpeg';

      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

      const genModel = client.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.1,
        },
      });

      const imagePart = {
        inlineData: {
          data: cleanBase64,
          mimeType: mimeType,
        },
      };

      const result = await genModel.generateContent([prompt, imagePart]);
      const response = await result.response;
      const content = response.text() || 'No analysis available';

      const processingTime = Date.now() - startTime;

      return {
        content,
        confidence: 1.0,
        metadata: {
          model,
          provider: this.name,
          processingTime,
          tokenUsage:
            hasUsageMetadata(response) && response.usageMetadata
              ? {
                  promptTokens: response.usageMetadata.promptTokenCount || 0,
                  completionTokens: response.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: response.usageMetadata.totalTokenCount || 0,
                }
              : undefined,
        },
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const originalError = error instanceof Error ? error : new Error(String(error));

      this.logger.error('Gemini image analysis failed');
      this.logger.debug('Gemini image analysis error', {
        processingTime,
        error: originalError.message,
        hasStack: !!originalError.stack,
      });

      throw new VisionError(
        `Gemini vision analysis failed: ${originalError.message}`,
        this.name,
        originalError
      );
    }
  }
}
