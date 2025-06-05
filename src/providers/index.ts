export { OpenAIProvider, createOpenAIConfig } from "./openai";

export { OllamaProvider, createOllamaConfig } from "./ollama";

export { Embedding } from "./embedding";

import { ProviderType, ProviderInstance, ProviderModel } from '../types/provider';
import { OpenAIModelConfig } from '../types/provider';
import { OllamaModelConfig } from '../types/provider';

import { OpenAIProvider, createOpenAIConfig } from './openai';
import { OllamaProvider, createOllamaConfig } from './ollama';

export const createProvider = (config: Record<string, unknown>): ProviderInstance => {
  if (config.type === 'openai') {
    
    return {
      type: 'openai' as ProviderType,
      
      
      listModels(): string[] {
        
        return (config.models as string[]) || [config.model as string || 'gpt-3.5-turbo'];
      },
      
      
      getModel(name: string): ProviderModel {
        const modelConfig = createOpenAIConfig(name, config as Partial<OpenAIModelConfig>);
        return new OpenAIProvider('openai', modelConfig);
      },
      
      
      getDefaultModel(): string {
        return config.model as string || 'gpt-3.5-turbo';
      },
      
      
      getEmbeddingModel(): string {
        return config.embeddingModel as string || 'text-embedding-3-small';
      },

      // Add generateEmbedding method for RAG support
      async generateEmbedding(text: string): Promise<number[] | null> {
        try {
          const { Embedding } = await import('./embedding');
          const embeddingModel = config.embeddingModel as string || 'text-embedding-3-small';
          return await Embedding.generateEmbedding(text, embeddingModel);
        } catch (error) {
          console.error('Error generating embedding:', error);
          return null;
        }
      }
    };
  } else if (config.type === 'ollama') {
    
    return {
      type: 'ollama' as ProviderType,
      
      listModels(): string[] {
        return (config.models as string[]) || [config.model as string || 'llama2'];
      },
      
      getModel(name: string): ProviderModel {
        
        const ollamaConfigBase = {
          name: name,
          ...config as Record<string, unknown>
        };
        
        const ollamaConfig = createOllamaConfig 
          ? createOllamaConfig(name, config as Partial<OllamaModelConfig>) 
          : ollamaConfigBase as OllamaModelConfig;
          
        return new OllamaProvider('ollama', ollamaConfig);
      },
      
      getDefaultModel(): string {
        return config.model as string || 'llama2';
      }
    };
  } else {
    throw new Error(`Unknown provider type: ${config.type}`);
  }
}; 