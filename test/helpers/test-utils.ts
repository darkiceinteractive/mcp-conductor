/**
 * Test Utilities
 *
 * Common utilities for MCP Conductor tests.
 */

import { vi, expect } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Create a deferred promise for async testing
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Mock timer utilities
 */
export function useFakeTimers(): {
  advanceBy: (ms: number) => Promise<void>;
  advanceTo: (ms: number) => Promise<void>;
  restore: () => void;
} {
  vi.useFakeTimers();

  return {
    advanceBy: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    advanceTo: async (ms: number) => {
      vi.setSystemTime(ms);
      await vi.runAllTimersAsync();
    },
    restore: () => {
      vi.useRealTimers();
    },
  };
}

/**
 * Create a mock function with call tracking
 */
export function createTrackedMock<T extends (...args: unknown[]) => unknown>(
  implementation?: T
): Mock<T> & { calls: Parameters<T>[]; results: ReturnType<T>[] } {
  const calls: Parameters<T>[] = [];
  const results: ReturnType<T>[] = [];

  const mock = vi.fn((...args: Parameters<T>) => {
    calls.push(args);
    const result = implementation ? implementation(...args) : undefined;
    results.push(result as ReturnType<T>);
    return result;
  }) as Mock<T> & { calls: Parameters<T>[]; results: ReturnType<T>[] };

  mock.calls = calls;
  mock.results = results;

  return mock;
}

/**
 * Assert that a promise rejects with specific error
 */
export async function expectToReject(
  promise: Promise<unknown>,
  errorPattern?: string | RegExp
): Promise<Error> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    if (error instanceof Error && error.message === 'Expected promise to reject') {
      throw error;
    }

    if (errorPattern && error instanceof Error) {
      if (typeof errorPattern === 'string') {
        expect(error.message).toContain(errorPattern);
      } else {
        expect(error.message).toMatch(errorPattern);
      }
    }

    return error as Error;
  }
}

/**
 * Generate random test data
 */
export function generateTestData(sizeKb: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const targetBytes = sizeKb * 1024;
  let result = '';

  while (result.length < targetBytes) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

/**
 * Create a mock MCP result content
 */
export function createMockContent(data: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data),
      },
    ],
  };
}

/**
 * Measure execution time
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;

  return { result, durationMs };
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Assert object has specific shape
 */
export function assertShape<T extends Record<string, unknown>>(
  obj: unknown,
  shape: { [K in keyof T]: string }
): asserts obj is T {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Expected object');
  }

  for (const [key, type] of Object.entries(shape)) {
    const value = (obj as Record<string, unknown>)[key];
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (actualType !== type) {
      throw new Error(`Expected ${key} to be ${type}, got ${actualType}`);
    }
  }
}

/**
 * Create a spy that captures async results
 */
export function createAsyncSpy<T>(): {
  spy: (value: T) => void;
  values: T[];
  waitForCount: (count: number, timeoutMs?: number) => Promise<T[]>;
} {
  const values: T[] = [];
  const listeners: Array<() => void> = [];

  const spy = (value: T) => {
    values.push(value);
    listeners.forEach((l) => l());
  };

  const waitForCount = async (count: number, timeoutMs: number = 5000): Promise<T[]> => {
    if (values.length >= count) {
      return values.slice(0, count);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${count} values, got ${values.length}`));
      }, timeoutMs);

      const check = () => {
        if (values.length >= count) {
          clearTimeout(timeout);
          resolve(values.slice(0, count));
        }
      };

      listeners.push(check);
    });
  };

  return { spy, values, waitForCount };
}

/**
 * Environment variable helpers
 */
export const envHelpers = {
  set(key: string, value: string): void {
    process.env[key] = value;
  },

  unset(key: string): void {
    delete process.env[key];
  },

  withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const original: Record<string, string | undefined> = {};

    // Save and set
    for (const [key, value] of Object.entries(env)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      return fn();
    } finally {
      // Restore
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  },
};

/**
 * Console capture for testing logging
 */
export function captureConsole(): {
  logs: string[];
  warns: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));

  return {
    logs,
    warns,
    errors,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}
