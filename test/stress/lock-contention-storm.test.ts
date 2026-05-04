/**
 * D2 — Lock Contention Storm Stress Test.
 *
 * Multiple agents fight for the same locks across four scenarios:
 *   1. 50 clients × 1 hot key  (maximum contention)
 *   2. 50 clients × 5 hot keys (spread contention)
 *   3. 50 clients × 50 keys   (low / no contention)
 *   4. Hostile: 50 clients × 1 key, no explicit release (daemon timeout path)
 *
 * Measures: p50/p99 acquire latency, fairness (longest-waiter time),
 * orphan release on disconnect.
 *
 * Asserts: no deadlocks (CRIT-3 + HIGH-2 hold under contention),
 * orphaned holds released within 1 s on disconnect.
 *
 * Results emitted to docs/benchmarks/stress/lock-contention-YYYY-MM-DD.json.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'stress-lock-secret-d2-xyz';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-stress-lock-'));
}

function makeServer(dir: string): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, 'daemon.sock'),
    auth: { sharedSecret: TEST_SECRET },
    kvOptions: {
      persistDir: join(dir, 'kv'),
      skipLoad: true,
      sweepIntervalMs: 999_999,
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

/** Returns the p-th percentile of a sorted array (0–100). */
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
  clientCount: number;
  keys: number;
  p50AcquireMs: number;
  p99AcquireMs: number;
  maxWaitMs: number;
  acquireCount: number;
  deadlockDetected: boolean;
  durationMs: number;
}

const allResults: ScenarioResult[] = [];

function saveBenchmarkResults(): void {
  try {
    const date = new Date().toISOString().split('T')[0]!;
    const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `lock-contention-${date}.json`);
    writeFileSync(outPath, JSON.stringify({
      generated: new Date().toISOString(),
      suite: 'D2 — lock-contention-storm',
      scenarios: allResults,
    }, null, 2), 'utf-8');
  } catch {
    // Non-fatal.
  }
}

// -------------------------------------------------------------------------
// Workload helpers
// -------------------------------------------------------------------------

/**
 * Acquires a lock on one of the pool keys (round-robin by client index),
 * holds for a brief moment, then releases.
 * Returns acquire latency in ms.
 */
async function doLockCycle(
  client: DaemonClient,
  keyPool: string[],
  clientIndex: number,
  timeoutMs: number,
): Promise<number> {
  const key = keyPool[clientIndex % keyPool.length]!;
  const t0 = Date.now();
  const handle = await client.lockAcquire(key, { timeoutMs });
  const latencyMs = Date.now() - t0;
  // Hold briefly to make contention measurable.
  await new Promise<void>((r) => setTimeout(r, 2));
  await handle.release();
  return latencyMs;
}

/**
 * Runs `iterations` lock cycles per client concurrently, collecting latency samples.
 */
async function runContentionWorkload(
  clients: DaemonClient[],
  keyPool: string[],
  iterations: number,
  lockTimeoutMs: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;

  await Promise.all(
    clients.map(async (client, idx) => {
      for (let i = 0; i < iterations; i++) {
        try {
          const lat = await doLockCycle(client, keyPool, idx, lockTimeoutMs);
          latencies.push(lat);
        } catch {
          errors++;
        }
      }
    }),
  );

  return { latencies, errors };
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('D2 — lock contention storm', () => {
  afterAll(() => {
    saveBenchmarkResults();
  });

  // -----------------------------------------------------------------------
  // Scenario 1: 50 × 1 hot key (maximum contention)
  // -----------------------------------------------------------------------
  it('50 clients × 1 hot key — no deadlock, p99 latency measured', async () => {
    const dir = makeTempDir();
    const server = makeServer(dir);
    await server.start();

    const CLIENT_COUNT = 50;
    const ITERATIONS = 3; // each client acquires 3×
    const KEY_POOL = ['billing'];

    const clients = Array.from({ length: CLIENT_COUNT }, () => makeClient(dir));
    await Promise.all(clients.map((c) => c.connect()));

    const t0 = Date.now();
    // 30 s timeout: with 50 waiters × 2 ms hold each the queue drains in ~100 ms.
    // 30 s is generous insurance against a slow CI runner.
    const { latencies, errors } = await runContentionWorkload(clients, KEY_POOL, ITERATIONS, 30_000);
    const elapsed = Date.now() - t0;

    await Promise.allSettled(clients.map((c) => c.disconnect()));
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    const sorted = latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const maxWait = sorted[sorted.length - 1] ?? 0;
    const expectedAcquires = CLIENT_COUNT * ITERATIONS;
    const deadlockDetected = latencies.length === 0;

    allResults.push({
      scenario: '50x1-hot-key',
      clientCount: CLIENT_COUNT,
      keys: KEY_POOL.length,
      p50AcquireMs: p50,
      p99AcquireMs: p99,
      maxWaitMs: maxWait,
      acquireCount: latencies.length,
      deadlockDetected,
      durationMs: elapsed,
    });

    // No deadlock: at least 95% of expected acquires must succeed.
    expect(deadlockDetected).toBe(false);
    expect(latencies.length).toBeGreaterThanOrEqual(Math.floor(expectedAcquires * 0.95));
    expect(errors).toBeLessThanOrEqual(Math.floor(expectedAcquires * 0.05));
  }, 120_000);

  // -----------------------------------------------------------------------
  // Scenario 2: 50 × 5 hot keys (spread contention)
  // -----------------------------------------------------------------------
  it('50 clients × 5 hot keys — contention spread, no deadlock', async () => {
    const dir = makeTempDir();
    const server = makeServer(dir);
    await server.start();

    const CLIENT_COUNT = 50;
    const ITERATIONS = 4;
    const KEY_POOL = ['k0', 'k1', 'k2', 'k3', 'k4'];

    const clients = Array.from({ length: CLIENT_COUNT }, () => makeClient(dir));
    await Promise.all(clients.map((c) => c.connect()));

    const t0 = Date.now();
    const { latencies, errors } = await runContentionWorkload(clients, KEY_POOL, ITERATIONS, 20_000);
    const elapsed = Date.now() - t0;

    await Promise.allSettled(clients.map((c) => c.disconnect()));
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    const sorted = latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const maxWait = sorted[sorted.length - 1] ?? 0;
    const expectedAcquires = CLIENT_COUNT * ITERATIONS;
    const deadlockDetected = latencies.length === 0;

    allResults.push({
      scenario: '50x5-spread-keys',
      clientCount: CLIENT_COUNT,
      keys: KEY_POOL.length,
      p50AcquireMs: p50,
      p99AcquireMs: p99,
      maxWaitMs: maxWait,
      acquireCount: latencies.length,
      deadlockDetected,
      durationMs: elapsed,
    });

    expect(deadlockDetected).toBe(false);
    expect(latencies.length).toBeGreaterThanOrEqual(Math.floor(expectedAcquires * 0.95));
    expect(errors).toBeLessThanOrEqual(Math.floor(expectedAcquires * 0.05));
  }, 120_000);

  // -----------------------------------------------------------------------
  // Scenario 3: 50 × 50 keys (low / no contention)
  // -----------------------------------------------------------------------
  it('50 clients × 50 keys — low contention, fast acquisition', async () => {
    const dir = makeTempDir();
    const server = makeServer(dir);
    await server.start();

    const CLIENT_COUNT = 50;
    const ITERATIONS = 5;
    // One key per client — zero cross-client contention.
    const KEY_POOL = Array.from({ length: 50 }, (_, i) => `nocontend:${i}`);

    const clients = Array.from({ length: CLIENT_COUNT }, () => makeClient(dir));
    await Promise.all(clients.map((c) => c.connect()));

    const t0 = Date.now();
    const { latencies, errors } = await runContentionWorkload(clients, KEY_POOL, ITERATIONS, 5_000);
    const elapsed = Date.now() - t0;

    await Promise.allSettled(clients.map((c) => c.disconnect()));
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    const sorted = latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const maxWait = sorted[sorted.length - 1] ?? 0;
    const deadlockDetected = latencies.length === 0;

    allResults.push({
      scenario: '50x50-low-contention',
      clientCount: CLIENT_COUNT,
      keys: KEY_POOL.length,
      p50AcquireMs: p50,
      p99AcquireMs: p99,
      maxWaitMs: maxWait,
      acquireCount: latencies.length,
      deadlockDetected,
      durationMs: elapsed,
    });

    // Zero contention — all acquires succeed, p50 well under 1 s.
    expect(deadlockDetected).toBe(false);
    expect(errors).toBe(0);
    expect(p50).toBeLessThan(1_000);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Scenario 4: Hostile — client holds lock indefinitely; orphan release on disconnect
  // -----------------------------------------------------------------------
  it('orphaned hold released within 1 s on client disconnect', async () => {
    const dir = makeTempDir();
    const server = makeServer(dir);
    await server.start();

    const LOCK_KEY = 'hostile:billing';

    // Client A acquires and never releases.
    const clientA = makeClient(dir);
    await clientA.connect();
    await clientA.lockAcquire(LOCK_KEY, { timeoutMs: 5_000 });

    // Client B queues for the same lock.
    const clientB = makeClient(dir);
    await clientB.connect();

    const acquireStart = Date.now();
    const acquirePromise = clientB.lockAcquire(LOCK_KEY, { timeoutMs: 5_000 });

    // Give B time to enter the wait queue, then disconnect A abruptly.
    await new Promise<void>((r) => setTimeout(r, 50));
    await clientA.disconnect();

    // B must acquire within 1 s of A disconnecting.
    const handle = await acquirePromise;
    const orphanReleaseMs = Date.now() - acquireStart;
    await handle.release();

    await clientB.disconnect();
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

    allResults.push({
      scenario: 'hostile-orphan-release',
      clientCount: 2,
      keys: 1,
      p50AcquireMs: orphanReleaseMs,
      p99AcquireMs: orphanReleaseMs,
      maxWaitMs: orphanReleaseMs,
      acquireCount: 1,
      deadlockDetected: false,
      durationMs: orphanReleaseMs,
    });

    // Core assertion from spec: orphaned hold released within 1 s.
    expect(orphanReleaseMs).toBeLessThan(1_000);
  }, 30_000);
});
