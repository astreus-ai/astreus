import { logger } from "./logger";
import { ProviderModel } from "../types";

interface AnalyzeMediaParams {
  filePath?: string;
  url?: string;
  base64Data?: string;
  prompt?: string;
  analysisType?: 'general' | 'detailed' | 'ocr' | 'document_analysis';
  sessionId?: string;
  metadata?: Record<string, unknown>;
  addToMemory?: boolean;
}

interface AnalyzeImageParams {
  imagePath?: string;
  imageUrl?: string;
  base64Data?: string;
  prompt?: string;
  detail?: 'low' | 'high' | 'auto';
  sessionId?: string;
  addToMemory?: boolean;
}

interface AnalyzeDocumentParams {
  filePath?: string;
  url?: string;
  prompt?: string;
  sessionId?: string;
  addToMemory?: boolean;
}

interface AnalyzeWithContextParams {
  filePath?: string;
  url?: string;
  base64Data?: string;
  context: string;
  sessionId?: string;
  addToMemory?: boolean;
}

interface AnalyzeContext {
  agentName: string;
  agentId: string;
  model: ProviderModel;
  memory?: {
    add: (addParams: {
      agentId: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      metadata?: Record<string, unknown>;
    }) => Promise<string>;
  } | null;
}

export async function analyzeMedia(
  params: AnalyzeMediaParams,
  context: AnalyzeContext
): Promise<{
  type: string;
  content: string;
  analysis: string;
  metadata?: any;
}> {
  try {
    logger.info(context.agentName, "Analyze", "Starting media analysis");
    
    // Get the provider (assuming it's OpenAI for now)
    const model = context.model;
    if (!model || typeof (model as any).analyzeMedia !== 'function') {
      throw new Error("Media analysis not supported by current model provider");
    }

    const result = await (model as any).analyzeMedia(
      params.filePath,
      params.url,
      params.base64Data,
      params.prompt,
      { detail: params.analysisType === 'detailed' ? 'high' : 'auto' }
    );

    // Store in memory if session ID provided and addToMemory is true (default true)
    if (params.sessionId && context.memory && (params.addToMemory !== false)) {
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "user",
        content: `Media analysis request: ${params.filePath || params.url || 'base64 data'} - ${params.prompt || 'Analyze the media'}`
      });
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "assistant",
        content: `I analyzed ${params.filePath || params.url || 'the media'} file. Result: "${result}"`
      });
    }

    logger.success(context.agentName, "Analyze", "Media analysis completed");
    return result;
  } catch (error) {
    logger.error(context.agentName, "Analyze", `Media analysis failed: ${error}`);
    throw error;
  }
}

export async function analyzeImage(
  params: AnalyzeImageParams,
  context: AnalyzeContext
): Promise<string> {
  try {
    logger.info(context.agentName, "Analyze", "Starting image analysis");
    
    const model = context.model;
    if (!model || typeof (model as any).analyzeImage !== 'function') {
      throw new Error("Image analysis not supported by current model provider");
    }

    const result = await (model as any).analyzeImage(
      params.imagePath,
      params.imageUrl,
      params.base64Data,
      params.prompt,
      params.detail || 'auto'
    );

    // Store in memory if session ID provided and addToMemory is true (default true)
    if (params.sessionId && context.memory && (params.addToMemory !== false)) {
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "user",
        content: `Image analysis request: ${params.imagePath || params.imageUrl || 'base64 data'} - ${params.prompt || 'Analyze this image'}`
      });
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "assistant",
        content: `I analyzed ${params.imagePath || params.imageUrl || 'the image'}. Result: "${result}"`
      });
    }

    logger.success(context.agentName, "Analyze", "Image analysis completed");
    return result;
  } catch (error) {
    logger.error(context.agentName, "Analyze", `Image analysis failed: ${error}`);
    throw error;
  }
}

export async function analyzeDocument(
  params: AnalyzeDocumentParams,
  context: AnalyzeContext
): Promise<{ text: string; analysis: string; metadata?: any }> {
  let tempFilePath: string | undefined;
  
  try {
    logger.info(context.agentName, "Analyze", "Starting document analysis");
    
    // Validate that either filePath or url is provided
    if (!params.filePath && !params.url) {
      throw new Error("Either filePath or url must be provided for document analysis");
    }
    
    const model = context.model;
    if (!model || typeof (model as any).analyzeDocument !== 'function') {
      throw new Error("Document analysis not supported by current model provider");
    }

    let pathToAnalyze = params.filePath;
    
    // If URL is provided, download the PDF temporarily
    if (params.url && !params.filePath) {
      logger.info(context.agentName, "Analyze", `Downloading PDF from URL: ${params.url}`);
      try {
        const https = await import('https');
        const http = await import('http');
        const path = await import('path');
        const os = await import('os');
        
        // Create temp file path
        const tempDir = os.tmpdir();
        tempFilePath = path.join(tempDir, `astreus-temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.pdf`);
        
        // Download file
        const protocol = params.url.startsWith('https') ? https : http;
        
        const fs = await import('fs');
        await new Promise<void>((resolve, reject) => {
          const file = fs.createWriteStream(tempFilePath!);
          protocol.get(params.url!, (response) => {
            if (response.statusCode !== 200) {
              reject(new Error(`Failed to download PDF: HTTP ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          }).on('error', reject);
        });
        
        pathToAnalyze = tempFilePath;
        logger.success(context.agentName, "Analyze", `PDF downloaded to temporary file: ${tempFilePath}`);
      } catch (error) {
        logger.error(context.agentName, "Analyze", `Failed to download PDF from URL: ${error}`);
        throw new Error(`Failed to download PDF from URL: ${error}`);
      }
    }

    const result = await (model as any).analyzeDocument(pathToAnalyze, params.prompt);

    // Store in memory if session ID provided and addToMemory is true (default true)
    if (params.sessionId && context.memory && (params.addToMemory !== false)) {
      const fileReference = params.url || params.filePath || 'document';
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "user",
        content: `Analyze the file ${fileReference}: ${params.prompt || 'Analyze the PDF document'}`
      });
      
      // Get PDF metadata if available
      let metadata = '';
      try {
        const fs = await import('fs/promises');
        const { PDFDocument } = await import('pdf-lib');
        const pdfBuffer = await fs.readFile(pathToAnalyze!);
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        metadata = `PDF information: ${pdfDoc.getPageCount()} pages, Title: "${pdfDoc.getTitle() || 'Unknown'}", Author: "${pdfDoc.getAuthor() || 'Unknown'}"`;
      } catch {
        metadata = 'PDF metadata could not be read';
      }
      
      await context.memory.add({
        agentId: context.agentId,
        sessionId: params.sessionId,
        role: "assistant",
        content: `I successfully analyzed the file ${fileReference}. ${metadata}. Extracted text: "${result.text.slice(0, 500)}...". Detailed analysis: "${result.analysis.slice(0, 500)}..."`
      });
    }

    // Clean up temporary file if created
    if (tempFilePath) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(tempFilePath);
        logger.debug(context.agentName, "Analyze", `Temporary file cleaned up: ${tempFilePath}`);
      } catch (error) {
        logger.warn(context.agentName, "Analyze", `Failed to clean up temporary file: ${error}`);
      }
    }

    logger.success(context.agentName, "Analyze", "Document analysis completed");
    return result;
  } catch (error) {
    // Clean up temporary file in case of error
    if (tempFilePath) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        logger.warn(context.agentName, "Analyze", `Failed to clean up temporary file after error: ${cleanupError}`);
      }
    }
    logger.error(context.agentName, "Analyze", `Document analysis failed: ${error}`);
    throw error;
  }
}

export async function analyzeWithContext(
  params: AnalyzeWithContextParams,
  context: AnalyzeContext & { chat: (chatParams: any) => Promise<string> }
): Promise<string> {
  try {
    logger.info(context.agentName, "Analyze", "Starting contextual media analysis");
    
    const mediaResult = await analyzeMedia({
      filePath: params.filePath,
      url: params.url,
      base64Data: params.base64Data,
      sessionId: params.sessionId,
      addToMemory: params.addToMemory
    }, context);

    // Create a contextual prompt
    const contextualPrompt = `
Context: ${params.context}

Media Analysis: ${mediaResult.analysis}

Based on the context and the media analysis above, provide a comprehensive response that addresses the context while incorporating insights from the media.
    `;

    // Use the regular chat method for contextual analysis
    const response = await context.chat({
      message: contextualPrompt,
      sessionId: params.sessionId,
      metadata: { type: 'contextual_media_analysis' }
    });

    logger.success(context.agentName, "Analyze", "Contextual media analysis completed");
    return response;
  } catch (error) {
    logger.error(context.agentName, "Analyze", `Contextual media analysis failed: ${error}`);
    throw error;
  }
}