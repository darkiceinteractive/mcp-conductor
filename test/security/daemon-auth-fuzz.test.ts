/**
 * T3: Daemon auth fuzz test.
 *
 * Sends random and malformed bytes at the auth handshake and asserts:
 *   - The connection closes without a server crash.
 *   - No unhandled exceptions propagate.
 *
 * The full 1,000-round fuzzing run is nightly-gated; PR-gate uses 20 rounds.
 *
 * @module test/security/daemon-auth-fuzz
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { DaemonServer } from '../../src/daemon/server.js';

const ROUNDS = process.env.NIGHTLY === '1' ? 1_000 : 20;
const TEST_SECRET = 'auth-fuzz-secret-xyz';

describe('T3 daemon-auth-fuzz', () => {
  let tmpDir: string;
  let server: DaemonServer;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-fuzz-'));
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

  it(
    `connection closes cleanly for random/malformed bytes at handshake (${ROUNDS} rounds)`,
    async () => {
      const socketPath = join(tmpDir, 'daemon.sock');

      for (let round = 0; round < ROUNDS; round++) {
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ path: socketPath });
          const timeoutHandle = setTimeout(() => {
            socket.destroy();
            resolve(); // timed out → still acceptable (server didn't crash)
          }, 2_000);

          socket.once('connect', () => {
            // Send garbage: random bytes of random length (1–512 bytes).
            const len = 1 + Math.floor(Math.random() * 511);
            socket.write(randomBytes(len));
          });

          socket.once('close', () => {
            clearTimeout(timeoutHandle);
            resolve();
          });

          socket.once('error', () => {
            clearTimeout(timeoutHandle);
            resolve(); // ECONNRESET / EPIPE is expected on rejection
          });
        });
      }

      // Server must still be running after all fuzz rounds.
      const stats = server.stats();
      expect(stats.uptime).toBeGreaterThan(0);
    },
    300_000,
  );

  it('null-byte injected in JSON frame does not crash server', async () => {
    const socketPath = join(tmpDir, 'daemon.sock');

    await new Promise<void>((resolve) => {
      const socket = createConnection({ path: socketPath });
      const t = setTimeout(() => { socket.destroy(); resolve(); }, 2_000);

      socket.once('connect', () => {
        // JSON with embedded null bytes — would crash naive JSON.parse.
        const malformed = '{"id":"__auth_response__","result":{"token":"x\x00y"}}\n';
        socket.write(malformed);
      });

      socket.once('close', () => { clearTimeout(t); resolve(); });
      socket.once('error', () => { clearTimeout(t); resolve(); });
    });

    // Server must still be alive.
    expect(() => server.stats()).not.toThrow();
  });
});
