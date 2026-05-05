/**
 * P5 — findTool vector-index scaling stress test
 *
 * Sweeps the VectorIndex from 100 to 100 K tools and measures:
 *   - Index rebuild time
 *   - Query latency for top-3, top-10, top-100 results
 *
 * Assertions:
 *   - query p99 < 100 ms at every index size (including 100 K)
 *   - results are always sorted descending by score
 *   - rebuild is idempotent (same query yields same top-1 after two rebuilds)
 *
 * The 100 K-tool case is gated behind STRESS=1.
 *
 * Benchmark output: docs/benchmarks/stress/findtool-scaling-YYYY-MM-DD.json
 *
 * @module test/stress/findtool-scaling
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { VectorIndex } from '../../src/runtime/findtool/vector-index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const STRESS = Boolean(process.env['STRESS']);
const BENCH_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// P99 query latency ceiling (ms) — enforced at every index size
const QUERY_P99_MS = 100;

// Number of repeated queries used to estimate p99 per size
const QUERY_REPEATS = 20;

// ─── Synthetic tool catalogue ─────────────────────────────────────────────────

/**
 * Generate `n` synthetic tool definitions with varied names and descriptions
 * so the embedding function has meaningful variation to work with.
 */
function generateTools(n: number): Array<{ server: string; tool: string; description: string }> {
  const domains = ['github', 'slack', 'linear', 'notion', 'gdrive', 'gmail', 'calendar', 'jira'];
  const verbs   = ['list', 'get', 'search', 'fetch', 'query', 'read', 'find', 'retrieve'];
  const nouns   = ['issues', 'messages', 'files', 'events', 'tasks', 'comments', 'users', 'repos'];

  const tools: Array<{ server: string; tool: string; description: string }> = [];
  for (let i = 0; i < n; i++) {
    const domain = domains[i % domains.length]!;
    const verb   = verbs[Math.floor(i / domains.length) % verbs.length]!;
    const noun   = nouns[Math.floor(i / (domains.length * verbs.length)) % nouns.length]!;
    const suffix = Math.floor(i / (domains.length * verbs.length * nouns.length));
    tools.push({
      server: `${domain}-server`,
      tool: `${verb}_${noun}${suffix > 0 ? `_${suffix}` : ''}`,
      description: `${verb.charAt(0).toUpperCase() + verb.slice(1)} ${noun} from ${domain}` +
                   (suffix > 0 ? ` (variant ${suffix})` : ''),
    });
  }
  return tools;
}

// ─── Result accumulator ───────────────────────────────────────────────────────

interface ScalingResult {
  indexSize: number;
  buildMs: number;
  queryTop3Ms: number;
  queryTop10Ms: number;
  queryTop100Ms: number;
  p99Ms: number;
}

const results: ScalingResult[] = [];

// ─── Helper: measure p99 query latency ───────────────────────────────────────

function measureQueryLatency(
  index: VectorIndex,
  query: string,
  topK: number,
  repeats: number
): number {
  const times: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    index.search(query, topK);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p99idx = Math.max(0, Math.ceil(repeats * 0.99) - 1);
  return times[p99idx] ?? times[times.length - 1] ?? 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P5: findTool vector-index scaling', () => {
  afterAll(async () => {
    await mkdir(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `findtool-scaling-${DATE_STAMP}.json`);
    await writeFile(outPath, JSON.stringify({ date: DATE_STAMP, results }, null, 2), 'utf8');
  });

  const INDEX_SIZES: Array<{ n: number; stressOnly?: boolean }> = [
    { n: 100 },
    { n: 1_000 },
    { n: 10_000 },
    { n: 100_000, stressOnly: true },
  ];

  for (const { n, stressOnly } of INDEX_SIZES) {
    it(
      `${stressOnly ? '[STRESS] ' : ''}index-${n}: build + query latency`,
      async () => {
        if (stressOnly && !STRESS) {
          console.log(`  [skip] index-${n} — set STRESS=1 to enable`);
          return;
        }

        const tools = generateTools(n);
        const index = new VectorIndex();

        // Measure index build
        const t0Build = performance.now();
        index.rebuild(tools);
        const buildMs = performance.now() - t0Build;

        expect(index.size).toBe(n);

        // Query latency: top-3
        const t0Q3 = performance.now();
        const r3 = index.search('list github issues', 3);
        const queryTop3Ms = performance.now() - t0Q3;

        // Query latency: top-10
        const t0Q10 = performance.now();
        const r10 = index.search('list github issues', 10);
        const queryTop10Ms = performance.now() - t0Q10;

        // Query latency: top-100
        const topK100 = Math.min(100, n);
        const t0Q100 = performance.now();
        const r100 = index.search('list github issues', topK100);
        const queryTop100Ms = performance.now() - t0Q100;

        // p99 across QUERY_REPEATS runs of top-3 (most common use-case)
        const p99Ms = measureQueryLatency(index, 'list github issues', 3, QUERY_REPEATS);

        results.push({
          indexSize: n,
          buildMs:       Math.round(buildMs * 100) / 100,
          queryTop3Ms:   Math.round(queryTop3Ms * 100) / 100,
          queryTop10Ms:  Math.round(queryTop10Ms * 100) / 100,
          queryTop100Ms: Math.round(queryTop100Ms * 100) / 100,
          p99Ms:         Math.round(p99Ms * 100) / 100,
        });

        console.log(
          `  index-${n}: build=${buildMs.toFixed(1)}ms ` +
          `q3=${queryTop3Ms.toFixed(2)}ms q10=${queryTop10Ms.toFixed(2)}ms ` +
          `q100=${queryTop100Ms.toFixed(2)}ms p99=${p99Ms.toFixed(2)}ms`
        );

        // Results must be sorted descending by score
        for (let i = 1; i < r3.length; i++) {
          expect(r3[i]!.score).toBeLessThanOrEqual(r3[i - 1]!.score);
        }
        for (let i = 1; i < r10.length; i++) {
          expect(r10[i]!.score).toBeLessThanOrEqual(r10[i - 1]!.score);
        }
        for (let i = 1; i < r100.length; i++) {
          expect(r100[i]!.score).toBeLessThanOrEqual(r100[i - 1]!.score);
        }

        // Top-K count must not exceed index size
        expect(r3.length).toBeLessThanOrEqual(Math.min(3, n));
        expect(r10.length).toBeLessThanOrEqual(Math.min(10, n));
        expect(r100.length).toBeLessThanOrEqual(topK100);

        // p99 gate: < 100 ms at every index size
        expect(
          p99Ms,
          `index-${n}: p99 ${p99Ms.toFixed(2)}ms exceeded ${QUERY_P99_MS}ms`
        ).toBeLessThan(QUERY_P99_MS);
      },
      stressOnly ? 120_000 : 30_000
    );
  }

  it('rebuild is idempotent — same top-1 result after two consecutive rebuilds', () => {
    const tools = generateTools(1_000);
    const index = new VectorIndex();

    index.rebuild(tools);
    const first = index.search('search slack messages', 1);

    index.rebuild(tools);
    const second = index.search('search slack messages', 1);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first[0]!.tool).toBe(second[0]!.tool);
    expect(first[0]!.server).toBe(second[0]!.server);
  });

  it('upsertServer replaces old tools for the same server', () => {
    const index = new VectorIndex();
    index.upsertServer('test-server', [
      { tool: 'list_items', description: 'List all items' },
    ]);
    expect(index.size).toBe(1);

    index.upsertServer('test-server', [
      { tool: 'get_item',     description: 'Get a single item' },
      { tool: 'search_items', description: 'Search items by query' },
    ]);
    expect(index.size).toBe(2);

    const r = index.search('get item', 5);
    expect(r.every((entry) => entry.server === 'test-server')).toBe(true);
  });

  it('empty index returns no results without throwing', () => {
    const index = new VectorIndex();
    const r = index.search('any query', 10);
    expect(r).toEqual([]);
  });
});
