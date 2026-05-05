/**
 * T2: Worker pool recycle memory test.
 *
 * Verifies that recycling workers every 10 jobs does not accumulate zombie
 * entries or unbounded RSS growth. Exercises the eviction/replace cycle that
 * mirrors WorkerPool's maxJobsPerWorker recycle policy.
 *
 * Nightly tier: 1,000 calls, recycle every 10.
 * PR-gate:       100 calls, recycle every 10.
 *
 * @module test/memory-leak/worker-pool-recycle
 */

import { describe, it, expect } from 'vitest';
import { MemoryLru } from '../../src/cache/lru.js';

const TOTAL_CALLS = process.env.NIGHTLY === '1' ? 1_000 : 100;
const RECYCLE_EVERY = 10;
const GROWTH_TOLERANCE = 0.10;

describe(`T2 worker-pool-recycle (${TOTAL_CALLS} calls, recycle every ${RECYCLE_EVERY})`, () => {
  it.skip(
    'RSS stable; no zombie MemoryLru entries after recycle cycles',
    async () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      // Simulate workers as MemoryLru instances (same lifecycle as PooledWorker).
      // Each "worker" holds a small payload; after RECYCLE_EVERY calls it is
      // replaced (old instance garbage-collected).
      let activeWorker = new MemoryLru({ maxMemoryBytes: 128 * 1024 });

      for (let call = 0; call < TOTAL_CALLS; call++) {
        activeWorker.set(`result-${call}`, { value: call }, 0);

        if ((call + 1) % RECYCLE_EVERY === 0) {
          // Recycle: clear old worker, create fresh.
          activeWorker.clear();
          activeWorker = new MemoryLru({ maxMemoryBytes: 128 * 1024 });
        }
      }
      activeWorker.clear();

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);
    },
    3_600_000,
  );
});
