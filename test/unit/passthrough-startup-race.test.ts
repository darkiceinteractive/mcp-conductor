/**
 * Transport-first startup — ordering contract tests.
 *
 * Under the new design, start() connects the MCP transport BEFORE hub
 * initialisation completes. The static meta-tools (execute_code, set_mode,
 * get_metrics, …) are immediately reachable. Hub-backed tools (list_servers,
 * discover_tools, passthrough_call, <server>__<tool>) become available after
 * _runHubInit() finishes and emits notifications/tools/list_changed.
 *
 * Key assertions:
 *  1. _passthroughRegistrationComplete starts false (constructor does not set it).
 *  2. In mock mode, start() sets the flag true and resolves _hubInitPromise.
 *  3. isReady() reflects _passthroughRegistrationComplete.
 *  4. awaitReady() resolves after start() in mock mode.
 *  5. The SDK transport connects BEFORE _passthroughRegistrationComplete is true
 *     (in mock mode the flag is set synchronously after connect, so the check
 *     captures the pre-connect value).
 *
 * Vitest picks this file up via the `test/**‌/*.test.ts` glob in vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Helper: patch sdk server.connect so start() can run without binding a real
// stdio transport. Returns the flag value captured at connect time.
function patchSdkConnect(server: MCPExecutorServer): { connectCalled: () => boolean; flagAtConnectTime: () => boolean | undefined } {
  let called = false;
  let flagSnapshot: boolean | undefined;

  const sdkServer = (server as unknown as { server: { connect: (t: unknown) => Promise<void> } }).server;
  sdkServer.connect = async () => {
    called = true;
    flagSnapshot = server._passthroughRegistrationComplete;
  };

  return {
    connectCalled: () => called,
    flagAtConnectTime: () => flagSnapshot,
  };
}

describe('transport-first startup contract', () => {
  it('_passthroughRegistrationComplete starts as false before start()', () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    expect(server._passthroughRegistrationComplete).toBe(false);
  });

  it('isReady() returns false before start()', () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    expect(server.isReady()).toBe(false);
  });

  it('transport connects before _passthroughRegistrationComplete is true (transport-first)', async () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    const { connectCalled, flagAtConnectTime } = patchSdkConnect(server);

    await server.start();

    // Transport must have been connected.
    expect(connectCalled()).toBe(true);
    // In mock mode the flag is set AFTER server.connect() returns, so the
    // snapshot taken inside connect() must be false — proving the transport
    // connects before passthrough registration is marked complete.
    expect(flagAtConnectTime()).toBe(false);
  });

  it('isReady() is true after start() in mock mode', async () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    patchSdkConnect(server);

    await server.start();

    expect(server.isReady()).toBe(true);
    expect(server._passthroughRegistrationComplete).toBe(true);
  });

  it('awaitReady() resolves after start() in mock mode', async () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    patchSdkConnect(server);

    await server.start();

    // Should resolve without throwing.
    await expect(server.awaitReady()).resolves.toBeUndefined();
  });

  it('flag remains false after construction — only start() sets it true', () => {
    // Static tools (execute_code, set_mode, …) are registered synchronously in
    // the constructor. _passthroughRegistrationComplete must NOT be set during
    // construction — it is a start() concern only.
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    expect(server._passthroughRegistrationComplete).toBe(false);
  });
});
