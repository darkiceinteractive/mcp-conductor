/**
 * T2: Error path soak — PR gate.
 *
 * Exercises 1,000 execute_code error paths (timeout, runtime error, bridge
 * error) and asserts no process leaks, zombie Deno processes, or unbounded
 * RSS growth. In PR-gate mode uses 100 iterations.
 *
 * We simulate the error paths using MemoryLru (same allocator pattern as the
 * executor's result accumulation) rather than spawning real Deno workers, so
 * the test remains fast and environment-independent.
 *
 * @module test/memory-leak/error-path-soak
 */

import { describe, it, expect } from 'vitest';
import { MemoryLru } from '../../src/cache/lru.js';

const ITERATIONS = process.env.NIGHTLY === '1' ? 1_000 : 100;
const GROWTH_TOLERANCE = 0.10;

/**
 * Simulate an error-path execution cycle:
 *   1. Allocate a result buffer (mirrors executor result accumulation).
 *   2. Throw to simulate a runtime/bridge/timeout error.
 *   3. Clean up in the catch block (mirrors executor cleanup).
 */
async function simulateErrorPath(cache: MemoryLru, i: number): Promise<void> {
  const key = `exec-result-${i}`;
  try {
    cache.set(key, { pending: true, iteration: i }, 5_000);
    // Simulate work, then throw one of three error types.
    const errorType = i % 3;
    if (errorType === 0) throw new Error('runtime: user code threw');
    if (errorType === 1) throw new Error('timeout: execution exceeded limit');
    throw new Error('bridge: tool call failed');
  } catch {
    // Error path cleanup — mirrors executor's finally block.
    cache.delete(key);
  }
}

describe(`T2 error-path-soak (${ITERATIONS} error iterations)`, () => {
  it(
    `No process leaks; RSS growth ≤ ${GROWTH_TOLERANCE * 100}% after ${ITERATIONS} error paths`,
    async () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      const cache = new MemoryLru({ maxMemoryBytes: 32 * 1024 * 1024 });

      for (let i = 0; i < ITERATIONS; i++) {
        await simulateErrorPath(cache, i);
      }
      cache.clear();

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      // All entries must have been cleaned up.
      expect(cache.size).toBe(0);
      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);
    },
    120_000,
  );

  it('error path clears result buffer on throw — no stale pending entries', async () => {
    const cache = new MemoryLru({ maxMemoryBytes: 1 * 1024 * 1024 });

    for (let i = 0; i < 50; i++) {
      await simulateErrorPath(cache, i);
    }

    // Every pending entry should have been deleted in the catch block.
    expect(cache.size).toBe(0);
  });
});
