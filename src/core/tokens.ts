import type { FileClass } from './types.js';

/**
 * Rough token estimation, tuned for source code and structured data.
 * ASCII-dominant text averages ~4 chars/token; JSON/YAML/TOML with lots of
 * punctuation averages closer to ~3 chars/token, so dense formats get a bump.
 */
const DENSE_CLASSES: ReadonlySet<FileClass> = new Set(['config', 'data', 'generated']);

export function estimateTokensFromBytes(bytes: number, fileClass: FileClass): number {
  if (bytes <= 0) return 0;
  if (DENSE_CLASSES.has(fileClass)) return Math.ceil(bytes / 3);
  return Math.ceil(bytes / 4);
}

/** Estimate tokens for an in-memory string (used for generated artifacts). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const ascii = text.length;
  return Math.ceil(ascii / 4);
}
