export type ProviderType = 'openai' | 'claude' | 'gemini' | 'ollama';

type ModelTransport = 'responses' | 'chat-completions' | 'messages' | 'gemini' | 'ollama';

export interface ModelDefinition {
  readonly id: string;
  readonly provider: ProviderType;
  readonly transport: ModelTransport;
  readonly gateway?: 'compatible' | 'openrouter';
  readonly supportsTemperature?: boolean;
  readonly maxOutputTokens?: number;
}

// Discovery is deliberately static and credential-independent. Gateway entries use
// the existing OpenAI-compatible adapter, not a fifth provider or a paid fallback.
const OPENAI_MODELS: readonly ModelDefinition[] = [
  ...[
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
  ].map(
    (id): ModelDefinition => ({
      id,
      provider: 'openai',
      transport: 'responses',
      supportsTemperature: false,
      maxOutputTokens: 128000,
    })
  ),
  ...['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'].map(
    (id): ModelDefinition => ({
      id,
      provider: 'openai',
      transport: 'responses',
      supportsTemperature: true,
    })
  ),
  ...['o4-mini', 'o3'].map(
    (id): ModelDefinition => ({
      id,
      provider: 'openai',
      transport: 'responses',
      supportsTemperature: false,
    })
  ),
  ...['gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'gpt-3.5-turbo-16k'].map(
    (id): ModelDefinition => ({
      id,
      provider: 'openai',
      transport: 'chat-completions',
      supportsTemperature: true,
    })
  ),
  {
    id: 'openai/gpt-5.4-mini',
    provider: 'openai',
    transport: 'chat-completions',
    gateway: 'compatible',
    supportsTemperature: false,
  },
  ...[
    'openrouter/free',
    'nvidia/nemotron-3.5-lightning:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
  ].map(
    (id): ModelDefinition => ({
      id,
      provider: 'openai',
      transport: 'chat-completions',
      gateway: 'openrouter',
      supportsTemperature: true,
    })
  ),
];

const CLAUDE_MODELS: readonly ModelDefinition[] = [
  ...['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'].map(
    (id): ModelDefinition => ({
      id,
      provider: 'claude',
      transport: 'messages',
      supportsTemperature: false,
      maxOutputTokens: 128000,
    })
  ),
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'claude',
    transport: 'messages',
    supportsTemperature: true,
    maxOutputTokens: 64000,
  },
];

// Other adapters retain their existing catalogue and defaults in this refresh.
const GEMINI_MODELS = [
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

const OLLAMA_MODELS = [
  'deepseek-r1',
  'deepseek-v3',
  'deepseek-v2.5',
  'deepseek-coder',
  'deepseek-coder-v2',
  'qwen3',
  'qwen2.5-coder',
  'llama3.3',
  'gemma3',
  'phi4',
  'mistral-small',
  'codellama',
  'llama3.2',
  'llama3.1',
  'llama3',
  'qwen2.5',
  'gemma2',
  'phi3',
  'mistral',
  'codegemma',
  'wizardlm2',
  'dolphin-mistral',
  'openhermes',
  'deepcoder',
  'stable-code',
  'wizardcoder',
  'magicoder',
  'solar',
  'yi',
  'zephyr',
  'orca-mini',
  'vicuna',
];

const PROVIDER_MODELS: Record<ProviderType, readonly ModelDefinition[]> = {
  openai: OPENAI_MODELS,
  claude: CLAUDE_MODELS,
  gemini: GEMINI_MODELS.map((id) => ({ id, provider: 'gemini', transport: 'gemini' })),
  ollama: OLLAMA_MODELS.map((id) => ({ id, provider: 'ollama', transport: 'ollama' })),
};

const VISION_MODELS: Record<ProviderType, readonly string[]> = {
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ],
  claude: CLAUDE_MODELS.map(({ id }) => id),
  gemini: [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.0-pro-vision-latest',
    'gemini-pro-vision',
  ],
  ollama: [
    'llava',
    'llava:7b',
    'llava:13b',
    'llava:34b',
    'llava-llama3',
    'llava-phi3',
    'moondream',
  ],
};

const EMBEDDING_MODELS: Record<ProviderType, readonly string[]> = {
  openai: ['text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002'],
  claude: [],
  gemini: ['text-embedding-004', 'embedding-001'],
  ollama: ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'],
};

const MODELS = new Map(
  Object.values(PROVIDER_MODELS)
    .flat()
    .map((model) => [model.id, Object.freeze(model)])
);

export function getModelDefinition(model: string): ModelDefinition | undefined {
  return MODELS.get(model);
}

export function getProviderForModel(model: string): ProviderType | null {
  const registered = getModelDefinition(model);
  if (registered) return registered.provider;

  for (const provider of Object.keys(PROVIDER_MODELS) as ProviderType[]) {
    if (VISION_MODELS[provider].includes(model) || EMBEDDING_MODELS[provider].includes(model)) {
      return provider;
    }
  }

  // Ollama tags are local versions, never namespaced hosted gateway routes.
  if (!model.includes('/') && model.includes(':')) {
    const base = model.split(':')[0];
    if (getProviderForModel(base) === 'ollama') return 'ollama';
  }
  return null;
}

export function getSupportedModelsList(): string[] {
  return Object.values(PROVIDER_MODELS)
    .flat()
    .map(({ id }) => id);
}

export function getModelsByProvider(provider: ProviderType): string[] {
  return PROVIDER_MODELS[provider].map(({ id }) => id);
}

export function getVisionModelsByProvider(provider: ProviderType): string[] {
  return [...VISION_MODELS[provider]];
}

export function getEmbeddingModelsByProvider(provider: ProviderType): string[] {
  return [...EMBEDDING_MODELS[provider]];
}
