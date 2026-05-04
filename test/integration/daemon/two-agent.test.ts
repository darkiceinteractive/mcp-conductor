/**
 * Integration tests: two-agent coordination scenarios.
 *
 * These tests spin up a real DaemonServer on a temp socket and connect two
 * DaemonClient instances (simulating two Claude Code agents) to verify the
 * acceptance criteria from PRD §5 Phase 6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../../src/daemon/server.js';
import { DaemonClient } from '../../../src/daemon/client.js';

const TEST_SECRET = 'integration-test-secret-2a9f';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-2agent-'));
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
    connectTimeoutMs: 3000,
  });
}

describe('Two-agent integration', () => {
  let dir: string;
  let server: DaemonServer;
  let agentA: DaemonClient;
  let agentB: DaemonClient;

  beforeEach(async () => {
    dir = makeTempDir();
    server = makeServer(dir);
    await server.start();

    agentA = makeClient(dir);
    agentB = makeClient(dir);
    await agentA.connect();
    await agentB.connect();
  });

  afterEach(async () => {
    try { await agentA.disconnect(); } catch { /* ignore */ }
    try { await agentB.disconnect(); } catch { /* ignore */ }
    await server.shutdown();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // AC: two agents share the KV cache
  // ---------------------------------------------------------------------------

  describe('two-agent cache sharing scenario', () => {
    it("agent B's call hits cache populated by agent A", async () => {
      // Agent A writes.
      await agentA.kvSet('cache:result:abc', { answer: 42, source: 'agent-a' });

      // Agent B reads — should see the value without ever calling the origin.
      const cached = await agentB.kvGet<{ answer: number; source: string }>('cache:result:abc');
      expect(cached).not.toBeNull();
      expect(cached!.answer).toBe(42);
      expect(cached!.source).toBe('agent-a');
    });

    it('agent A can overwrite a value that agent B subsequently reads', async () => {
      await agentA.kvSet('shared', 'v1');
      expect(await agentB.kvGet('shared')).toBe('v1');

      await agentA.kvSet('shared', 'v2');
      expect(await agentB.kvGet('shared')).toBe('v2');
    });

    it('agent B survives agent A disconnecting', async () => {
      await agentA.kvSet('persistent', 'still-here');
      await agentA.disconnect();

      // Agent B should still read the shared value.
      const val = await agentB.kvGet<string>('persistent');
      expect(val).toBe('still-here');
    });
  });

  // ---------------------------------------------------------------------------
  // AC: lock primitive serialises concurrent writers
  // ---------------------------------------------------------------------------

  describe('two-agent lock contention scenario', () => {
    it('mutual exclusion — agents take turns under a shared lock', async () => {
      const log: string[] = [];
      let sharedCounter = 0;
      let maxObserved = 0;

      // Both agents try to increment a shared counter under a lock.
      const doWork = async (client: DaemonClient, label: string, n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          const handle = await client.lockAcquire('counter-lock', { timeoutMs: 5000 });
          try {
            sharedCounter++;
            maxObserved = Math.max(maxObserved, sharedCounter);
            log.push(`${label}:in`);
            await new Promise((r) => setTimeout(r, 2));
            log.push(`${label}:out`);
            sharedCounter--;
          } finally {
            await handle.release();
          }
        }
      };

      await Promise.all([
        doWork(agentA, 'A', 5),
        doWork(agentB, 'B', 5),
      ]);

      // Counter was always 1 inside the critical section.
      expect(maxObserved).toBe(1);
      // Total 10 critical sections completed.
      const ins = log.filter((l) => l.endsWith(':in'));
      expect(ins.length).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // AC: TTL expiry
  // ---------------------------------------------------------------------------

  describe('KV TTL expiry', () => {
    it('expired entry is invisible to a different agent', async () => {
      await agentA.kvSet('temp', 'expires-soon', { ttl: 30 });

      // Before expiry.
      expect(await agentB.kvGet('temp')).toBe('expires-soon');

      await new Promise((r) => setTimeout(r, 50));

      // After expiry.
      expect(await agentB.kvGet('temp')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // AC: auth rejects unauthenticated connections
  // ---------------------------------------------------------------------------

  describe('auth rejects bad secret', () => {
    it('client with wrong secret cannot connect', async () => {
      const badClient = new DaemonClient({
        socketPath: join(dir, 'daemon.sock'),
        auth: { sharedSecret: 'wrong-secret' },
        connectTimeoutMs: 2000,
      });

      await expect(badClient.connect()).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // AC: daemon survives one agent crashing
  // ---------------------------------------------------------------------------

  describe('daemon survives one agent crashing', () => {
    it('agent B continues to work after agent A disconnects abruptly', async () => {
      await agentA.disconnect();

      // Agent B should still be fully functional.
      await agentB.kvSet('survivor', 'yes');
      expect(await agentB.kvGet('survivor')).toBe('yes');
      await expect(agentB.ping()).resolves.not.toThrow();
    });
  });
});
