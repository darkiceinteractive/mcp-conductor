/**
 * P3 — Deep/wide JSON shape stress test
 *
 * Exercises pathological JSON structures through cache-key derivation,
 * tokenization, and the LRU cache write/read path:
 *
 *   Deep:   100 / 500 / 1000-level nested objects
 *   Wide:   arrays of 10 K / 100 K / 1 M items
 *   Mixed:  100-deep × 1000-wide
 *
 * All cases assert: no stack overflow, no OOM, completion < 10 s.
 * The 1 M-item array case is gated behind STRESS=1.
 *
 * Benchmark output: docs/benchmarks/stress/deep-wide-YYYY-MM-DD.json
 *
 * @module test/stress/deep-wide-shapes
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryLru } from '../../src/cache/lru.js';
import { hashArgs } from '../../src/cache/key.js';
import { tokenize } from '../../src/utils/tokenize.js';
import type { BuiltinMatcherName } from '../../src/utils/tokenize.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MATCHERS: BuiltinMatcherName[] = ['email', 'ipv4'];

const STRESS = Boolean(process.env['STRESS']);
const BENCH_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// ─── Shape builders ───────────────────────────────────────────────────────────

/** Build a deeply nested object: { level: N, a: { level: N-1, a: { ... leaf ... } } } */
function buildDeepObject(depth: number): unknown {
  let node: unknown = { leaf: 'value', count: depth };
  for (let i = depth - 1; i >= 0; i--) {
    node = { a: node, level: i };
  }
  return node;
}

/** Build a wide flat array of `width` simple item objects. */
function buildWideArray(width: number): unknown {
  const arr: Array<Record<string, unknown>> = new Array(width);
  for (let i = 0; i < width; i++) {
    arr[i] = { i, v: i * 1.1 };
  }
  return { items: arr, count: width };
}

/** Build a mixed structure: `depth` levels deep, each holding a `width`-item array. */
function buildMixedShape(depth: number, width: number): unknown {
  const items = Array.from({ length: width }, (_, i) => ({ i, tag: `item-${i}` }));
  let node: unknown = { items };
  for (let i = depth - 1; i >= 0; i--) {
    node = { level: i, children: [node] };
  }
  return node;
}

// ─── Result accumulator ───────────────────────────────────────────────────────

interface ShapeResult {
  shape: string;
  depth: number;
  width: number;
  keyDerivationMs: number;
  tokenizeMs: number;
  cacheWriteMs: number;
  cacheReadMs: number;
  totalMs: number;
}

const results: ShapeResult[] = [];

// ─── Runner helper ────────────────────────────────────────────────────────────

async function runShapeTest(
  label: string,
  depth: number,
  width: number,
  payload: unknown
): Promise<void> {
  // Generous ceiling — we are testing correctness, not memory cap
  const lru = new MemoryLru({ maxMemoryBytes: 512 * 1024 * 1024 });

  // 1. Cache-key derivation (sha256 of stable-stringified args)
  const t0Key = performance.now();
  const key = hashArgs(payload);
  const keyDerivationMs = performance.now() - t0Key;

  expect(key).toHaveLength(64); // must produce a valid sha256 hex

  // 2. Tokenize
  const t0Tok = performance.now();
  const { redacted } = tokenize(payload, MATCHERS);
  const tokenizeMs = performance.now() - t0Tok;

  expect(redacted).toBeDefined();

  // 3. Cache write
  const t0Write = performance.now();
  lru.set(`stress:${label}`, redacted, 60_000);
  const cacheWriteMs = performance.now() - t0Write;

  // 4. Cache read
  const t0Read = performance.now();
  const hit = lru.get(`stress:${label}`);
  const cacheReadMs = performance.now() - t0Read;

  expect(hit).not.toBeNull();

  const totalMs = keyDerivationMs + tokenizeMs + cacheWriteMs + cacheReadMs;

  results.push({
    shape: label,
    depth,
    width,
    keyDerivationMs: Math.round(keyDerivationMs * 100) / 100,
    tokenizeMs:      Math.round(tokenizeMs * 100) / 100,
    cacheWriteMs:    Math.round(cacheWriteMs * 100) / 100,
    cacheReadMs:     Math.round(cacheReadMs * 100) / 100,
    totalMs:         Math.round(totalMs * 100) / 100,
  });

  console.log(
    `  ${label}: key=${keyDerivationMs.toFixed(2)}ms tok=${tokenizeMs.toFixed(2)}ms ` +
    `write=${cacheWriteMs.toFixed(2)}ms read=${cacheReadMs.toFixed(2)}ms ` +
    `total=${totalMs.toFixed(2)}ms`
  );

  // All shapes must complete in < 10 s
  expect(totalMs, `${label} exceeded 10 s time limit`).toBeLessThan(10_000);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P3: deep/wide JSON shapes', () => {
  afterAll(async () => {
    await mkdir(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `deep-wide-${DATE_STAMP}.json`);
    await writeFile(outPath, JSON.stringify({ date: DATE_STAMP, results }, null, 2), 'utf8');
  });

  describe('deep nested objects', () => {
    for (const depth of [100, 500, 1000]) {
      it(`deep-${depth}: no stack overflow, < 10 s`, async () => {
        const payload = buildDeepObject(depth);
        await runShapeTest(`deep-${depth}`, depth, 1, payload);
      }, 15_000);
    }
  });

  describe('wide flat arrays', () => {
    const wideCases: Array<{ width: number; stressOnly?: boolean }> = [
      { width: 10_000 },
      { width: 100_000 },
      { width: 1_000_000, stressOnly: true },
    ];

    for (const { width, stressOnly } of wideCases) {
      it(
        `${stressOnly ? '[STRESS] ' : ''}wide-${width.toLocaleString()}: no OOM, < 10 s`,
        async () => {
          if (stressOnly && !STRESS) {
            console.log(`  [skip] wide-${width} — set STRESS=1 to enable`);
            return;
          }
          const payload = buildWideArray(width);
          await runShapeTest(`wide-${width}`, 1, width, payload);
        },
        stressOnly ? 60_000 : 20_000
      );
    }
  });

  describe('mixed deep × wide', () => {
    it('mixed-100deep-1000wide: no stack overflow, no OOM, < 10 s', async () => {
      const payload = buildMixedShape(100, 1000);
      await runShapeTest('mixed-100d-1000w', 100, 1000, payload);
    }, 20_000);
  });

  it('deep-1000 key derivation produces a stable 64-char hash', () => {
    const payload = buildDeepObject(1000);
    const k1 = hashArgs(payload);
    const k2 = hashArgs(payload);
    expect(k1).toHaveLength(64);
    expect(k1).toBe(k2); // deterministic across calls
  });
});
