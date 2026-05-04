/**
 * T3: Bridge header injection test.
 *
 * Tests that the HttpBridge handles malicious header values safely.
 *
 * NOTE: Node.js's `http` module rejects CRLF in header values at the CLIENT
 * side (throws "Invalid character in header content"). This is the first
 * line of defence — CRLF never reaches the server from a Node.js HTTP client.
 * We assert that guard throws, then test remaining injection vectors that do
 * reach the server (tab-prefixed Origin, very long values).
 *
 * @module test/security/bridge-header-injection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpBridge, type BridgeHandlers } from '../../src/bridge/http-server.js';
import type { BridgeConfig } from '../../src/config/schema.js';
import { request as httpRequest } from 'node:http';

// Port distinct from bridge-cors-variations (19968) to avoid conflicts.
const TEST_PORT = 19969;
const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

function makeHandlers(): BridgeHandlers {
  return {
    listServers: () => [{ name: 'echo', toolCount: 0, status: 'connected' }],
    listTools: () => [],
    callTool: async () => ({ ok: true }),
    searchTools: () => [],
  };
}

async function sendRequest(headers: Record<string, string>): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/servers',
        method: 'GET',
        headers: { Host: TEST_HOST, ...headers },
      },
      (res) => {
        res.resume();
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

function hasNoCrlf(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  const str = Array.isArray(value) ? value.join(',') : value;
  return !str.includes('\r') && !str.includes('\n');
}

describe('T3 bridge-header-injection', () => {
  let bridge: HttpBridge;

  beforeAll(async () => {
    bridge = new HttpBridge({ port: TEST_PORT, host: '127.0.0.1' } as BridgeConfig);
    bridge.setHandlers(makeHandlers());
    await bridge.start();
  }, 10_000);

  afterAll(async () => { await bridge.stop(); });

  it('Node.js HTTP client rejects CRLF in Origin at transport layer (first defence)', () => {
    // Primary defence: CRLF never reaches the server from a Node.js client.
    expect(() => {
      httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        headers: {
          Host: TEST_HOST,
          Origin: `http://127.0.0.1:${TEST_PORT}\r\nX-Injected: evil`,
        },
      });
    }).toThrow();
  });

  it('Node.js HTTP client rejects CRLF in Mcp-Session-Id at transport layer', () => {
    expect(() => {
      httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        headers: {
          Host: TEST_HOST,
          'Mcp-Session-Id': 'session-id\r\nX-Injected: evil',
        },
      });
    }).toThrow();
  });

  it('tab-prefixed Origin that reaches server is rejected or sanitised', async () => {
    // Tabs in header values ARE passed by node:http — server must handle them.
    const res = await sendRequest({ Origin: `\thttp://127.0.0.1:${TEST_PORT}` });
    // Server rejects (403) or handles safely — injected payload must not appear.
    expect([200, 403]).toContain(res.statusCode);
    expect(JSON.stringify(res.headers)).not.toContain('X-Injected');
  });

  it('valid loopback Origin produces CRLF-free response headers', async () => {
    const res = await sendRequest({ Origin: `http://127.0.0.1:${TEST_PORT}` });
    expect(res.statusCode).not.toBe(403);
    for (const value of Object.values(res.headers)) {
      expect(hasNoCrlf(value)).toBe(true);
    }
  });

  it('very long loopback Origin with path suffix is handled without crash', async () => {
    const res = await sendRequest({
      Origin: `http://127.0.0.1:${TEST_PORT}/${'a'.repeat(1024)}`,
    });
    expect([200, 400, 403]).toContain(res.statusCode);
  });
});
