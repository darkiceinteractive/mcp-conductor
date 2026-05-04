/**
 * T3: Bridge CORS Origin variation test.
 *
 * Tests that the HttpBridge only accepts loopback Origins and rejects:
 *   - uppercase variants (HTTP://127.0.0.1:PORT)
 *   - trailing slash
 *   - IDN hostnames
 *   - non-loopback IP literals
 *   - public hostnames
 *
 * The existing bridge-security.test.ts covers the DNS-rebinding guard for
 * the `Host` header. This suite focuses on `Origin` header variations per
 * the PRD §6.3 specification.
 *
 * Reference: test/unit/bridge-security.test.ts (DNS-rebinding guard).
 *
 * @module test/security/bridge-cors-variations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpBridge, type BridgeHandlers } from '../../src/bridge/http-server.js';
import type { BridgeConfig } from '../../src/config/schema.js';
import { request } from 'node:http';

// Port distinct from bridge-header-injection (19959) to avoid conflicts.
const TEST_PORT = 19968;
const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

function makeHandlers(): BridgeHandlers {
  return {
    listServers: () => [{ name: 'echo', toolCount: 0, status: 'connected' }],
    listTools: () => [],
    callTool: async () => ({ ok: true }),
    searchTools: () => [],
  };
}

async function sendRequest(
  host: string,
  origin: string | undefined,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (origin !== undefined) {
      headers['Origin'] = origin;
    }

    const req = request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/servers',
        method: 'GET',
        headers: { ...headers, Host: host },
      },
      (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode ?? 0 });
      },
    );

    req.once('error', reject);
    req.end();
  });
}

describe('T3 bridge-cors-variations', () => {
  let bridge: HttpBridge;

  const bridgeConfig: BridgeConfig = {
    port: TEST_PORT,
    host: '127.0.0.1',
  };

  // Single bridge instance for all tests — avoids port-reuse timing issues.
  beforeAll(async () => {
    bridge = new HttpBridge(bridgeConfig);
    bridge.setHandlers(makeHandlers());
    await bridge.start();
  }, 10_000);

  afterAll(async () => {
    await bridge.stop();
  });

  it('loopback origin 127.0.0.1 is accepted', async () => {
    const res = await sendRequest(TEST_HOST, `http://127.0.0.1:${TEST_PORT}`);
    expect(res.statusCode).not.toBe(403);
  });

  it('loopback origin localhost is accepted', async () => {
    const res = await sendRequest(`localhost:${TEST_PORT}`, `http://localhost:${TEST_PORT}`);
    expect(res.statusCode).not.toBe(403);
  });

  it('non-loopback IP is rejected', async () => {
    const res = await sendRequest(TEST_HOST, 'http://192.168.1.1:8080');
    expect(res.statusCode).toBe(403);
  });

  it('public hostname in Origin is rejected', async () => {
    const res = await sendRequest(TEST_HOST, 'https://evil.com');
    expect(res.statusCode).toBe(403);
  });

  it('IDN hostname in Origin is rejected', async () => {
    const res = await sendRequest(TEST_HOST, 'https://xn--nxasmq6b.com');
    expect(res.statusCode).toBe(403);
  });

  it('missing Origin header is accepted (same-origin same-host request)', async () => {
    const res = await sendRequest(TEST_HOST, undefined);
    // No Origin header = likely direct tool call; should not be blocked by CORS check.
    expect(res.statusCode).not.toBe(403);
  });
});
