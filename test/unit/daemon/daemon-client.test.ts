/**
 * Unit tests for DaemonClient — verifies Unix socket and TCP connectivity,
 * KV and lock round-trips, and pub/sub delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../../src/daemon/server.js';
import { DaemonClient } from '../../../src/daemon/client.js';

const TEST_SECRET = 'client-test-secret-xyz789';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-client-test-'));
}

function makeServer(dir: string, tcpPort?: number): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, 'daemon.sock'),
    tcpPort,
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

describe('DaemonClient', () => {
  let dir: string;
  let server: DaemonServer;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = makeTempDir();
    server = makeServer(dir);
    await server.start();
    client = makeClient(dir);
    await client.connect();
  });

  afterEach(async () => {
    try { await client.disconnect(); } catch { /* ignore */ }
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Basic connectivity
  // ---------------------------------------------------------------------------

  describe('connect over Unix socket', () => {
    it('ping succeeds after connect', async () => {
      await expect(client.ping()).resolves.not.toThrow();
    });
  });

  describe('connect over TCP', () => {
    it('client connects and pings via TCP', async () => {
      const tcpPort = 19200 + Math.floor(Math.random() * 500);
      const tcpDir = makeTempDir();
      const tcpServer = makeServer(tcpDir, tcpPort);
      await tcpServer.start();

      const tcpClient = new DaemonClient({
        tailscaleAddress: `127.0.0.1:${tcpPort}`,
        auth: { sharedSecret: TEST_SECRET },
        connectTimeoutMs: 3000,
      });

      try {
        await tcpClient.connect();
        await expect(tcpClient.ping()).resolves.not.toThrow();
      } finally {
        await tcpClient.disconnect();
        await tcpServer.shutdown();
        try { rmSync(tcpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // KV round-trips
  // ---------------------------------------------------------------------------

  describe('callTool roundtrips correctly', () => {
    it('kv set then get', async () => {
      await client.kvSet('hello', 'world');
      const val = await client.kvGet<string>('hello');
      expect(val).toBe('world');
    });

    it('kv get returns null for missing key', async () => {
      const val = await client.kvGet('nonexistent');
      expect(val).toBeNull();
    });

    it('kv delete removes key', async () => {
      await client.kvSet('del-me', 42);
      await client.kvDelete('del-me');
      expect(await client.kvGet('del-me')).toBeNull();
    });

    it('kv list with prefix', async () => {
      await client.kvSet('app:a', 1);
      await client.kvSet('app:b', 2);
      await client.kvSet('other', 3);
      const keys = await client.kvList('app:');
      expect(keys.sort()).toEqual(['app:a', 'app:b']);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-client sharing
  // ---------------------------------------------------------------------------

  describe('cross-client read after write', () => {
    it('second client sees value written by first', async () => {
      const client2 = makeClient(dir);
      await client2.connect();

      await client.kvSet('shared-key', 'from-client-1');
      const val = await client2.kvGet<string>('shared-key');
      expect(val).toBe('from-client-1');

      await client2.disconnect();
    });
  });

  // ---------------------------------------------------------------------------
  // Pub/sub
  // ---------------------------------------------------------------------------

  describe('broadcast and subscribe', () => {
    it('broadcast delivers to subscriber on same client', async () => {
      const received: unknown[] = [];
      const sub = client.subscribe('chan', (msg) => received.push(msg));

      await client.broadcast('chan', { data: 'hello' });

      // Wait a tick for the push to arrive.
      await new Promise((r) => setTimeout(r, 50));
      sub.unsubscribe();

      expect(received).toContainEqual({ data: 'hello' });
    });
  });
});
