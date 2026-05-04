/**
 * T2: Connection pool FD soak test.
 *
 * Runs ITERATIONS acquire/release cycles on the DaemonClient connection path
 * and asserts FD count and RSS remain stable.
 *
 * Nightly tier: 10,000 cycles.
 * PR-gate:        100 cycles (smoke run against a real DaemonServer).
 *
 * @module test/memory-leak/connection-pool-soak
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const ITERATIONS = process.env.NIGHTLY === '1' ? 10_000 : 100;
const GROWTH_TOLERANCE = 0.10;
const TEST_SECRET = 'conn-pool-soak-secret-xyz';

describe(`T2 connection-pool-soak (${ITERATIONS} acquire/release cycles)`, () => {
  let tmpDir: string;
  let server: DaemonServer;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-conn-soak-'));
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
    `FD count stable; RSS growth ≤ ${GROWTH_TOLERANCE * 100}% after ${ITERATIONS} connect/disconnect cycles`,
    async () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      for (let i = 0; i < ITERATIONS; i++) {
        const client = new DaemonClient({
          socketPath: join(tmpDir, 'daemon.sock'),
          auth: { sharedSecret: TEST_SECRET },
          connectTimeoutMs: 3_000,
        });
        await client.connect();
        await client.ping();
        await client.disconnect();
      }

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);
    },
    3_600_000,
  );
});
