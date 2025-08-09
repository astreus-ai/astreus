import { ToolDefinition, ToolResult, ToolParameterValue } from '../plugin/types';
import { Vision } from './index';
import * as fs from 'fs';
import * as path from 'path';

interface AnalysisParams {
  image_path: string;
  prompt?: string;
  detail?: string;
}

interface DescriptionParams {
  image_path: string;
  style?: string;
}

interface ExtractTextParams {
  image_path: string;
  language?: string;
}

// Type guard functions for vision tool parameters
function isAnalysisParams(
  params: Record<string, ToolParameterValue>
): params is Record<string, ToolParameterValue> & AnalysisParams {
  return (
    typeof params.image_path === 'string' &&
    (params.prompt === undefined || typeof params.prompt === 'string') &&
    (params.detail === undefined || typeof params.detail === 'string')
  );
}

function isDescriptionParams(
  params: Record<string, ToolParameterValue>
): params is Record<string, ToolParameterValue> & DescriptionParams {
  return (
    typeof params.image_path === 'string' &&
    (params.style === undefined || typeof params.style === 'string')
  );
}

function isExtractTextParams(
  params: Record<string, ToolParameterValue>
): params is Record<string, ToolParameterValue> & ExtractTextParams {
  return (
    typeof params.image_path === 'string' &&
    (params.language === undefined || typeof params.language === 'string')
  );
}

export const analyzeImageTool: ToolDefinition = {
  name: 'analyze_image',
  description:
    'Analyze an image using computer vision to extract information, describe contents, read text, etc.',
  parameters: {
    image_path: {
      name: 'image_path',
      type: 'string',
      description: 'Path to the image file to analyze',
      required: true,
    },
    prompt: {
      name: 'prompt',
      type: 'string',
      description:
        'Specific analysis prompt (optional). If not provided, will do general image analysis',
    },
    detail: {
      name: 'detail',
      type: 'string',
      description: 'Analysis detail level: "low" or "high" (default: auto)',
    },
  },
  handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
    if (!isAnalysisParams(params)) {
      return {
        success: false,
        data: null,
        error: 'Invalid parameters for image analysis',
      };
    }

    const { image_path, prompt, detail } = params;

    try {
      // Validate and sanitize image path
      if (!image_path || typeof image_path !== 'string') {
        return {
          success: false,
          data: null,
          error: 'Invalid image path provided',
        };
      }

      // Resolve and normalize path to prevent traversal attacks
      const normalizedPath = path.resolve(path.normalize(image_path));
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!allowedExtensions.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}`,
        };
      }

      const visionService = new Vision();

      try {
        await fs.promises.access(normalizedPath);
      } catch {
        return {
          success: false,
          data: null,
          error: `Image file not found: ${normalizedPath}`,
        };
      }

      const analysis = await visionService.analyzeImage(normalizedPath, {
        prompt,
        detail: detail as 'low' | 'high',
        maxTokens: 1000,
      });

      const fileName = path.basename(normalizedPath);

      return {
        success: true,
        data: {
          fileName,
          filePath: normalizedPath,
          analysis,
          prompt: prompt || 'General image analysis',
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Image analysis failed: ${error}`,
      };
    }
  },
};

export const describeImageTool: ToolDefinition = {
  name: 'describe_image',
  description:
    'Generate a detailed description of an image for accessibility or documentation purposes',
  parameters: {
    image_path: {
      name: 'image_path',
      type: 'string',
      description: 'Path to the image file to describe',
      required: true,
    },
    style: {
      name: 'style',
      type: 'string',
      description: 'Description style: "detailed", "concise", "accessibility", or "technical"',
    },
  },
  handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
    if (!isDescriptionParams(params)) {
      return {
        success: false,
        data: null,
        error: 'Invalid parameters for image description',
      };
    }

    const { image_path, style = 'detailed' } = params;

    try {
      // Validate and sanitize image path
      if (!image_path || typeof image_path !== 'string') {
        return {
          success: false,
          data: null,
          error: 'Invalid image path provided',
        };
      }

      // Resolve and normalize path to prevent traversal attacks
      const normalizedPath = path.resolve(path.normalize(image_path));
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!allowedExtensions.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}`,
        };
      }

      const visionService = new Vision();

      try {
        await fs.promises.access(normalizedPath);
      } catch {
        return {
          success: false,
          data: null,
          error: `Image file not found: ${normalizedPath}`,
        };
      }

      const prompts = {
        detailed:
          'Provide a detailed description of this image, including all visual elements, colors, objects, people, text, and context.',
        concise: 'Provide a brief, concise description of the main elements in this image.',
        accessibility:
          'Create an accessibility-friendly description of this image for visually impaired users, focusing on the most important visual information.',
        technical:
          'Provide a technical analysis of this image including composition, lighting, objects, text, and any technical elements visible.',
      };

      const prompt = prompts[style as keyof typeof prompts] || prompts.detailed;

      const description = await visionService.analyzeImage(normalizedPath, {
        prompt,
        maxTokens: 800,
      });

      const fileName = path.basename(normalizedPath);

      return {
        success: true,
        data: {
          fileName,
          filePath: normalizedPath,
          style,
          description,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Image description failed: ${error}`,
      };
    }
  },
};

export const extractTextFromImageTool: ToolDefinition = {
  name: 'extract_text_from_image',
  description: 'Extract and transcribe text from an image using OCR capabilities',
  parameters: {
    image_path: {
      name: 'image_path',
      type: 'string',
      description: 'Path to the image file containing text',
      required: true,
    },
    language: {
      name: 'language',
      type: 'string',
      description: 'Expected language of the text (optional, helps with accuracy)',
    },
  },
  handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
    if (!isExtractTextParams(params)) {
      return {
        success: false,
        data: null,
        error: 'Invalid parameters for text extraction',
      };
    }

    const { image_path, language } = params;

    try {
      // Validate and sanitize image path
      if (!image_path || typeof image_path !== 'string') {
        return {
          success: false,
          data: null,
          error: 'Invalid image path provided',
        };
      }

      // Resolve and normalize path to prevent traversal attacks
      const normalizedPath = path.resolve(path.normalize(image_path));
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!allowedExtensions.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}`,
        };
      }

      const visionService = new Vision();

      try {
        await fs.promises.access(normalizedPath);
      } catch {
        return {
          success: false,
          data: null,
          error: `Image file not found: ${normalizedPath}`,
        };
      }

      const languageHint = language ? ` The text is likely in ${language}.` : '';
      const prompt = `Extract and transcribe all text from this image. Maintain the original formatting, line breaks, and structure as much as possible.${languageHint} Only return the extracted text, no additional commentary.`;

      const extractedText = await visionService.analyzeImage(normalizedPath, {
        prompt,
        maxTokens: 1500,
      });

      const fileName = path.basename(normalizedPath);

      return {
        success: true,
        data: {
          fileName,
          filePath: normalizedPath,
          language: language || 'auto-detect',
          extractedText,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Text extraction failed: ${error}`,
      };
    }
  },
};

// Function to create vision tools with a specific Vision instance
export function createVisionTools(visionInstance: Vision): ToolDefinition[] {
  const analyzeImageToolWithInstance: ToolDefinition = {
    ...analyzeImageTool,
    handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
      if (!isAnalysisParams(params)) {
        return {
          success: false,
          data: null,
          error: 'Invalid parameters for image analysis',
        };
      }

      const { image_path, prompt, detail } = params;

      try {
        // Validate and sanitize image path
        if (!image_path || typeof image_path !== 'string') {
          return {
            success: false,
            data: null,
            error: 'Invalid image path provided',
          };
        }

        // Resolve and normalize path to prevent traversal attacks
        const normalizedPath = path.resolve(path.normalize(image_path));
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!allowedExtensions.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}`,
          };
        }

        if (!fs.existsSync(normalizedPath)) {
          return {
            success: false,
            data: null,
            error: `Image file not found: ${normalizedPath}`,
          };
        }

        const analysis = await visionInstance.analyzeImage(normalizedPath, {
          prompt,
          detail: detail as 'low' | 'high',
          maxTokens: 1000,
        });

        const fileName = path.basename(normalizedPath);

        return {
          success: true,
          data: {
            fileName,
            filePath: normalizedPath,
            analysis,
            prompt: prompt || 'General image analysis',
          },
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          error: `Image analysis failed: ${error}`,
        };
      }
    },
  };

  const describeImageToolWithInstance: ToolDefinition = {
    ...describeImageTool,
    handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
      if (!isDescriptionParams(params)) {
        return {
          success: false,
          data: null,
          error: 'Invalid parameters for image description',
        };
      }

      const { image_path, style = 'detailed' } = params;

      try {
        // Validate and sanitize image path
        if (!image_path || typeof image_path !== 'string') {
          return {
            success: false,
            data: null,
            error: 'Invalid image path provided',
          };
        }

        // Resolve and normalize path to prevent traversal attacks
        const normalizedPath = path.resolve(path.normalize(image_path));
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!allowedExtensions.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}`,
          };
        }

        if (!fs.existsSync(normalizedPath)) {
          return {
            success: false,
            data: null,
            error: `Image file not found: ${normalizedPath}`,
          };
        }

        const prompts = {
          detailed:
            'Provide a detailed description of this image, including all visual elements, colors, objects, people, text, and context.',
          concise: 'Provide a brief, concise description of the main elements in this image.',
          accessibility:
            'Create an accessibility-friendly description of this image for visually impaired users, focusing on the most important visual information.',
          technical:
            'Provide a technical analysis of this image including composition, lighting, objects, text, and any technical elements visible.',
        };

        const prompt = prompts[style as keyof typeof prompts] || prompts.detailed;

        const description = await visionInstance.analyzeImage(normalizedPath, {
          prompt,
          maxTokens: 800,
        });

        const fileName = path.basename(normalizedPath);

        return {
          success: true,
          data: {
            fileName,
            filePath: normalizedPath,
            style,
            description,
          },
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          error: `Image description failed: ${error}`,
        };
      }
    },
  };

  const extractTextFromImageToolWithInstance: ToolDefinition = {
    ...extractTextFromImageTool,
    handler: async (params: Record<string, ToolParameterValue>): Promise<ToolResult> => {
      if (!isExtractTextParams(params)) {
        return {
          success: false,
          data: null,
          error: 'Invalid parameters for text extraction',
        };
      }

      const { image_path, language } = params;

      try {
        // Validate and sanitize image path
        if (!image_path || typeof image_path !== 'string') {
          return {
            success: false,
            data: null,
            error: 'Invalid image path provided',
          };
        }

        // Resolve and normalize path to prevent traversal attacks
        const normalizedPath = path.resolve(path.normalize(image_path));
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!allowedExtensions.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}`,
          };
        }

        if (!fs.existsSync(normalizedPath)) {
          return {
            success: false,
            data: null,
            error: `Image file not found: ${normalizedPath}`,
          };
        }

        const languageHint = language ? ` The text is likely in ${language}.` : '';
        const prompt = `Extract and transcribe all text from this image. Maintain the original formatting, line breaks, and structure as much as possible.${languageHint} Only return the extracted text, no additional commentary.`;

        const extractedText = await visionInstance.analyzeImage(normalizedPath, {
          prompt,
          maxTokens: 1500,
        });

        const fileName = path.basename(normalizedPath);

        return {
          success: true,
          data: {
            fileName,
            filePath: normalizedPath,
            language: language || 'auto-detect',
            extractedText,
          },
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          error: `Text extraction failed: ${error}`,
        };
      }
    },
  };

  return [
    analyzeImageToolWithInstance,
    describeImageToolWithInstance,
    extractTextFromImageToolWithInstance,
  ];
}

export const visionTools = [analyzeImageTool, describeImageTool, extractTextFromImageTool];
