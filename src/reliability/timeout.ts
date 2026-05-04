/**
 * Timeout enforcement via Promise.race + AbortSignal.
 *
 * Wraps an async function with a deadline. If the function does not resolve
 * within timeoutMs, the promise rejects with TimeoutError and — where the
 * caller supports it — signals cancellation via AbortSignal.
 *
 * AbortController integration is forward-compatible with Phase 4 bridge changes
 * that will accept AbortSignal directly.
 */

import { TimeoutError } from './errors.js';

export interface TimeoutOptions {
  /** Deadline in milliseconds */
  timeoutMs: number;
  /** Server name for error context */
  server: string;
  /** Tool name for error context */
  tool: string;
  /** Attempt number (1-based) for error context */
  attempt?: number;
}

/**
 * Run `fn` with an AbortSignal, rejecting with TimeoutError if it exceeds
 * timeoutMs. The AbortSignal is passed to `fn` so callers that support
 * cancellation (Phase 4 bridge) can abort the underlying operation.
 *
 * Fast calls that resolve before the deadline are unaffected.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const { timeoutMs, server, tool, attempt = 1 } = options;

  const controller = new AbortController();
  const { signal } = controller;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(server, tool, timeoutMs, attempt));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(signal), timeoutPromise]);
    return result;
  } finally {
    // Always clear the timer — prevents leaks on fast success or non-timeout errors
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // If the operation finished (success or non-timeout error) before the
    // deadline, abort the signal so any in-progress I/O can clean up.
    if (!signal.aborted) {
      controller.abort();
    }
  }
}

/**
 * Convenience overload for callers that do not need AbortSignal forwarding.
 * Wraps a zero-argument async factory in a signal-aware shim.
 */
export async function withTimeoutSimple<T>(
  fn: () => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  return withTimeout(() => fn(), options);
}
