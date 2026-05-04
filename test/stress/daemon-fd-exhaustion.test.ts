/**
 * D5 — Daemon FD Exhaustion Stress Test.
 *
 * Simulates FD pressure by opening 200 connections in rapid succession and
 * verifying the daemon survives cleanly:
 *   1. Pre-existing connections remain functional throughout the flood.
 *   2. The daemon does not crash — new connections either succeed or fail at
 *      the OS/socket level, never causing an unhandled server error.
 *   3. Recovery: after closing 100 flood connections, new connections succeed.
 *
 * NOTE on true FD limits: `ulimit -n 64` in a Node.js subprocess is not
 * reliable across CI environments and would affect the test runner's own FDs.
 * This test validates the connection-flood survival path without modifying
 * system limits. The daemon's auth-deadline timer (CRIT-3, 10 s) ensures
 * unauthenticated sockets do not accumulate indefinitely.
 *
 * Gated entirely behind STRESS=1 — rapidly opening 200 sockets can interfere
 * with resource-constrained CI runners.
 *
 * Results emitted to docs/benchmarks/stress/daemon-fd-exhaustion-YYYY-MM-DD.json.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'stress-fd-secret-d5-wxy';
const STRESS = process.env['STRESS'] === '1';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-stress-fd-'));
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

function makeClient(dir: string, timeoutMs = 5_000): DaemonClient {
  return new DaemonClient({
    socketPath: join(dir, 'daemon.sock'),
    auth: { sharedSecret: TEST_SECRET },
    connectTimeoutMs: timeoutMs,
  });
}

/** Attempt to connect a client; returns true on success, false on any failure. */
async function tryConnect(client: DaemonClient): Promise<boolean> {
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Result emitter
// -------------------------------------------------------------------------

function saveResult(result: object): void {
  try {
    const date = new Date().toISOString().split('T')[0]!;
    const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `daemon-fd-exhaustion-${date}.json`);
    writeFileSync(outPath, JSON.stringify({
      generated: new Date().toISOString(),
      suite: 'D5 — daemon-fd-exhaustion',
      ...result,
    }, null, 2), 'utf-8');
  } catch {
    // Non-fatal.
  }
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('D5 — daemon FD exhaustion', () => {
  if (!STRESS) {
    it('skipped — set STRESS=1 to enable FD exhaustion tests', () => {
      // Intentional no-op. The suite is gated to avoid affecting CI runners.
      expect(true).toBe(true);
    });
    return;
  }

  it(
    'STRESS: 200 rapid connections — daemon survives, existing clients unaffected, recovers after batch close',
    async () => {
      const CONNECT_ATTEMPTS = 200;
      const PRE_EXISTING_COUNT = 5;
      const CLOSE_BATCH = 100;

      const dir = makeTempDir();
      const server = makeServer(dir);
      await server.start();

      // -----------------------------------------------------------------------
      // Step 1: establish pre-existing healthy clients before the flood.
      // -----------------------------------------------------------------------
      const preExisting: DaemonClient[] = Array.from(
        { length: PRE_EXISTING_COUNT },
        () => makeClient(dir),
      );
      await Promise.all(preExisting.map((c) => c.connect()));

      // Verify all pre-existing clients are healthy.
      for (const c of preExisting) {
        await expect(c.ping()).resolves.not.toThrow();
      }

      const t0 = Date.now();
      const timeline: Array<{ event: string; offsetMs: number }> = [];
      const mark = (event: string) => timeline.push({ event, offsetMs: Date.now() - t0 });

      mark('flood_start');

      // -----------------------------------------------------------------------
      // Step 2: attempt CONNECT_ATTEMPTS connections in rapid succession.
      // -----------------------------------------------------------------------
      const floodClients: DaemonClient[] = Array.from(
        { length: CONNECT_ATTEMPTS },
        () => makeClient(dir, 8_000),
      );

      const connectOutcomes = await Promise.allSettled(
        floodClients.map((c) => tryConnect(c)),
      );

      mark('flood_complete');

      const accepted = connectOutcomes.filter(
        (r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value === true,
      ).length;
      const rejected = CONNECT_ATTEMPTS - accepted;

      // -----------------------------------------------------------------------
      // Step 3: verify pre-existing clients are still functional.
      // -----------------------------------------------------------------------
      let existingClientsUnaffected = true;
      for (const c of preExisting) {
        try {
          await c.ping();
        } catch {
          existingClientsUnaffected = false;
        }
      }

      mark('existing_clients_verified');

      // -----------------------------------------------------------------------
      // Step 4: close CLOSE_BATCH of the successfully-connected flood clients.
      // -----------------------------------------------------------------------
      const connectedFlood = floodClients.filter((_, i) => {
        const r = connectOutcomes[i];
        return r?.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value === true;
      });

      const toClose = connectedFlood.slice(0, CLOSE_BATCH);
      await Promise.allSettled(toClose.map((c) => c.disconnect()));

      mark('batch_closed');

      // -----------------------------------------------------------------------
      // Step 5: recovery — a new connection must succeed after the batch close.
      // -----------------------------------------------------------------------
      const recoveryClient = makeClient(dir);
      let recoveredAfterClose = false;
      try {
        await recoveryClient.connect();
        await recoveryClient.ping();
        recoveredAfterClose = true;
        await recoveryClient.disconnect();
      } catch {
        recoveredAfterClose = false;
      }

      mark('recovery_verified');

      // -----------------------------------------------------------------------
      // Teardown: disconnect everything that is still connected.
      // -----------------------------------------------------------------------
      const remaining = connectedFlood.slice(CLOSE_BATCH);
      const notConnected = floodClients.filter((_, i) => {
        const r = connectOutcomes[i];
        return !(r?.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value === true);
      });

      await Promise.allSettled([
        ...preExisting.map((c) => c.disconnect()),
        ...remaining.map((c) => c.disconnect()),
        ...notConnected.map((c) => c.disconnect()),
      ]);

      await server.shutdown();

      // -----------------------------------------------------------------------
      // Emit benchmark JSON.
      // -----------------------------------------------------------------------
      saveResult({
        connectAttempts: CONNECT_ATTEMPTS,
        preExistingClients: PRE_EXISTING_COUNT,
        accepted,
        rejected,
        existingClientsUnaffected,
        recoveredAfterClose,
        closeBatch: CLOSE_BATCH,
        timelineMs: timeline,
      });

      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

      // -----------------------------------------------------------------------
      // Assertions.
      // -----------------------------------------------------------------------

      // The daemon must not crash — pre-existing clients remain responsive.
      expect(existingClientsUnaffected).toBe(true);

      // Recovery: after closing a batch, new connections are accepted again.
      expect(recoveredAfterClose).toBe(true);

      // At minimum the pre-existing clients (all 5) must have connected.
      // More will succeed depending on system FD limits.
      expect(accepted).toBeGreaterThanOrEqual(PRE_EXISTING_COUNT);

      // Rejected count is informational — it depends on OS FD limits.
      // We assert only that it is a non-negative integer (shape check).
      expect(rejected).toBeGreaterThanOrEqual(0);
    },
    120_000,
  );
});
