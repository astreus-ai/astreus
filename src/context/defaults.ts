import { ContextCompressorOptions } from './types';

export const DEFAULT_CONTEXT_OPTIONS: ContextCompressorOptions = {
  maxContextLength: 8000,
  compressionRatio: 0.3,
  preserveLastN: 3,
  model: 'gpt-4o-mini',
  compressionStrategy: 'hybrid',
  enableSemanticCompression: true,
  preserveImportantContext: true,
};
