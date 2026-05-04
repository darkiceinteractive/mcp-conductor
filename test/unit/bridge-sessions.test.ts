import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpBridge, type BridgeHandlers } from '../../src/bridge/http-server.js';
import { SessionRegistry } from '../../src/bridge/session-registry.js';
import type { BridgeConfig } from '../../src/config/schema.js';

/**
 * Mcp-Session-Id header handling per MCP spec 2025-03-26 Streamable HTTP.
 *
 * The middleware deliberately bypasses sandbox-internal endpoints (`/call`,
 * `/log`, `/progress`, `/tool-event`, `/servers`, `/search`, `/streams`,
 * `/health`, `/stream/*`) — the Deno sandbox is not an MCP client and
 * tracking a session per fetch would saturate the registry on the hot
 * path. So the round-trip tests below hit `/session` (DELETE-only) and
 * `/mcp` (a non-sandbox path that falls through to the routing 404 after
 * middleware sets the header) to exercise session minting and validation.
 */

describe('HttpBridge Mcp-Session-Id header', () => {
  let bridge: HttpBridge;
  let TEST_HOST: string;

  const handlers: BridgeHandlers = {
    listServers: () => [{ name: 'echo', toolCount: 0, status: 'connected' }],
    listTools: () => [],
    callTool: async () => ({ ok: true }),
    searchTools: () => [],
  };

  beforeEach(async () => {
    // Dynamic port allocation avoids TIME_WAIT races between rapid
    // start/stop cycles across the tests in this file.
    const bridgeConfig: BridgeConfig = { port: 0, host: '127.0.0.1' };
    bridge = new HttpBridge(bridgeConfig);
    bridge.setHandlers(handlers);
    await bridge.start();
    TEST_HOST = `127.0.0.1:${bridge.getPort()}`;
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it('issues a new Mcp-Session-Id when the client omits the header (on a non-sandbox path)', async () => {
    const res = await fetch(`http://${TEST_HOST}/mcp`);
    // /mcp is not a registered route, so it 404s — but middleware ran first.
    expect(res.status).toBe(404);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(bridge.getSessionRegistry().size()).toBe(1);
  });

  it('honours an existing session id when the client presents a known one', async () => {
    const first = await fetch(`http://${TEST_HOST}/mcp`);
    const sessionId = first.headers.get('mcp-session-id')!;

    const second = await fetch(`http://${TEST_HOST}/mcp`, {
      headers: { 'Mcp-Session-Id': sessionId },
    });
    expect(second.headers.get('mcp-session-id')).toBe(sessionId);
    expect(bridge.getSessionRegistry().size()).toBe(1);
  });

  it('returns 404 with a session-error body when the client presents an unknown session id', async () => {
    const res = await fetch(`http://${TEST_HOST}/mcp`, {
      headers: { 'Mcp-Session-Id': 'deadbeef-dead-beef-dead-beefdeadbeef' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/session/i);
  });

  it('rejects malformed session ids (too long) by issuing a new one', async () => {
    const tooLong = 'a'.repeat(200);
    const res = await fetch(`http://${TEST_HOST}/mcp`, {
      headers: { 'Mcp-Session-Id': tooLong },
    });
    const issued = res.headers.get('mcp-session-id');
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(tooLong);
    expect(issued!.length).toBeLessThanOrEqual(128);
  });

  it('exposes Mcp-Session-Id via CORS Access-Control-Expose-Headers', async () => {
    const res = await fetch(`http://${TEST_HOST}/mcp`);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/mcp-session-id/i);
  });

  it('allows Mcp-Session-Id on preflight via Access-Control-Allow-Headers', async () => {
    const res = await fetch(`http://${TEST_HOST}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/mcp-session-id/i);
  });

  it('terminates a session on DELETE /session and subsequent requests with that id 404', async () => {
    const first = await fetch(`http://${TEST_HOST}/mcp`);
    const sessionId = first.headers.get('mcp-session-id')!;

    const del = await fetch(`http://${TEST_HOST}/session`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
    });
    expect(del.status).toBe(204);
    expect(bridge.getSessionRegistry().size()).toBe(0);

    const after = await fetch(`http://${TEST_HOST}/mcp`, {
      headers: { 'Mcp-Session-Id': sessionId },
    });
    expect(after.status).toBe(404);
  });

  it('DELETE /session with no session header mints then terminates a fresh session', async () => {
    const res = await fetch(`http://${TEST_HOST}/session`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(bridge.getSessionRegistry().size()).toBe(0);
  });

  it('does NOT mint a session for sandbox-internal paths (/call, /log, /progress, /tool-event, /servers, /search, /streams, /health, /stream/*)', async () => {
    // Hammering these paths must leave the registry empty — the original
    // session-per-fetch bug had each one minting a fresh UUID.
    const paths = [
      '/health',
      '/servers',
      '/streams',
      '/search?q=foo',
    ];
    for (const p of paths) {
      const res = await fetch(`http://${TEST_HOST}${p}`);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(res.status).toBeLessThan(500);
    }
    expect(bridge.getSessionRegistry().size()).toBe(0);

    // POSTs too
    const callRes = await fetch(`http://${TEST_HOST}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'echo', tool: 'noop', params: {} }),
    });
    expect(callRes.headers.get('mcp-session-id')).toBeNull();
    expect(bridge.getSessionRegistry().size()).toBe(0);
  });
});

describe('SessionRegistry', () => {
  it('creates cryptographically random UUIDs', () => {
    const registry = new SessionRegistry();
    const a = registry.create();
    const b = registry.create();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('expires sessions after the TTL', async () => {
    const registry = new SessionRegistry({ ttlMs: 10, cleanupIntervalMs: 1000, maxSessions: 10 });
    const id = registry.create();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.touch(id)).toBeUndefined();
  });

  it('evicts oldest session when at capacity', () => {
    const registry = new SessionRegistry({
      ttlMs: 60_000,
      cleanupIntervalMs: 60_000,
      maxSessions: 3,
    });
    const ids = [registry.create(), registry.create(), registry.create()];
    expect(registry.size()).toBe(3);
    registry.create(); // triggers eviction
    expect(registry.size()).toBe(3);
    expect(registry.touch(ids[0])).toBeUndefined();
    expect(registry.touch(ids[1])).toBeDefined();
    expect(registry.touch(ids[2])).toBeDefined();
  });

  it('sweep() removes expired sessions and returns the count', async () => {
    const registry = new SessionRegistry({ ttlMs: 10, cleanupIntervalMs: 60_000, maxSessions: 10 });
    registry.create();
    registry.create();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const removed = registry.sweep();
    expect(removed).toBe(2);
    expect(registry.size()).toBe(0);
  });

  it('terminate() returns false when the session is unknown', () => {
    const registry = new SessionRegistry();
    expect(registry.terminate('nope')).toBe(false);
  });

  it('stop() clears sessions and the timer', () => {
    const registry = new SessionRegistry();
    registry.start();
    registry.create();
    expect(registry.size()).toBe(1);
    registry.stop();
    expect(registry.size()).toBe(0);
  });
});
