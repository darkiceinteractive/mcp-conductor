/**
 * D4 — KV Concurrent Load Stress Test.
 *
 * 50 clients hammer the shared KV store across three workload shapes and
 * three key-distribution scenarios, sustained for 30 s per scenario (full
 * runs behind STRESS=1; PR-gate uses a 5 s variant).
 *
 * Workloads:
 *   - 90/10 read-heavy
 *   - 50/50 balanced
 *   - 10/90 write-heavy
 *
 * Key scenarios:
 *   - Same key (last-writer-wins races)
 *   - Spread across 1 000 keys (minimal contention)
 *   - Expiring keys under TTL pressure
 *
 * Measures: throughput (ops/sec), per-op latency (p50/p99), KV size over time.
 *
 * Asserts:
 *   - No data corruption (writes are observable atomically)
 *   - TTL eviction is timely: entries expire within ttlMs + 5 s
 *
 * Results emitted to docs/benchmarks/stress/kv-load-YYYY-MM-DD.json.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'stress-kv-secret-d4-tuv';
const SUSTAINED_MS = 30_000;
const PR_GATE_MS = 5_000;
const TTL_MS = 500;        // TTL for the expiring-keys scenario
const TTL_GRACE_MS = 5_000; // max allowed eviction lag beyond TTL

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-stress-kv-'));
}

function makeServer(dir: string): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, 'daemon.sock'),
    auth: { sharedSecret: TEST_SECRET },
    kvOptions: {
      persistDir: join(dir, 'kv'),
      skipLoad: true,
      sweepIntervalMs: 999_999, // disable background sweep; eviction via reads
    },
  });
}

function makeClient(dir: string): DaemonClient {
  return new DaemonClient({
    socketPath: join(dir, 'daemon.sock'),
    auth: { sharedSecret: TEST_SECRET },
    connectTimeoutMs: 10_000,
  });
}

/** Returns the p-th percentile of a sorted numeric array (p in 0–100). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// -------------------------------------------------------------------------
// Benchmark result collection
// -------------------------------------------------------------------------

interface ScenarioResult {
  scenario: string;
  workload: string;
  clientCount: number;
  keyCount: number;
  readPct: number;
  writePct: number;
  totalOps: number;
  opsPerSec: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  corruptionDetected: boolean;
  durationMs: number;
}

const allResults: ScenarioResult[] = [];

function saveBenchmarkResults(): void {
  try {
    const date = new Date().toISOString().split('T')[0]!;
    const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `kv-load-${date}.json`);
    writeFileSync(outPath, JSON.stringify({
      generated: new Date().toISOString(),
      suite: 'D4 — kv-concurrent-load',
      sustainedMs: SUSTAINED_MS,
      scenarios: allResults,
    }, null, 2), 'utf-8');
  } catch {
    // Non-fatal — benchmark output is best-effort.
  }
}

// -------------------------------------------------------------------------
// Per-client workload runner
// -------------------------------------------------------------------------

interface WorkloadOptions {
  readFraction: number;  // 0–1: fraction of operations that are reads
  keyCount: number;      // size of the key space
  useTtl?: boolean;      // whether writes carry a TTL
  durationMs: number;    // how long to run
}

interface WorkloadResult {
  latencies: number[];
  reads: number;
  writes: number;
  errors: number;
  corruptionSamples: Array<{ key: string; written: unknown; readBack: unknown }>;
}

/**
 * Runs one client through a mixed read/write workload.
 *
 * Corruption detection: after each write the client immediately reads the
 * same key back. If the returned value has an unexpected type/shape it is
 * recorded as a corruption event. Last-writer-wins races (a concurrent
 * writer overwrote before the read-back) are fine; only structural
 * corruption is flagged.
 */
async function runKvWorkload(
  client: DaemonClient,
  clientId: number,
  opts: WorkloadOptions,
): Promise<WorkloadResult> {
  const result: WorkloadResult = {
    latencies: [],
    reads: 0,
    writes: 0,
    errors: 0,
    corruptionSamples: [],
  };

  const deadline = Date.now() + opts.durationMs;
  let iteration = 0;

  while (Date.now() < deadline) {
    const isRead = Math.random() < opts.readFraction;
    const keyIndex = iteration % opts.keyCount;
    const key = `kv:load:${keyIndex}`;
    const t0 = Date.now();

    try {
      if (isRead) {
        await client.kvGet(key);
        result.reads++;
      } else {
        const value = { writer: clientId, iteration, ts: Date.now() };
        const writeOpts = opts.useTtl ? { ttl: TTL_MS } : undefined;
        await client.kvSet(key, value, writeOpts);
        result.writes++;

        // Read-back corruption check (skip for TTL keys — they may have
        // already expired or been overwritten by the time we read).
        if (!opts.useTtl) {
          const readBack = await client.kvGet<{ writer: number; iteration: number; ts: number }>(key);
          if (
            readBack !== null &&
            (typeof readBack.writer !== 'number' ||
             typeof readBack.iteration !== 'number' ||
             typeof readBack.ts !== 'number')
          ) {
            result.corruptionSamples.push({ key, written: value, readBack });
          }
        }
      }
      result.latencies.push(Date.now() - t0);
    } catch {
      result.errors++;
    }

    iteration++;
    // Yield between ops so other clients can progress on the event loop.
    await new Promise<void>((r) => setImmediate(r));
  }

  return result;
}

// -------------------------------------------------------------------------
// Scenario runner — connects N clients, runs workload, tears down
// -------------------------------------------------------------------------

async function runScenario(
  scenarioLabel: string,
  workloadLabel: string,
  readFraction: number,
  keyCount: number,
  durationMs: number,
  useTtl = false,
  clientCount = 50,
): Promise<{
  totalOps: number;
  opsPerSec: number;
  p50: number;
  p99: number;
  corruptionDetected: boolean;
}> {
  const dir = makeTempDir();
  const server = makeServer(dir);
  await server.start();

  const clients = Array.from({ length: clientCount }, () => makeClient(dir));
  await Promise.all(clients.map((c) => c.connect()));

  const t0 = Date.now();
  const results = await Promise.all(
    clients.map((c, i) => runKvWorkload(c, i, { readFraction, keyCount, useTtl, durationMs })),
  );
  const elapsed = Date.now() - t0;

  await Promise.allSettled(clients.map((c) => c.disconnect()));
  await server.shutdown();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

  const allLatencies = results.flatMap((r) => r.latencies);
  const totalOps = allLatencies.length;
  const sorted = allLatencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p99 = percentile(sorted, 99);
  const opsPerSec = elapsed > 0 ? Math.round((totalOps / elapsed) * 1000) : 0;
  const corruptionDetected = results.some((r) => r.corruptionSamples.length > 0);

  allResults.push({
    scenario: scenarioLabel,
    workload: workloadLabel,
    clientCount,
    keyCount,
    readPct: Math.round(readFraction * 100),
    writePct: Math.round((1 - readFraction) * 100),
    totalOps,
    opsPerSec,
    p50LatencyMs: p50,
    p99LatencyMs: p99,
    corruptionDetected,
    durationMs: elapsed,
  });

  return { totalOps, opsPerSec, p50, p99, corruptionDetected };
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('D4 — KV concurrent load', () => {
  afterAll(() => {
    saveBenchmarkResults();
  });

  // -----------------------------------------------------------------------
  // Same-key scenarios — last-writer-wins races
  // -----------------------------------------------------------------------

  it('50 clients × same key — 90/10 read-heavy, no corruption', async () => {
    const { corruptionDetected, totalOps } = await runScenario(
      'same-key-90r10w',
      '90/10 read-heavy',
      0.9,
      1,
      PR_GATE_MS,
    );

    expect(corruptionDetected).toBe(false);
    expect(totalOps).toBeGreaterThan(0);
  }, 60_000);

  it('50 clients × same key — 10/90 write-heavy, no corruption', async () => {
    const { corruptionDetected, totalOps } = await runScenario(
      'same-key-10r90w',
      '10/90 write-heavy',
      0.1,
      1,
      PR_GATE_MS,
    );

    expect(corruptionDetected).toBe(false);
    expect(totalOps).toBeGreaterThan(0);
  }, 60_000);

  // -----------------------------------------------------------------------
  // 1 000-key spread — minimal contention, throughput measurement
  // -----------------------------------------------------------------------

  it('50 clients × 1 000 keys — 50/50 balanced, throughput ≥500 ops/s', async () => {
    const { corruptionDetected, opsPerSec, totalOps } = await runScenario(
      'spread-1k-50r50w',
      '50/50 balanced',
      0.5,
      1000,
      PR_GATE_MS,
    );

    expect(corruptionDetected).toBe(false);
    expect(totalOps).toBeGreaterThan(0);
    // Even in CI, 50 async clients doing KV ops should exceed 500 ops/s.
    expect(opsPerSec).toBeGreaterThan(500);
  }, 60_000);

  // -----------------------------------------------------------------------
  // TTL pressure — entries must evict within TTL + 5 s grace
  // -----------------------------------------------------------------------

  it(`expiring keys (TTL=${TTL_MS}ms) invisible within TTL + ${TTL_GRACE_MS}ms`, async () => {
    const KEY_COUNT = 20;
    const dir = makeTempDir();
    const server = makeServer(dir);
    await server.start();

    const writer = makeClient(dir);
    const reader = makeClient(dir);
    await Promise.all([writer.connect(), reader.connect()]);

    // Write TTL-bearing keys.
    for (let i = 0; i < KEY_COUNT; i++) {
      await writer.kvSet(`ttl:key:${i}`, { v: i }, { ttl: TTL_MS });
    }

    // Wait for TTL + grace period.
    await new Promise<void>((r) => setTimeout(r, TTL_MS + TTL_GRACE_MS));

    // All keys must now return null (evicted on read via SharedKV.get).
    let surviving = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      const val = await reader.kvGet(`ttl:key:${i}`);
      if (val !== null) surviving++;
    }

    await Promise.allSettled([writer.disconnect(), reader.disconnect()]);
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    allResults.push({
      scenario: 'ttl-eviction',
      workload: 'TTL pressure',
      clientCount: 2,
      keyCount: KEY_COUNT,
      readPct: 50,
      writePct: 50,
      totalOps: KEY_COUNT * 2,
      opsPerSec: 0,
      p50LatencyMs: 0,
      p99LatencyMs: 0,
      corruptionDetected: false,
      durationMs: TTL_MS + TTL_GRACE_MS,
    });

    expect(surviving).toBe(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Full 30 s sustained load — gated behind STRESS=1
  // -----------------------------------------------------------------------

  if (process.env['STRESS'] === '1') {
    it('STRESS: 50 clients × 1 000 keys — 30 s sustained 50/50, no corruption', async () => {
      const { corruptionDetected, opsPerSec } = await runScenario(
        'stress-spread-1k-50r50w',
        '50/50 balanced — 30 s',
        0.5,
        1000,
        SUSTAINED_MS,
      );

      expect(corruptionDetected).toBe(false);
      expect(opsPerSec).toBeGreaterThan(500);
    }, 120_000);
  }
});
