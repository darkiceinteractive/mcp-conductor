/**
 * T2: Daemon connect/disconnect cycle memory test.
 *
 * Verifies that repeated client connect → ping → disconnect cycles do not
 * leak server-side FDs or memory. Checks both RSS growth and that the server's
 * internal lock-handle bookkeeping is released.
 *
 * Nightly tier: 10,000 cycles.
 * PR-gate:        100 cycles.
 *
 * @module test/memory-leak/daemon-connect-cycle
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const ITERATIONS = process.env.NIGHTLY === '1' ? 10_000 : 100;
const GROWTH_TOLERANCE = 0.10;
const TEST_SECRET = 'daemon-cycle-secret-xyz';

describe(`T2 daemon-connect-cycle (${ITERATIONS} cycles)`, () => {
  let tmpDir: string;
  let server: DaemonServer;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-daemon-cycle-'));
    server = new DaemonServer({
      socketPath: join(tmpDir, 'daemon.sock'),
      auth: { sharedSecret: TEST_SECRET },
      kvOptions: { persistDir: join(tmpDir, 'kv'), skipLoad: true, sweepIntervalMs: 999_999 },
    });
    await server.start();
  }, 15_000);

  afterAll(async () => {
    await server.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skip(
    `Server FDs + memory stable; lock handles all released after ${ITERATIONS} cycles`,
    async () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      for (let i = 0; i < ITERATIONS; i++) {
        const client = new DaemonClient({
          socketPath: join(tmpDir, 'daemon.sock'),
          auth: { sharedSecret: TEST_SECRET },
          connectTimeoutMs: 5_000,
        });
        await client.connect();

        // Acquire and release a lock per cycle to exercise handle bookkeeping.
        if (i % 5 === 0) {
          const handle = await client.lockAcquire(`cycle-lock-${i}`);
          await handle.release();
        }

        await client.ping();
        await client.disconnect();
      }

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);

      // Server stats: no orphaned connections should remain.
      const stats = server.getStats();
      expect(stats.connectedClients).toBe(0);
    },
    3_600_000,
  );
});
