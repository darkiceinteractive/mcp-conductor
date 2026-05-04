/**
 * Exponential backoff retry logic.
 *
 * Wraps an async operation, retrying on retryable failures with exponentially
 * increasing delays up to a configurable ceiling. Mutations (tools matching
 * _create/_update/_delete patterns) receive retries=0 by default via the
 * profile resolution layer — this module does not re-apply that guard, it
 * simply honours whatever `retries` value arrives in options.
 */

import { RetryExhaustedError, isRetryable } from './errors.js';

export interface RetryOptions {
  /** Number of additional attempts after the first failure (0 = no retries) */
  retries: number;
  /** Initial delay in ms before the first retry */
  retryDelayMs: number;
  /** Maximum delay ceiling in ms */
  retryMaxDelayMs: number;
  /** Server name for error context */
  server: string;
  /** Tool name for error context */
  tool: string;
  /**
   * Optional sleep function — injectable for tests to avoid real delays.
   * Defaults to a real setTimeout-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute `fn` with exponential backoff retries.
 *
 * Attempt sequence: 1 (initial) + up to `retries` additional attempts.
 * Delay sequence: retryDelayMs, retryDelayMs*2, retryDelayMs*4, …, capped at retryMaxDelayMs.
 *
 * Only errors for which `isRetryable(err)` returns true are retried.
 * Non-retryable errors propagate immediately without consuming retry budget.
 *
 * Throws RetryExhaustedError if all attempts fail on retryable errors.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, retryDelayMs, retryMaxDelayMs, server, tool } = options;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  let delay = retryDelayMs;

  // Total attempts = 1 initial + retries
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-retryable errors propagate immediately
      if (!isRetryable(err)) {
        throw err;
      }

      // Exhausted all attempts
      if (attempt === maxAttempts) {
        break;
      }

      // Wait before next attempt with exponential backoff
      await sleep(delay);
      delay = Math.min(delay * 2, retryMaxDelayMs);
    }
  }

  throw new RetryExhaustedError(server, tool, maxAttempts, lastError);
}
