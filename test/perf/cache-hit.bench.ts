/**
 * Cache-hit benchmark — T1 (STUB)
 *
 * Will measure repeat execute_code calls that hit the disk/memory result
 * cache, bypassing the Deno sandbox entirely.
 *
 * PRD §6.1 threshold: p50 < 2ms.
 *
 * Status: stubbed — cache layer integration required before this can be
 * wired. Track in T1.b follow-up PR once the cache API stabilises.
 *
 * All tests in this file are skipped so the suite is wired but does not
 * fail when the cache layer is absent.
 */

import { describe, test } from 'vitest';
import { runBenchmark } from './bench-utils.js';

// Placeholder function — will be replaced with real cache call.
async function cacheHitFn(): Promise<void> {
  // TODO(T1.b): wire against ConductorCache.get() once cache API is stable.
  await Promise.resolve();
}

describe.skip('cache-hit (stub — T1.b)', () => {
  test.skip('cache-hit p50 < 2ms (CI gate)', async () => {
    const result = await runBenchmark(cacheHitFn, {
      warmupIterations: 10,
      iterations: 100,
    });

    // Threshold: 2ms (cache hit should be sub-millisecond in practice).
    expect(result.p50).toBeLessThan(2);
  });
});

// Satisfy the import so the module is valid TypeScript.
void runBenchmark;
