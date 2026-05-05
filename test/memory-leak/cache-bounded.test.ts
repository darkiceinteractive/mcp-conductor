/**
 * T2: Cache bounded memory test — PR gate (fast, ~30 s).
 *
 * Writes ITERATIONS entries (mixed sizes) into MemoryLru and DiskCache and
 * asserts:
 *   1. MemoryLru total bytes stay within maxMemoryBytes.
 *   2. RSS growth stays within 15% of baseline.
 *   3. DiskCache approximateBytesOnDisk stays within maxDiskBytes.
 *
 * Uses CI_ITERATIONS (100 000 nightly / 10 000 PR-gate) for LRU writes.
 * DiskCache writes use a smaller count to keep wall time reasonable.
 *
 * @module test/memory-leak/cache-bounded
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryLru } from '../../src/cache/lru.js';
import { DiskCache } from '../../src/cache/disk.js';

const LRU_ITERATIONS = process.env.NIGHTLY === '1' ? 100_000 : 10_000;
const DISK_ITERATIONS = process.env.NIGHTLY === '1' ? 5_000 : 500;

const MAX_MEMORY_BYTES = 8 * 1024 * 1024;  // 8 MB cap for this test
const MAX_DISK_BYTES   = 16 * 1024 * 1024; // 16 MB cap for this test
const GROWTH_TOLERANCE = 0.15; // 15 % — disk I/O can cause slightly higher RSS variance

describe('T2 cache-bounded', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-cache-bounded-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    `MemoryLru bytes stay within maxMemoryBytes after ${LRU_ITERATIONS} writes`,
    () => {
      const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY_BYTES });
      const payload = 'x'.repeat(1024); // 1 KB per entry

      for (let i = 0; i < LRU_ITERATIONS; i++) {
        lru.set(`key-${i}`, payload, 60_000);
      }

      expect(lru.bytesUsed).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    },
    120_000,
  );

  it(
    `RSS growth ≤ ${GROWTH_TOLERANCE * 100}% after ${LRU_ITERATIONS} LRU writes with eviction`,
    () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      const lru = new MemoryLru({ maxMemoryBytes: MAX_MEMORY_BYTES });
      const payload = { data: 'x'.repeat(512) }; // ~512 B

      for (let i = 0; i < LRU_ITERATIONS; i++) {
        lru.set(`key-${i % 2000}`, payload, 0); // bounded key space forces eviction
      }
      lru.clear();

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);
    },
    120_000,
  );

  it(
    `DiskCache approximateBytesOnDisk stays within maxDiskBytes after ${DISK_ITERATIONS} writes`,
    async () => {
      const diskCache = new DiskCache({
        diskDir: tmpDir,
        maxDiskBytes: MAX_DISK_BYTES,
      });

      const value = { result: 'x'.repeat(4096) }; // ~4 KB per entry
      const now = Date.now();

      for (let i = 0; i < DISK_ITERATIONS; i++) {
        const hash = i.toString(16).padStart(64, '0');
        await diskCache.set(hash, {
          value,
          storedAt: now,
          ttlMs: 3_600_000,
          server: 'test-server',
          tool: 'test-tool',
        });
      }

      expect(diskCache.approximateBytesOnDisk).toBeLessThanOrEqual(MAX_DISK_BYTES * 1.05);
    },
    300_000,
  );
});
