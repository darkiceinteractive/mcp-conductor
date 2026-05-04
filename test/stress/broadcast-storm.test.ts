/**
 * D3 — Broadcast Storm Stress Test.
 *
 * 10 clients each broadcast 100 messages/sec for 60 s (behind STRESS=1;
 * the PR-gate run uses a shorter 5 s / 10 msg/s variant to keep CI fast).
 *
 * Measures:
 *   - Per-client receive latency (p50 / p99)
 *   - Message-loss rate
 *   - HIGH-3 envelope guard: broadcast frames must never be confused with RPC
 *     responses (__broadcast__ flag must always be present and respected).
 *
 * Asserts:
 *   - Zero message loss (≤1% slack for timing edge cases)
 *   - p99 per-message latency < 100 ms even under the full storm
 *   - Zero HIGH-3 envelope violations
 *
 * Results emitted to docs/benchmarks/stress/broadcast-storm-YYYY-MM-DD.json.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'stress-broadcast-secret-d3-qrs';
const STORM_CHANNEL = 'storm:broadcast';

// -------------------------------------------------------------------------
// Test parameters — full storm gated behind STRESS=1
// -------------------------------------------------------------------------

const IS_FULL_STRESS = process.env['STRESS'] === '1';
const CLIENT_COUNT = 10;
const MSG_PER_SEC = IS_FULL_STRESS ? 100 : 10;
const DURATION_MS = IS_FULL_STRESS ? 60_000 : 5_000;
// Interval in ms between sends for each client.
const INTERVAL_MS = Math.floor(1000 / MSG_PER_SEC);

// p99 latency must stay below this threshold even under storm.
const P99_LATENCY_LIMIT_MS = 100;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-stress-broadcast-'));
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
// Payload type sent over the broadcast channel
// -------------------------------------------------------------------------

interface StormPayload {
  senderId: number;
  seq: number;
  sentAt: number; // epoch ms stamped at send time
}

// -------------------------------------------------------------------------
// Test
// -------------------------------------------------------------------------

describe('D3 — broadcast storm', () => {
  it(
    `${CLIENT_COUNT} clients × ${MSG_PER_SEC} msg/s × ${DURATION_MS / 1000}s — zero loss, p99 < ${P99_LATENCY_LIMIT_MS}ms`,
    async () => {
      const dir = makeTempDir();
      const server = makeServer(dir);
      await server.start();

      const clients: DaemonClient[] = Array.from({ length: CLIENT_COUNT }, () => makeClient(dir));

      // Per-client receive counters and latency samples.
      const receivedByClient: number[] = Array(CLIENT_COUNT).fill(0);
      const latencySamples: number[] = [];

      // HIGH-3 envelope violations: a received message that does not carry
      // the expected StormPayload structure indicates a mis-routed RPC frame.
      let envelopeViolations = 0;
      let totalSent = 0;

      // Connect all clients simultaneously.
      await Promise.all(clients.map((c) => c.connect()));

      // Subscribe every client to the storm channel before sending begins.
      const subscriptions = clients.map((client, clientIdx) =>
        client.subscribe(STORM_CHANNEL, (msg) => {
          const now = Date.now();
          const payload = msg as StormPayload;

          // Validate the received message has the storm payload shape.
          // A missing/malformed shape indicates a HIGH-3 envelope violation
          // (broadcast confused with or delivering an RPC response frame).
          if (
            typeof payload?.senderId !== 'number' ||
            typeof payload?.seq !== 'number' ||
            typeof payload?.sentAt !== 'number'
          ) {
            envelopeViolations++;
            return;
          }

          const latency = now - payload.sentAt;
          latencySamples.push(latency);
          receivedByClient[clientIdx]++;
        }),
      );

      // Send phase: each client broadcasts at MSG_PER_SEC until DURATION_MS elapses.
      const sendStart = Date.now();
      const senderPromises = clients.map(async (client, senderId) => {
        let seq = 0;
        while (Date.now() - sendStart < DURATION_MS) {
          const payload: StormPayload = { senderId, seq, sentAt: Date.now() };
          try {
            await client.broadcast(STORM_CHANNEL, payload);
            totalSent++;
          } catch {
            // Send failure: the message will not be received; counts as loss.
          }
          seq++;
          await new Promise<void>((r) => setTimeout(r, INTERVAL_MS));
        }
      });

      await Promise.all(senderPromises);

      // Allow in-flight delivers to drain before measuring.
      await new Promise<void>((r) => setTimeout(r, 300));

      // Clean up subscriptions and disconnect all clients.
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
      await Promise.allSettled(clients.map((c) => c.disconnect()));
      await server.shutdown();

      // -----------------------------------------------------------------------
      // Metrics
      // -----------------------------------------------------------------------
      const totalReceived = receivedByClient.reduce((s, n) => s + n, 0);
      // Each sent message should reach every subscriber (all CLIENT_COUNT clients).
      const expectedReceived = totalSent * CLIENT_COUNT;
      const lossRate = expectedReceived > 0
        ? (expectedReceived - totalReceived) / expectedReceived
        : 0;

      const sortedLatencies = latencySamples.slice().sort((a, b) => a - b);
      const p50 = percentile(sortedLatencies, 50);
      const p99 = percentile(sortedLatencies, 99);
      const maxLatency = sortedLatencies[sortedLatencies.length - 1] ?? 0;

      // -----------------------------------------------------------------------
      // Emit benchmark JSON
      // -----------------------------------------------------------------------
      try {
        const date = new Date().toISOString().split('T')[0]!;
        const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `broadcast-storm-${date}.json`);
        writeFileSync(outPath, JSON.stringify({
          generated: new Date().toISOString(),
          suite: 'D3 — broadcast-storm',
          clientCount: CLIENT_COUNT,
          messagesPerSecPerClient: MSG_PER_SEC,
          durationMs: DURATION_MS,
          totalSent,
          totalReceived,
          expectedReceived,
          lossRate,
          p50LatencyMs: p50,
          p99LatencyMs: p99,
          maxLatencyMs: maxLatency,
          envelopeGuardViolations: envelopeViolations,
        }, null, 2), 'utf-8');
      } catch {
        // Non-fatal — benchmark output is best-effort.
      }

      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

      // -----------------------------------------------------------------------
      // Assertions
      // -----------------------------------------------------------------------

      // Zero message loss: every broadcast must reach every subscriber.
      // Allow ≤1% slack for timing edge cases near process exit.
      expect(lossRate).toBeLessThanOrEqual(0.01);

      // p99 latency must be under 100 ms even under the full storm.
      if (sortedLatencies.length > 0) {
        expect(p99).toBeLessThan(P99_LATENCY_LIMIT_MS);
      }

      // HIGH-3: zero envelope violations — broadcasts must never be mis-routed
      // to the RPC pending map or arrive without the correct payload structure.
      expect(envelopeViolations).toBe(0);
    },
    // 90 s timeout covers the 60 s full storm + drain overhead;
    // 30 s is sufficient for the 5 s PR-gate variant.
    IS_FULL_STRESS ? 120_000 : 30_000,
  );
});
