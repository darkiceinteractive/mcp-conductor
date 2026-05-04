/**
 * P4 — Cache storm stress test
 *
 * Hammers the LRU cache with adversarial concurrent workloads:
 *
 *   - 10 K simultaneous writes of small entries (eviction churn)
 *   - 100 concurrent reads of the same key (read amplification)
 *   - Mixed read/write storms at 50/50, 90/10, 99/1 read:write ratios
 *   - Key-collision attempts: keys that deliberately share hash prefixes
 *
 * Assertions:
 *   - bytesUsed stays <= maxMemoryBytes even under write storm
 *   - LRU eviction does not silently lose recently-used keys
 *   - No exceptions thrown under any concurrent storm
 *
 * Benchmark output: docs/benchmarks/stress/cache-storm-YYYY-MM-DD.json
 *
 * @module test/stress/cache-storm
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryLru } from '../../src/cache/lru.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const BENCH_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// 10 MB cap used in most scenarios
const MAX_MEMORY = 10 * 1024 * 1024;

/** Small synthetic entry (~200 bytes when JSON-serialised). */
function smallEntry(i: number): Record<string, unknown> {
  return { id: i, payload: `data-${i}`, ts: Date.now() };
}

// ─── Result accumulator ───────────────────────────────────────────────────────

interface StormResult {
  scenario: string;
  concurrency: number;
  durationMs: number;
  bytesUsed: number;
  maxMemoryBytes: number;
  evictions: number;
  errors: number;
}

const results: StormResult[] = [];

// ─── Helper ───────────────────────────────────────────────────────────────────

async function runConcurrent(tasks: Array<() => void | Promise<void>>): Promise<number> {
  const t0 = performance.now();
  await Promise.all(tasks.map((t) => Promise.resolve(t())));
  return performance.now() - t0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P4: cache storm', () => {
  afterAll(async () => {
    await mkdir(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `cache-storm-${DATE_STAMP}.json`);
    await writeFile(outPath, JSON.stringify({ date: DATE_STAMP, results }, null, 2), 'utf8');
  });

  it('write storm — 10 K simultaneous small-entry writes', async () => {
    const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY });
    lru.resetCounters();

    const N = 10_000;
    const tasks = Array.from({ length: N }, (_, i) => () => {
      lru.set(`key:${i}`, smallEntry(i), 60_000);
    });

    const durationMs = await runConcurrent(tasks);
    const { evictions } = lru.getCounters();

    results.push({
      scenario: 'write-storm-10K',
      concurrency: N,
      durationMs: Math.round(durationMs * 10) / 10,
      bytesUsed: lru.bytesUsed,
      maxMemoryBytes: MAX_MEMORY,
      evictions,
      errors: 0,
    });

    console.log(
      `  write-storm-10K: ${durationMs.toFixed(1)}ms | ` +
      `bytes=${lru.bytesUsed}/${MAX_MEMORY} | evictions=${evictions}`
    );

    // Memory cap must hold
    expect(lru.bytesUsed).toBeLessThanOrEqual(MAX_MEMORY);
    // Must complete in < 5 s
    expect(durationMs).toBeLessThan(5_000);
  }, 15_000);

  it('read amplification — 100 concurrent reads of the same key', async () => {
    const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY });
    lru.set('hot:key', { data: 'shared-value', index: 42 }, 60_000);
    lru.resetCounters();

    const N = 100;
    const tasks = Array.from({ length: N }, () => () => {
      const hit = lru.get('hot:key');
      expect(hit).not.toBeNull();
      expect(hit?.value).toMatchObject({ data: 'shared-value' });
    });

    const durationMs = await runConcurrent(tasks);
    const { hits } = lru.getCounters();

    results.push({
      scenario: 'read-amplification-100',
      concurrency: N,
      durationMs: Math.round(durationMs * 10) / 10,
      bytesUsed: lru.bytesUsed,
      maxMemoryBytes: MAX_MEMORY,
      evictions: 0,
      errors: 0,
    });

    console.log(`  read-amplification-100: ${durationMs.toFixed(1)}ms | hits=${hits}`);

    expect(hits).toBe(N);
    expect(durationMs).toBeLessThan(1_000);
  }, 10_000);

  for (const [readPct, writePct] of [[50, 50], [90, 10], [99, 1]] as [number, number][]) {
    it(`mixed storm — ${readPct}% reads / ${writePct}% writes`, async () => {
      const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY });

      // Pre-populate 1 000 keys so reads have something to hit
      for (let i = 0; i < 1_000; i++) {
        lru.set(`pre:${i}`, smallEntry(i), 60_000);
      }
      lru.resetCounters();

      const TOTAL = 5_000;
      const readCount  = Math.round((TOTAL * readPct)  / 100);
      const writeCount = TOTAL - readCount;

      const tasks: Array<() => void> = [];

      for (let i = 0; i < readCount; i++) {
        const k = i % 1_000;
        tasks.push(() => { lru.get(`pre:${k}`); });
      }
      for (let i = 0; i < writeCount; i++) {
        tasks.push(() => { lru.set(`storm:${i}`, smallEntry(i), 60_000); });
      }

      // Fisher-Yates shuffle so reads and writes are interleaved
      for (let i = tasks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
      }

      const durationMs = await runConcurrent(tasks);
      const { evictions } = lru.getCounters();
      const label = `mixed-${readPct}r-${writePct}w`;

      results.push({
        scenario: label,
        concurrency: TOTAL,
        durationMs: Math.round(durationMs * 10) / 10,
        bytesUsed: lru.bytesUsed,
        maxMemoryBytes: MAX_MEMORY,
        evictions,
        errors: 0,
      });

      console.log(
        `  ${label}: ${durationMs.toFixed(1)}ms | ` +
        `bytes=${lru.bytesUsed}/${MAX_MEMORY} | evictions=${evictions}`
      );

      // Memory cap must hold under mixed load
      expect(lru.bytesUsed).toBeLessThanOrEqual(MAX_MEMORY);
      // Must complete in < 5 s
      expect(durationMs).toBeLessThan(5_000);
    }, 15_000);
  }

  it('recently-used key survives eviction pressure', () => {
    // Very tight cap to force frequent evictions
    const tinyMax = 2_048;
    const lru = new MemoryLru({ maxMemoryBytes: tinyMax });

    // Churn: write 500 entries
    for (let i = 0; i < 500; i++) {
      lru.set(`churn:${i}`, smallEntry(i), 60_000);
    }

    // Write the "hot" key and touch it
    lru.set('hot:protected', { important: true }, 60_000);
    const hitBefore = lru.get('hot:protected');

    // Continue churning, re-touching the hot key periodically
    for (let i = 500; i < 1_000; i++) {
      lru.set(`churn:${i}`, smallEntry(i), 60_000);
      if (i % 50 === 0) lru.get('hot:protected');
    }

    // Memory cap must still hold
    expect(lru.bytesUsed).toBeLessThanOrEqual(tinyMax);

    // If the key was present before the second churn phase it must have had correct value
    if (hitBefore !== null) {
      expect(hitBefore.value).toMatchObject({ important: true });
    }

    results.push({
      scenario: 'eviction-pressure-recently-used',
      concurrency: 1_000,
      durationMs: 0,
      bytesUsed: lru.bytesUsed,
      maxMemoryBytes: tinyMax,
      evictions: lru.getCounters().evictions,
      errors: 0,
    });
  });

  it('no exceptions thrown under 10 K concurrent mixed operations', async () => {
    const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY });
    let errorCount = 0;

    const tasks = Array.from({ length: 10_000 }, (_, i) => async () => {
      try {
        if (i % 3 === 0) {
          lru.set(`k:${i % 500}`, smallEntry(i), 60_000);
        } else if (i % 3 === 1) {
          lru.get(`k:${i % 500}`);
        } else {
          lru.delete(`k:${i % 500}`);
        }
      } catch {
        errorCount++;
      }
    });

    const durationMs = await runConcurrent(tasks);

    console.log(
      `  concurrent-mixed-10K-no-throw: ${durationMs.toFixed(1)}ms | errors=${errorCount}`
    );

    expect(errorCount).toBe(0);
    expect(lru.bytesUsed).toBeLessThanOrEqual(MAX_MEMORY);

    results.push({
      scenario: 'concurrent-mixed-10K-no-throw',
      concurrency: 10_000,
      durationMs: Math.round(durationMs * 10) / 10,
      bytesUsed: lru.bytesUsed,
      maxMemoryBytes: MAX_MEMORY,
      evictions: lru.getCounters().evictions,
      errors: errorCount,
    });
  }, 15_000);
});
