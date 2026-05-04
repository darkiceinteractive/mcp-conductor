/**
 * B9: Daemon socket liveness check.
 *
 * Verifies that DaemonServer refuses to evict a running daemon when the
 * target socket path already has a live listener. A second start() on the
 * same socket path must throw rather than silently unlinking the socket and
 * killing the first daemon.
 *
 * Discovered by Vitest via test/**‌/*.test.ts glob (vitest.config.ts line 7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../../src/daemon/server.js';
import { DaemonClient } from '../../../src/daemon/client.js';

const TEST_SECRET = 'b9-liveness-test-secret-xyz';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-b9-test-'));
}

function makeServer(dir: string, sockName = 'daemon.sock'): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, sockName),
    auth: { sharedSecret: TEST_SECRET },
    kvOptions: {
      persistDir: join(dir, 'kv'),
      skipLoad: true,
      sweepIntervalMs: 999_999,
    },
  });
}

describe('B9: daemon socket liveness check before unlink', () => {
  let dir: string;
  let firstDaemon: DaemonServer;

  beforeEach(async () => {
    dir = makeTempDir();
    firstDaemon = makeServer(dir);
    await firstDaemon.start();
  });

  afterEach(async () => {
    await firstDaemon.shutdown().catch(() => { /* already down */ });
    rmSync(dir, { recursive: true, force: true });
  });

  it('second daemon on same socket throws with "refusing to evict" message', async () => {
    const secondDaemon = makeServer(dir);
    await expect(secondDaemon.start()).rejects.toThrow(/refusing to evict/i);
  });

  it('first daemon is still alive after second start() is rejected', async () => {
    const secondDaemon = makeServer(dir);
    await expect(secondDaemon.start()).rejects.toThrow(/refusing to evict/i);

    // First daemon must still respond to authenticated pings.
    const client = new DaemonClient({
      socketPath: join(dir, 'daemon.sock'),
      auth: { sharedSecret: TEST_SECRET },
      connectTimeoutMs: 2000,
    });
    await client.connect();
    await expect(client.ping()).resolves.not.toThrow();
    await client.disconnect();
  });

  it('second daemon starts successfully on a different socket path', async () => {
    // Confirms the liveness check is path-scoped: a different socket is fine.
    const secondDaemon = makeServer(dir, 'daemon2.sock');
    await expect(secondDaemon.start()).resolves.not.toThrow();
    await secondDaemon.shutdown();
  });
}, { timeout: 10_000 });
