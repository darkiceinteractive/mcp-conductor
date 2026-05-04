/**
 * mcp.budget — Token budget enforcement helper
 *
 * Wraps an async function call and automatically trims the result to fit
 * within a token budget. If the result cannot be trimmed below the budget,
 * throws BudgetExceededError.
 *
 * Token estimation: 1 token ≈ 4 characters (conservative heuristic,
 * same as summarize.ts).
 *
 * @module runtime/helpers/budget
 */

import { compact } from './compact.js';
import { summarize } from './summarize.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  readonly estimatedTokens: number;
  readonly maxTokens: number;

  constructor(estimatedTokens: number, maxTokens: number) {
    super(
      `Result exceeds token budget after trimming: estimated ${estimatedTokens} tokens, budget ${maxTokens} tokens`,
    );
    this.name = 'BudgetExceededError';
    this.estimatedTokens = estimatedTokens;
    this.maxTokens = maxTokens;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

export function estimateTokens(data: unknown): number {
  try {
    const serialized = JSON.stringify(data) ?? String(data);
    return Math.ceil(serialized.length / CHARS_PER_TOKEN);
  } catch {
    return Math.ceil(String(data).length / CHARS_PER_TOKEN);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trimming strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to trim `data` to fit within `maxTokens`.
 * Strategy:
 *   1. Try compact with progressive maxItems reduction (100 → 50 → 20 → 5)
 *   2. Try summarize (list → paragraph)
 *   3. If still over budget, throw BudgetExceededError
 */
function tryTrim(data: unknown, maxTokens: number): unknown {
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // Step 1: progressive compact on arrays
  if (Array.isArray(data)) {
    for (const maxItems of [100, 50, 20, 10, 5, 1]) {
      const trimmed = compact(data, { maxItems, maxStringLength: 200 });
      if (estimateTokens(trimmed) <= maxTokens) return trimmed;
    }
  }

  // Step 2: compact objects with depth restriction
  if (typeof data === 'object' && data !== null) {
    for (const maxDepth of [5, 3, 2, 1]) {
      const trimmed = compact(data, { maxDepth, maxItems: 20, maxStringLength: 200 });
      if (estimateTokens(trimmed) <= maxTokens) return trimmed;
    }
  }

  // Step 3: summarize as list
  const listSummary = summarize(data, { maxTokens, style: 'list' });
  if (estimateTokens(listSummary) <= maxTokens) return listSummary;

  // Step 4: summarize as paragraph (more aggressive)
  const paraSummary = summarize(data, { maxTokens, style: 'paragraph' });
  if (estimateTokens(paraSummary) <= maxTokens) return paraSummary;

  // Step 5: raw string clip
  const raw = typeof data === 'string' ? data : JSON.stringify(data) ?? String(data);
  const clipped = raw.slice(0, maxChars - 1) + '…';
  if (estimateTokens(clipped) <= maxTokens) return clipped;

  // Untrimmable
  throw new BudgetExceededError(estimateTokens(data), maxTokens);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `fn` and auto-trim its return value to fit within `maxTokens`.
 * Throws `BudgetExceededError` if the result cannot be trimmed.
 *
 * @example
 * const result = await budget(500, async () => mcp.github.list_issues({ repo: 'foo' }));
 */
export async function budget<T>(maxTokens: number, fn: () => T | Promise<T>): Promise<T> {
  const result = await fn();
  const estimated = estimateTokens(result);

  if (estimated <= maxTokens) {
    return result;
  }

  return tryTrim(result, maxTokens) as T;
}
