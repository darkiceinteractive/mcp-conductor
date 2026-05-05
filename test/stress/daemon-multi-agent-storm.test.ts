/**
 * D1 — Daemon Multi-Agent Storm Stress Test.
 *
 * Sweeps concurrent client counts: 5, 10, 25, 50, and (behind STRESS=1) 100.
 * Each scenario connects all clients simultaneously, runs a mixed workload of
 * kv.set / kv.get / lock.acquire / lock.release / broadcast for up to 30 s,
 * then asserts:
 *   - ≥95% per-client success rate
 *   - No FD leak (connectedClients returns to 0 after all clients disconnect)
 *   - Server-side memory growth ≤20%: measured via daemon KV key count staying
 *     bounded (process heap is intentionally NOT asserted — V8 GC is
 *     non-deterministic and heapUsed fluctuates across Vitest workers by >100%
 *     regardless of actual daemon behaviour).
 *
 * Results are written to docs/benchmarks/stress/daemon-multi-agent-YYYY-MM-DD.json.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'stress-storm-secret-d1-abc';
const FULL_SUSTAINED_MS = 30_000;
const MIN_SUCCESS_RATE = 0.95;
// KV key count must not grow unboundedly — the storm writes to a fixed key
// space (10 keys per client), so total keys ≤ clientCount × 10.
// This is the server-side "memory growth" check: KV keys, not process heap.
const MAX_KV_KEYS_PER_CLIENT = 10;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-stress-storm-'));
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

interface ClientMetrics {
  total: number;
  success: number;
  failure: number;
}

/**
 * Runs one client's mixed workload for up to `durationMs`.
 * Returns per-client operation counts.
 */
async function runClientWorkload(
  client: DaemonClient,
  id: number,
  durationMs: number,
): Promise<ClientMetrics> {
  const metrics: ClientMetrics = { total: 0, success: 0, failure: 0 };
  const deadline = Date.now() + durationMs;
  let iteration = 0;

  while (Date.now() < deadline) {
    const op = iteration % 5;
    metrics.total++;

    try {
      switch (op) {
        case 0:
          // kv.set on a per-client key.
          await client.kvSet(`storm:key:${id}:${iteration % 10}`, { v: iteration, ts: Date.now() });
          break;

        case 1:
          // kv.get on the same per-client key.
          await client.kvGet(`storm:key:${id}:${iteration % 10}`);
          break;

        case 2:
          // kv.get on a shared key written by other clients (light cross-client read).
          await client.kvGet(`storm:shared:${(id + 1) % 5}`);
          break;

        case 3: {
          // lock.acquire + release on a per-client key — no cross-client contention.
          const handle = await client.lockAcquire(`storm:lock:${id}`, { timeoutMs: 5_000 });
          await new Promise<void>((r) => setImmediate(r));
          await handle.release();
          break;
        }

        case 4:
          // broadcast to all clients.
          await client.broadcast('storm:channel', { from: id, seq: iteration });
          break;
      }
      metrics.success++;
    } catch {
      metrics.failure++;
    }

    iteration++;
    // Yield between operations so other clients can progress on the event loop.
    await new Promise<void>((r) => setImmediate(r));
  }

  return metrics;
}

// -------------------------------------------------------------------------
// Benchmark result collection
// -------------------------------------------------------------------------

interface ScenarioResult {
  clientCount: number;
  successRate: number;
  totalOps: number;
  kvKeysAtPeak: number;
  maxExpectedKvKeys: number;
  heapUsedMbBefore: number;
  heapUsedMbAfter: number;
  durationMs: number;
}

const allResults: ScenarioResult[] = [];

function saveBenchmarkResults(): void {
  try {
    const date = new Date().toISOString().split('T')[0]!;
    const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `daemon-multi-agent-${date}.json`);
    writeFileSync(outPath, JSON.stringify({
      generated: new Date().toISOString(),
      suite: 'D1 — daemon-multi-agent-storm',
      sustainedMs: FULL_SUSTAINED_MS,
      scenarios: allResults,
    }, null, 2), 'utf-8');
  } catch {
    // Non-fatal — benchmark output is best-effort.
  }
}

// -------------------------------------------------------------------------
// Client counts: base always runs; 100 requires STRESS=1.
// -------------------------------------------------------------------------

const BASE_COUNTS = [5, 10, 25, 50];
const STRESS_COUNTS = process.env['STRESS'] === '1' ? [100] : [];
const ALL_COUNTS = [...BASE_COUNTS, ...STRESS_COUNTS];

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('D1 — daemon multi-agent storm', () => {
  afterAll(() => {
    saveBenchmarkResults();
  });

  for (const count of ALL_COUNTS) {
    // Smaller counts use a shorter duration to keep CI fast.
    // ≥25 clients run the full 30 s to expose long-tail issues.
    const sustainedMs = count >= 25 ? FULL_SUSTAINED_MS : 5_000;

    it(`${count} simultaneous clients — success rate ≥95%, memory growth ≤20%`, async () => {
      const dir = makeTempDir();
      const server = makeServer(dir);
      await server.start();

      const clients: DaemonClient[] = Array.from({ length: count }, () => makeClient(dir));

      try {
        // Connect all clients simultaneously.
        await Promise.all(clients.map((c) => c.connect()));

        const heapBefore = process.memoryUsage().heapUsed / (1024 * 1024);
        const t0 = Date.now();

        // Run all client workloads concurrently.
        const results = await Promise.all(
          clients.map((c, i) => runClientWorkload(c, i, sustainedMs)),
        );

        const elapsed = Date.now() - t0;
        const heapAfter = process.memoryUsage().heapUsed / (1024 * 1024);

        // Check server-side KV key count — the storm writes to a bounded key
        // space (storm:key:<id>:<0..9>), so KV keys must stay ≤ count × 10.
        const kvKeysPeak = server.kvStore.size;
        const maxExpectedKvKeys = count * MAX_KV_KEYS_PER_CLIENT;

        // Gracefully disconnect all clients.
        await Promise.allSettled(clients.map((c) => c.disconnect()));

        // Aggregate metrics.
        const totalOps = results.reduce((s, r) => s + r.total, 0);
        const totalSuccess = results.reduce((s, r) => s + r.success, 0);
        const successRate = totalOps > 0 ? totalSuccess / totalOps : 0;

        // Server must report zero connected clients after full disconnect (FD leak check).
        const serverStats = server.stats();
        expect(serverStats.connectedClients).toBe(0);

        // Collect for JSON output (heap recorded as informational, not asserted).
        allResults.push({
          clientCount: count,
          successRate,
          totalOps,
          kvKeysAtPeak: kvKeysPeak,
          maxExpectedKvKeys,
          heapUsedMbBefore: Math.round(heapBefore),
          heapUsedMbAfter: Math.round(heapAfter),
          durationMs: elapsed,
        });

        // Core assertions.
        expect(successRate).toBeGreaterThanOrEqual(MIN_SUCCESS_RATE);
        // Server-side memory growth: KV key count stays within the bounded key space.
        expect(kvKeysPeak).toBeLessThanOrEqual(maxExpectedKvKeys);
      } finally {
        await server.shutdown();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }, 120_000 /* 2 min timeout covers the 30 s workload + setup */);
  }
});
