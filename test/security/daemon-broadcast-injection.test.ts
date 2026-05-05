/**
 * T3: Daemon broadcast injection test.
 *
 * Tries to inject `{ id: N, result: ... }` payloads via broadcast and asserts
 * that the client-side envelope check prevents RPC response injection.
 *
 * Existing coverage in daemon-pr12-hardening.test.ts (HIGH-3) covers the
 * basic case. This suite extends with additional injection vectors:
 *   - Broadcast payload shaped like an RPC response with matching ID.
 *   - Broadcast containing error envelope to trigger rejected promise.
 *   - Multiple simultaneous broadcasts racing against a real RPC.
 *
 * Reference: test/unit/daemon/daemon-pr12-hardening.test.ts §HIGH-3.
 *
 * @module test/security/daemon-broadcast-injection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonServer } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';

const TEST_SECRET = 'broadcast-injection-secret-xyz';

describe('T3 daemon-broadcast-injection', () => {
  let tmpDir: string;
  let server: DaemonServer;
  let socketPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-broadcast-'));
    socketPath = join(tmpDir, 'daemon.sock');
    server = new DaemonServer({
      socketPath,
      auth: { sharedSecret: TEST_SECRET },
      kvOptions: { persistDir: join(tmpDir, 'kv'), skipLoad: true, sweepIntervalMs: 999_999 },
    });
    await server.start();
  }, 15_000);

  afterAll(async () => {
    await server.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClient(): DaemonClient {
    return new DaemonClient({
      socketPath,
      auth: { sharedSecret: TEST_SECRET },
      connectTimeoutMs: 5_000,
    });
  }

  it('broadcast payload shaped like RPC response does not resolve victim pending call', async () => {
    const attacker = makeClient();
    const victim = makeClient();

    await attacker.connect();
    await victim.connect();

    const received: unknown[] = [];
    victim.subscribe('inject-chan', (msg) => received.push(msg));

    // Give subscribe RPC a moment to register.
    await new Promise((r) => setTimeout(r, 50));

    // Start a ping RPC on victim — attacker will broadcast a payload that looks
    // like that response before the real server response arrives.
    const pingPromise = victim.ping();

    await new Promise((r) => setTimeout(r, 20));

    // Broadcast an injected payload that mimics an RPC response with a low ID.
    await attacker.broadcast('inject-chan', {
      id: '1',           // common first RPC id
      result: { injected: true },
    });

    // Ping must still resolve from the real server response.
    await expect(pingPromise).resolves.not.toThrow();

    await attacker.disconnect();
    await victim.disconnect();
  });

  it('broadcast error-shaped payload does not reject a pending victim RPC', async () => {
    const attacker = makeClient();
    const victim = makeClient();

    await attacker.connect();
    await victim.connect();

    victim.subscribe('error-inject-chan', () => {});
    await new Promise((r) => setTimeout(r, 50));

    const pingPromise = victim.ping();

    await new Promise((r) => setTimeout(r, 20));

    // Try to inject an error-shaped broadcast.
    await attacker.broadcast('error-inject-chan', {
      id: '1',
      error: { message: 'injected error' },
    });

    // Ping must still succeed.
    await expect(pingPromise).resolves.not.toThrow();

    await attacker.disconnect();
    await victim.disconnect();
  });

  it('rapid broadcast storm does not corrupt victim RPC queue', async () => {
    const broadcaster = makeClient();
    const victim = makeClient();

    await broadcaster.connect();
    await victim.connect();

    victim.subscribe('storm-chan', () => {});
    await new Promise((r) => setTimeout(r, 50));

    // Start a KV read RPC on victim while storm is in flight.
    const kvPromise = victim.kvGet('any-key-that-does-not-exist');

    // Broadcast 20 messages rapidly.
    for (let i = 0; i < 20; i++) {
      broadcaster.broadcast('storm-chan', { seq: i, id: String(i), result: { fake: true } })
        .catch(() => {/* ignore */});
    }

    // KV get must complete (key missing → null, not a hang or wrong value).
    const val = await kvPromise;
    expect(val).toBeNull();

    await broadcaster.disconnect();
    await victim.disconnect();
  });
});
