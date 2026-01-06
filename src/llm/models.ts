import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';

export type ProviderType = 'openai' | 'claude' | 'gemini' | 'ollama';

// Cache for provider models to avoid creating new instances on every call
let cachedProviderModels: Record<ProviderType, string[]> | null = null;

// Mutex for thread-safe initialization
let initializationPromise: Promise<Record<ProviderType, string[]>> | null = null;

// Create provider instances to get their supported models (cached with proper mutex)
function getProviderModels(): Record<ProviderType, string[]> {
  // Return cached result if available (fast path)
  if (cachedProviderModels !== null) {
    return cachedProviderModels;
  }

  // Synchronous fallback - create providers on demand
  // This is safe because getSupportedModels() is synchronous
  const providers: Record<ProviderType, string[]> = {
    openai: [],
    claude: [],
    gemini: [],
    ollama: [],
  };

  // Silently try to load providers - missing API keys are expected behavior
  // Users only need API keys for providers they actually use
  try {
    providers.openai = new OpenAIProvider().getSupportedModels();
  } catch {
    // OpenAI provider not available - API key may not be configured
  }

  try {
    providers.claude = new ClaudeProvider().getSupportedModels();
  } catch {
    // Claude provider not available - API key may not be configured
  }

  try {
    providers.gemini = new GeminiProvider().getSupportedModels();
  } catch {
    // Gemini provider not available - API key may not be configured
  }

  try {
    providers.ollama = new OllamaProvider().getSupportedModels();
  } catch {
    // Ollama provider not available - Ollama may not be running
  }

  // Cache the result
  cachedProviderModels = providers;
  return providers;
}

// Async initialization with proper mutex to prevent race conditions
async function getProviderModelsAsync(): Promise<Record<ProviderType, string[]>> {
  // Return cached result if available (fast path)
  if (cachedProviderModels !== null) {
    return cachedProviderModels;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise !== null) {
    return initializationPromise;
  }

  // Start initialization with mutex
  initializationPromise = (async () => {
    try {
      // Double-check after acquiring "lock"
      if (cachedProviderModels !== null) {
        return cachedProviderModels;
      }

      const result = getProviderModels();
      return result;
    } finally {
      // Clear the promise after initialization completes
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// Create reverse lookup map
const MODEL_TO_PROVIDER: Record<string, ProviderType> = {};
let PROVIDER_MODELS: Record<ProviderType, string[]> = {
  openai: [],
  claude: [],
  gemini: [],
  ollama: [],
};

// Mutex promise for atomic initialization
let initializationMutex: Promise<void> | null = null;
let isInitialized = false;

function initializeModelMappings() {
  // Fast path: already initialized
  if (isInitialized) {
    return;
  }

  // Use synchronous initialization with proper guard
  // The Promise-based mutex is for async scenarios
  if (initializationMutex !== null) {
    // Another initialization is in progress, wait would be async
    // For sync call, just return - the data will be populated by the other caller
    return;
  }

  // Set flag immediately to prevent concurrent entries
  isInitialized = true;

  try {
    PROVIDER_MODELS = getProviderModels();

    Object.entries(PROVIDER_MODELS).forEach(([provider, models]) => {
      models.forEach((model) => {
        MODEL_TO_PROVIDER[model] = provider as ProviderType;
      });
    });
  } catch (error) {
    // Reset flag on error so retry is possible
    isInitialized = false;
    throw error;
  }
}

// Async version with proper mutex for concurrent scenarios
// Exported for use in async initialization contexts (e.g., server startup)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function initializeModelMappingsAsync(): Promise<void> {
  // Fast path: already initialized
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationMutex !== null) {
    return initializationMutex;
  }

  // Start initialization with mutex
  initializationMutex = (async () => {
    try {
      // Double-check after acquiring mutex
      if (isInitialized) {
        return;
      }

      PROVIDER_MODELS = await getProviderModelsAsync();

      Object.entries(PROVIDER_MODELS).forEach(([provider, models]) => {
        models.forEach((model) => {
          MODEL_TO_PROVIDER[model] = provider as ProviderType;
        });
      });

      isInitialized = true;
    } finally {
      initializationMutex = null;
    }
  })();

  return initializationMutex;
}

// Model name patterns for fallback provider detection
const MODEL_MAPPINGS: Record<ProviderType, string[]> = {
  openai: ['gpt', 'o1', 'davinci', 'curie', 'babbage', 'ada', 'text-embedding'],
  claude: ['claude'],
  gemini: ['gemini'],
  ollama: ['llama', 'mistral', 'codellama', 'vicuna', 'orca', 'phi'],
};

export function getProviderForModel(model: string): ProviderType | null {
  initializeModelMappings();

  // First check exact model mappings from providers
  if (MODEL_TO_PROVIDER[model]) {
    return MODEL_TO_PROVIDER[model];
  }

  // Then check model name patterns
  const modelLower = model.toLowerCase();
  for (const [provider, patterns] of Object.entries(MODEL_MAPPINGS)) {
    if (patterns.some((p) => modelLower.includes(p.toLowerCase()))) {
      return provider as ProviderType;
    }
  }

  // Fallback to additional pattern matching
  if (modelLower.includes('gpt') || modelLower.includes('o1')) return 'openai';
  if (modelLower.includes('claude')) return 'claude';
  if (modelLower.includes('gemini')) return 'gemini';
  if (modelLower.includes('llama') || modelLower.includes('mistral')) return 'ollama';

  return null;
}

export function getSupportedModelsList(): string[] {
  initializeModelMappings();
  return Object.values(PROVIDER_MODELS).flat();
}

export function getModelsByProvider(provider: ProviderType): string[] {
  initializeModelMappings();
  return [...PROVIDER_MODELS[provider]];
}
