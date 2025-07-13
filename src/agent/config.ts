// Agent-related constants
export const DEFAULT_AGENT_NAME = 'astreus-agent';
export const DEFAULT_MODEL = process.env.MODEL_NAME || process.env.DEFAULT_MODEL || 'gpt-4o-mini';
export const DEFAULT_TEMPERATURE = parseFloat(process.env.TEMPERATURE || '0.3');
export const DEFAULT_MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '4096');