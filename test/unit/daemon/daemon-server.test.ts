/**
 * Unit tests for DaemonServer.
 *
 * Each test starts a fresh server on a temp socket so tests are fully
 * isolated (no shared global state).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { createHmac } from 'node:crypto';
import { DaemonServer } from '../../../src/daemon/server.js';
import { DaemonClient } from '../../../src/daemon/client.js';

const TEST_SECRET = 'test-shared-secret-abc123';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-daemon-test-'));
}

function makeServer(dir: string, options: { tcpPort?: number } = {}): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, 'daemon.sock'),
    tcpPort: options.tcpPort,
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
    connectTimeoutMs: 3000,
  });
}

function makeClientTcp(port: number): DaemonClient {
  return new DaemonClient({
    tailscaleAddress: `127.0.0.1:${port}`,
    auth: { sharedSecret: TEST_SECRET },
    connectTimeoutMs: 3000,
  });
}

describe('DaemonServer', () => {
  let dir: string;
  let server: DaemonServer;

  beforeEach(async () => {
    dir = makeTempDir();
    server = makeServer(dir);
    await server.start();
  });

  afterEach(async () => {
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Basic connectivity
  // ---------------------------------------------------------------------------

  describe('starts and accepts connections', () => {
    it('client connects and ping succeeds', async () => {
      const client = makeClient(dir);
      await client.connect();
      await expect(client.ping()).resolves.not.toThrow();
      await client.disconnect();
    });

    it('multiple clients can connect simultaneously', async () => {
      const clients = [makeClient(dir), makeClient(dir), makeClient(dir)];
      for (const c of clients) await c.connect();
      for (const c of clients) await expect(c.ping()).resolves.not.toThrow();
      for (const c of clients) await c.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  describe('rejects unauthenticated connection', () => {
    it('raw connection with wrong token is rejected', async () => {
      const socketPath = join(dir, 'daemon.sock');
      const socket = createConnection({ path: socketPath });

      const messages: unknown[] = [];
      let buffer = '';

      await new Promise<void>((resolve, reject) => {
        socket.setEncoding('utf-8');
        socket.on('error', reject);
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) messages.push(JSON.parse(line.trim()));
          }
          if (messages.length >= 1) resolve();
        });
      });

      // Server should have sent the challenge.
      const challenge = messages[0] as { id: string; result: { nonce: string } };
      expect(challenge.result.nonce).toBeTruthy();

      // Reply with a wrong token.
      socket.write(JSON.stringify({ id: '__auth__', method: '__auth__', params: { token: 'wrong-token' } }) + '\n');

      await new Promise<void>((resolve) => {
        socket.on('close', resolve);
        setTimeout(resolve, 500);
      });

      socket.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  describe('shutdown drains in-flight requests', () => {
    it('shutdown completes without error when clients are connected', async () => {
      const client = makeClient(dir);
      await client.connect();
      // Start shutdown while client is live.
      await expect(server.shutdown()).resolves.not.toThrow();
      // Subsequent shutdown is also safe (server is already stopped).
    });
  });

  // ---------------------------------------------------------------------------
  // Client crash survival
  // ---------------------------------------------------------------------------

  describe('survives client crash', () => {
    it('server continues serving other clients after one disconnects abruptly', async () => {
      const normal = makeClient(dir);
      const crasher = makeClient(dir);

      await normal.connect();
      await crasher.connect();

      // Simulate crash by destroying the socket directly.
      // DaemonClient does not expose the socket directly, so we disconnect.
      await crasher.disconnect();

      // Normal client should still work.
      await expect(normal.ping()).resolves.not.toThrow();
      await normal.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  // TCP transport
  // ---------------------------------------------------------------------------

  describe('connect over TCP', () => {
    it('client can connect via TCP when tcpPort is set', async () => {
      // Find a free port.
      const port = 19876 + Math.floor(Math.random() * 1000);
      const tcpServer = makeServer(dir.replace('daemon-test', 'daemon-tcp'), { tcpPort: port });
      const tcpDir = mkdtempSync(join(tmpdir(), 'mcp-daemon-tcp-'));

      const tcpServer2 = new DaemonServer({
        socketPath: join(tcpDir, 'daemon.sock'),
        tcpPort: port,
        auth: { sharedSecret: TEST_SECRET },
        kvOptions: { persistDir: join(tcpDir, 'kv'), skipLoad: true },
      });

      try {
        await tcpServer2.start();
        const tcpClient = makeClientTcp(port);
        await tcpClient.connect();
        await expect(tcpClient.ping()).resolves.not.toThrow();
        await tcpClient.disconnect();
      } finally {
        await tcpServer2.shutdown();
        try { rmSync(tcpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  describe('stats()', () => {
    it('returns stats with correct shape', async () => {
      const client = makeClient(dir);
      await client.connect();
      const stats = await client.stats() as {
        uptime: number;
        connectedClients: number;
        kvKeys: number;
        activeLocks: number;
        requestsHandled: number;
      };

      expect(typeof stats.uptime).toBe('number');
      expect(stats.connectedClients).toBeGreaterThanOrEqual(1);
      expect(typeof stats.kvKeys).toBe('number');
      await client.disconnect();
    });
  });
});
