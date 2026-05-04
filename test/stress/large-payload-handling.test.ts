/**
 * P1 — Large-payload handling stress test
 *
 * Pushes raw response sizes (100 KB, 1 MB, 10 MB, 50 MB) through the full
 * tokenize → LRU-cache path and measures transit time at each stage.
 *
 * Gates:
 * - 10 MB must complete end-to-end in < 5 s
 * - 50 MB is gated behind STRESS=1 and must complete in < 30 s
 * - cache must reject payloads exceeding maxMemoryBytes without OOM
 *
 * Benchmark output written to docs/benchmarks/stress/large-payload-YYYY-MM-DD.json
 *
 * @module test/stress/large-payload-handling
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryLru } from '../../src/cache/lru.js';
import { tokenize } from '../../src/utils/tokenize.js';
import type { BuiltinMatcherName } from '../../src/utils/tokenize.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a JSON payload of approximately `targetBytes` bytes. */
function buildJsonPayload(targetBytes: number): unknown {
  const recordTemplate = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Test Record Name Padding__________________',
    description: 'A description field that adds roughly one hundred bytes of text content here.',
    value: 12345.6789,
    active: true,
    tags: ['alpha', 'beta', 'gamma'],
    createdAt: '2026-05-04T00:00:00.000Z',
  };
  const oneRecord = JSON.stringify(recordTemplate);
  const recordSize = Buffer.byteLength(oneRecord, 'utf8');
  const count = Math.ceil(targetBytes / recordSize);

  const records = [];
  for (let i = 0; i < count; i++) {
    records.push({ ...recordTemplate, id: i.toString().padStart(36, '0'), value: i * 1.1 });
  }
  return { records, meta: { count, generatedAt: Date.now() } };
}

/** Measure async fn duration in ms. */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALL_MATCHERS: BuiltinMatcherName[] = [
  'email', 'phone', 'ssn', 'credit_card', 'iban', 'ipv4', 'ipv6',
];

const SIZES: Array<{ label: string; bytes: number; stressOnly?: boolean }> = [
  { label: '100KB', bytes: 100 * 1024 },
  { label: '1MB',   bytes: 1 * 1024 * 1024 },
  { label: '10MB',  bytes: 10 * 1024 * 1024 },
  { label: '50MB',  bytes: 50 * 1024 * 1024, stressOnly: true },
];

const STRESS = Boolean(process.env['STRESS']);
const BENCH_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// ─── Result accumulator ───────────────────────────────────────────────────────

interface SizeResult {
  label: string;
  bytes: number;
  payloadBuildMs: number;
  tokenizeMs: number;
  cacheWriteMs: number;
  cacheReadMs: number;
  endToEndMs: number;
  reverseMapSize: number;
}

const results: SizeResult[] = [];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P1: large-payload handling', () => {
  afterAll(async () => {
    await mkdir(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `large-payload-${DATE_STAMP}.json`);
    await writeFile(outPath, JSON.stringify({ date: DATE_STAMP, results }, null, 2), 'utf8');
  });

  for (const { label, bytes, stressOnly } of SIZES) {
    it(
      `${stressOnly ? '[STRESS] ' : ''}${label}: tokenize → cache round-trip`,
      async () => {
        if (stressOnly && !STRESS) {
          console.log(`  [skip] ${label} — set STRESS=1 to enable`);
          return;
        }

        // 1. Build payload (simulates backend returning a JSON response of this size)
        const t0Build = performance.now();
        const payload = buildJsonPayload(bytes);
        const payloadBuildMs = performance.now() - t0Build;

        // 2. Tokenize with all 6 PII matchers active
        const { result: tokenizeResult, ms: tokenizeMs } = await timed(async () =>
          tokenize(payload, ALL_MATCHERS)
        );
        const reverseMapSize = Object.keys(tokenizeResult.reverseMap).length;

        // 3. Cache write
        const lru = new MemoryLru({ maxMemoryBytes: bytes * 2 + 10 * 1024 * 1024 });
        const { ms: cacheWriteMs } = await timed(async () => {
          lru.set('stress:tool:abc123', tokenizeResult.redacted, 60_000);
        });

        // 4. Cache read
        const { ms: cacheReadMs } = await timed(async () => {
          const hit = lru.get('stress:tool:abc123');
          expect(hit).not.toBeNull();
          expect(hit?.source).toBe('memory');
        });

        const endToEndMs = payloadBuildMs + tokenizeMs + cacheWriteMs + cacheReadMs;

        results.push({
          label,
          bytes,
          payloadBuildMs: Math.round(payloadBuildMs * 10) / 10,
          tokenizeMs: Math.round(tokenizeMs * 10) / 10,
          cacheWriteMs: Math.round(cacheWriteMs * 10) / 10,
          cacheReadMs: Math.round(cacheReadMs * 10) / 10,
          endToEndMs: Math.round(endToEndMs * 10) / 10,
          reverseMapSize,
        });

        console.log(
          `  ${label}: build=${payloadBuildMs.toFixed(1)}ms tok=${tokenizeMs.toFixed(1)}ms ` +
          `write=${cacheWriteMs.toFixed(1)}ms read=${cacheReadMs.toFixed(1)}ms ` +
          `total=${endToEndMs.toFixed(1)}ms reverseMap=${reverseMapSize}`
        );

        // Tokenize must complete without crashing
        expect(tokenizeResult).toBeDefined();
        expect(tokenizeResult.redacted).toBeDefined();

        // 10 MB gate: end-to-end < 5 s
        if (bytes <= 10 * 1024 * 1024) {
          expect(endToEndMs).toBeLessThan(5_000);
        }

        // 50 MB gate: end-to-end < 30 s (only reached when STRESS=1)
        if (bytes === 50 * 1024 * 1024) {
          expect(endToEndMs).toBeLessThan(30_000);
        }
      },
      stressOnly ? 60_000 : 15_000
    );
  }

  it('cache rejects payloads exceeding maxMemoryBytes cleanly (no OOM)', () => {
    // Configure a 1 KB LRU — writing a 100 KB payload must not throw
    const tiny = new MemoryLru({ maxMemoryBytes: 1024 });
    const bigPayload = buildJsonPayload(100 * 1024);

    expect(() => tiny.set('k', bigPayload, 60_000)).not.toThrow();

    // After the oversized write, bytesUsed must remain at or below maxMemoryBytes
    expect(tiny.bytesUsed).toBeLessThanOrEqual(1024);
  });

  it('cache write+read preserves value integrity for a 1 MB payload', () => {
    const lru = new MemoryLru({ maxMemoryBytes: 10 * 1024 * 1024 });
    const payload = buildJsonPayload(1024 * 1024);
    lru.set('integrity:tool:xyz', payload, 60_000);
    const hit = lru.get('integrity:tool:xyz');
    expect(hit).not.toBeNull();
    expect(hit?.value).toEqual(payload);
  });
});
