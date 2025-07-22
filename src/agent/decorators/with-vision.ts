import { BaseAgent } from '../base';
import { VisionService, AnalysisOptions } from '../../vision';

export function withVision(BaseClass: typeof BaseAgent) {
  class VisionAgent extends BaseClass {
    public visionService = new VisionService();

    constructor(data: any) {
      super(data);
    }

    async analyzeImage(imagePath: string, options?: AnalysisOptions): Promise<string> {
      return this.visionService.analyzeImage(imagePath, options);
    }

    async analyzeImageFromBase64(base64Image: string, options?: AnalysisOptions): Promise<string> {
      return this.visionService.analyzeImageFromBase64(base64Image, options);
    }

    async describeImage(imagePath: string, style: 'detailed' | 'concise' | 'accessibility' | 'technical' = 'detailed'): Promise<string> {
      const prompts = {
        detailed: 'Provide a detailed description of this image, including all visual elements, colors, objects, people, text, and context.',
        concise: 'Provide a brief, concise description of the main elements in this image.',
        accessibility: 'Create an accessibility-friendly description of this image for visually impaired users, focusing on the most important visual information.',
        technical: 'Provide a technical analysis of this image including composition, lighting, objects, text, and any technical elements visible.'
      };

      return this.visionService.analyzeImage(imagePath, {
        prompt: prompts[style],
        maxTokens: style === 'concise' ? 400 : 800
      });
    }

    async extractTextFromImage(imagePath: string, language?: string): Promise<string> {
      const languageHint = language ? ` The text is likely in ${language}.` : '';
      const prompt = `Extract and transcribe all text from this image. Maintain the original formatting, line breaks, and structure as much as possible.${languageHint} Only return the extracted text, no additional commentary.`;
      
      return this.visionService.analyzeImage(imagePath, {
        prompt,
        maxTokens: 1500
      });
    }
  }
  
  return VisionAgent;
}