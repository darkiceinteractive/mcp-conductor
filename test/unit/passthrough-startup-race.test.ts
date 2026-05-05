/**
 * B6: Passthrough startup race — ordering invariant test.
 *
 * Asserts that `registerPassthroughTools()` completes before the SDK
 * transport's `server.connect(transport)` is called. The
 * `_passthroughRegistrationComplete` flag on MCPExecutorServer is set
 * synchronously after passthrough registration and is checked in `start()`
 * immediately before `server.connect()`.
 *
 * Vitest picks this file up via the `test/**‌/*.test.ts` glob in vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Helper: patch bridge.start and sdk server.connect so start() can run
// without binding a real port or stdio transport.
function patchForTest(server: MCPExecutorServer): { onBridgeStart: (cb: () => void) => void } {
  let bridgeStartCallback: (() => void) | undefined;

  const bridge = (server as unknown as { bridge: { start: () => Promise<void> } }).bridge;
  const originalBridgeStart = bridge.start.bind(bridge);
  bridge.start = async () => {
    await originalBridgeStart();
    bridgeStartCallback?.();
  };

  const sdkServer = (server as unknown as { server: { connect: (t: unknown) => Promise<void> } }).server;
  sdkServer.connect = async () => { /* skip real stdio transport */ };

  return {
    onBridgeStart: (cb) => { bridgeStartCallback = cb; },
  };
}

describe('B6: passthrough startup ordering invariant', () => {
  it('_passthroughRegistrationComplete starts as false before start()', () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    expect(server._passthroughRegistrationComplete).toBe(false);
  });

  it('_passthroughRegistrationComplete is true before sdk transport connects', async () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    let flagAtConnectTime: boolean | undefined;

    // Capture flag value at the last async boundary before server.connect fires.
    const { onBridgeStart } = patchForTest(server);
    onBridgeStart(() => {
      flagAtConnectTime = server._passthroughRegistrationComplete;
    });

    await server.start();

    // Flag must be true at bridge.start time — which is before server.connect.
    expect(flagAtConnectTime).toBe(true);
  });

  it('B6 guard throws if flag is false at connect time (regression fence)', async () => {
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });

    // Sabotage: clear the flag after registration to simulate a hypothetical
    // future code path that bypasses registerPassthroughTools().
    const { onBridgeStart } = patchForTest(server);
    onBridgeStart(() => {
      server._passthroughRegistrationComplete = false;
    });

    await expect(server.start()).rejects.toThrow(
      'passthrough tool registration did not complete before transport connect'
    );
  });

  it('flag remains false after construction — only start() sets it true', () => {
    // The 24 static tools are registered synchronously in the constructor via
    // registerTools(). The _passthroughRegistrationComplete flag must NOT be
    // set during construction — it is exclusively a start() concern, ensuring
    // the invariant is only asserted when the transport is about to connect.
    const server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
    expect(server._passthroughRegistrationComplete).toBe(false);
    // After start() the flag becomes true (verified in the earlier test).
    // This test confirms the constructor cannot accidentally set it early.
  });
});
