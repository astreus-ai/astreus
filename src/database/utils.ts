import * as fs from 'fs';

/**
 * Simple token counting utility
 * This is a rough approximation - for production use, consider using tiktoken
 */
export function countTokens(text: string): number {
  // Simple estimation: 1 token ≈ 4 characters for English text
  // This is a rough approximation - actual tokenization depends on the model
  return Math.ceil(text.length / 4);
}

/**
 * More accurate word-based token estimation
 */
export function countTokensWordBased(text: string): number {
  const words = text.trim().split(/\s+/);
  // Rough estimation: 1 token ≈ 0.75 words
  return Math.ceil(words.length / 0.75);
}

/**
 * Get file size from file path
 */
export function getFileSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}
