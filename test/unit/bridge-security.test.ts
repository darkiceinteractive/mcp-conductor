import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpBridge, type BridgeHandlers } from '../../src/bridge/http-server.js';
import type { BridgeConfig } from '../../src/config/schema.js';

/**
 * DNS-rebinding guard tests. A page on evil.com can make a browser issue
 * requests to our bridge by resolving a hostname to 127.0.0.1, but the
 * Host/Origin headers will still carry the attacker's origin — so we
 * must reject those based on headers, not just the socket address.
 *
 * Reference: MCP spec 2025-03-26 Security Warning in the Transports section.
 */

describe('HttpBridge DNS-rebinding guard', () => {
  let bridge: HttpBridge;
  const TEST_PORT = 19848;
  const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

  const bridgeConfig: BridgeConfig = {
    port: TEST_PORT,
    host: '127.0.0.1',
  };

  const handlers: BridgeHandlers = {
    listServers: () => [{ name: 'echo', toolCount: 0, status: 'connected' }],
    listTools: () => [],
    callTool: async () => ({ ok: true }),
    searchTools: () => [],
  };

  beforeEach(async () => {
    bridge = new HttpBridge(bridgeConfig);
    bridge.setHandlers(handlers);
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it('accepts requests with a loopback Host header', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Host: TEST_HOST },
    });
    expect(response.status).toBe(200);
  });

  it('accepts requests with a loopback Origin header', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: `http://localhost:${TEST_PORT}` },
    });
    expect(response.status).toBe(200);
  });

  it('accepts 127.0.0.1 Origin', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: `http://127.0.0.1:${TEST_PORT}` },
    });
    expect(response.status).toBe(200);
  });

  it('accepts [::1] IPv6 loopback Origin', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: `http://[::1]:${TEST_PORT}` },
    });
    expect(response.status).toBe(200);
  });

  it('rejects foreign Origin with 403 (DNS rebinding defense)', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: 'http://evil.com' },
    });
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toMatch(/origin not allowed/i);
  });

  it('rejects malformed Origin with 403', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: 'not a valid URL at all' },
    });
    expect(response.status).toBe(403);
  });

  it('does not echo "*" as Access-Control-Allow-Origin', async () => {
    const response = await fetch(`http://${TEST_HOST}/health`, {
      headers: { Origin: `http://localhost:${TEST_PORT}` },
    });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});
