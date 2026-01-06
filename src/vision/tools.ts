import { ToolDefinition, ToolResult, ToolParameterValue } from '../plugin/types';
import { Vision, ALLOWED_IMAGE_EXTENSIONS } from './index';
import * as fs from 'fs';
import * as path from 'path';

// Agent-based Vision instances with proper lifecycle management
// Instances are stored with timestamps for TTL-based cleanup
interface VisionInstanceEntry {
  instance: Vision;
  lastAccessed: number;
}

const visionInstances = new Map<string, VisionInstanceEntry>();
const INSTANCE_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic cleanup timer if not already running
 */
function ensureCleanupTimer(): void {
  if (cleanupIntervalId === null) {
    cleanupIntervalId = setInterval(
      () => {
        const now = Date.now();
        for (const [key, entry] of visionInstances.entries()) {
          if (now - entry.lastAccessed > INSTANCE_TTL_MS) {
            visionInstances.delete(key);
          }
        }
        // Stop timer if no instances remain
        if (visionInstances.size === 0 && cleanupIntervalId !== null) {
          clearInterval(cleanupIntervalId);
          cleanupIntervalId = null;
        }
      },
      5 * 60 * 1000
    ); // Check every 5 minutes
    // Allow Node.js to exit even if timer is running
    if (cleanupIntervalId.unref) {
      cleanupIntervalId.unref();
    }
  }
}

export function getVision(agentId?: string): Vision {
  const key = agentId || 'default';
  const entry = visionInstances.get(key);

  if (entry) {
    // Update last accessed time
    entry.lastAccessed = Date.now();
    return entry.instance;
  }

  // Create new instance
  const newInstance = new Vision();
  visionInstances.set(key, {
    instance: newInstance,
    lastAccessed: Date.now(),
  });

  // Start cleanup timer
  ensureCleanupTimer();

  return newInstance;
}

export function cleanupVision(agentId?: string): void {
  const key = agentId || 'default';
  visionInstances.delete(key);
}

/**
 * Cleanup all vision instances - call during shutdown
 */
export function cleanupAllVisionInstances(): void {
  visionInstances.clear();
  if (cleanupIntervalId !== null) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

// Valid detail levels for image analysis
const VALID_DETAIL_LEVELS = ['low', 'high'] as const;
type DetailLevel = (typeof VALID_DETAIL_LEVELS)[number];

function validateDetail(detail: string | undefined): DetailLevel | undefined {
  if (!detail) return undefined;
  return VALID_DETAIL_LEVELS.includes(detail as DetailLevel) ? (detail as DetailLevel) : 'low';
}

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
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
        };
      }

      const visionService = getVision();

      try {
        await fs.promises.access(normalizedPath);
      } catch {
        return {
          success: false,
          data: null,
          error: `Image file not found: ${normalizedPath}`,
        };
      }

      // Validate detail level - default to 'low' if invalid
      const safeDetail = validateDetail(detail);

      const analysis = await visionService.analyzeImage(normalizedPath, {
        prompt,
        detail: safeDetail,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `Image analysis failed: ${errorMessage}`,
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
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
        };
      }

      const visionService = getVision();

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `Image description failed: ${errorMessage}`,
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
      const fileExtension = path.extname(normalizedPath).toLowerCase();

      if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
        return {
          success: false,
          data: null,
          error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
        };
      }

      const visionService = getVision();

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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `Text extraction failed: ${errorMessage}`,
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
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
          };
        }

        if (!fs.existsSync(normalizedPath)) {
          return {
            success: false,
            data: null,
            error: `Image file not found: ${normalizedPath}`,
          };
        }

        // Validate detail level - default to undefined if not 'low' or 'high'
        const safeDetail = detail === 'low' || detail === 'high' ? detail : undefined;

        const analysis = await visionInstance.analyzeImage(normalizedPath, {
          prompt,
          detail: safeDetail,
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          data: null,
          error: `Image analysis failed: ${errorMessage}`,
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
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          data: null,
          error: `Image description failed: ${errorMessage}`,
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
        const fileExtension = path.extname(normalizedPath).toLowerCase();

        if (!ALLOWED_IMAGE_EXTENSIONS.includes(fileExtension)) {
          return {
            success: false,
            data: null,
            error: `Unsupported image format: ${fileExtension}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          data: null,
          error: `Text extraction failed: ${errorMessage}`,
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
