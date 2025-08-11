import { ContextCompressorOptions } from './types';

export const DEFAULT_CONTEXT_OPTIONS: ContextCompressorOptions = {
  maxContextLength: parseInt(process.env.ASTREUS_MAX_CONTEXT_LENGTH || '8000'),
  compressionRatio: parseFloat(process.env.ASTREUS_COMPRESSION_RATIO || '0.3'),
  preserveLastN: parseInt(process.env.ASTREUS_PRESERVE_LAST_N || '5'),
  model: process.env.ASTREUS_COMPRESSION_MODEL || 'gpt-4o-mini',
  compressionStrategy: 'hybrid',
  enableSemanticCompression: true,
  preserveImportantContext: true,
};
