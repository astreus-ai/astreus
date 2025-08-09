import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';

export type ProviderType = 'openai' | 'claude' | 'gemini' | 'ollama';

// Create provider instances to get their supported models
function getProviderModels(): Record<ProviderType, string[]> {
  const providers: Record<ProviderType, string[]> = {
    openai: [],
    claude: [],
    gemini: [],
    ollama: [],
  };

  try {
    providers.openai = new OpenAIProvider().getSupportedModels();
  } catch {
    // Provider not available
  }

  try {
    providers.claude = new ClaudeProvider().getSupportedModels();
  } catch {
    // Provider not available
  }

  try {
    providers.gemini = new GeminiProvider().getSupportedModels();
  } catch {
    // Provider not available
  }

  try {
    providers.ollama = new OllamaProvider().getSupportedModels();
  } catch {
    // Provider not available
  }

  return providers;
}

// Create reverse lookup map
const MODEL_TO_PROVIDER: Record<string, ProviderType> = {};
let PROVIDER_MODELS: Record<ProviderType, string[]> = {
  openai: [],
  claude: [],
  gemini: [],
  ollama: [],
};

function initializeModelMappings() {
  if (Object.keys(MODEL_TO_PROVIDER).length === 0) {
    PROVIDER_MODELS = getProviderModels();

    Object.entries(PROVIDER_MODELS).forEach(([provider, models]) => {
      models.forEach((model) => {
        MODEL_TO_PROVIDER[model] = provider as ProviderType;
      });
    });
  }
}

export function getProviderForModel(model: string): ProviderType | null {
  initializeModelMappings();
  return MODEL_TO_PROVIDER[model] || null;
}

export function getSupportedModelsList(): string[] {
  initializeModelMappings();
  return Object.values(PROVIDER_MODELS).flat();
}

export function getModelsByProvider(provider: ProviderType): string[] {
  initializeModelMappings();
  return [...PROVIDER_MODELS[provider]];
}
