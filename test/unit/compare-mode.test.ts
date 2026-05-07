/**
 * Tests for compare-mode wiring in the passthrough registrar.
 *
 * The full server-level path (set_compare_mode tool → passthrough_call →
 * real Deno wrapper) is exercised by integration tests; here we lock down
 * the registrar contract: when `compareHook.isEnabled()` returns true,
 * each registered handler invokes `buildCompareStats()` with the measured
 * passthrough duration + result bytes, and the resulting block is attached
 * to `structuredContent.compareStats`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  registerPassthroughTools,
  type CompareModeHook,
  type McpServerLike,
  type McpHubLike,
} from '../../src/server/passthrough-registrar.js';
import type { ToolDefinition } from '../../src/registry/index.js';

function makeRegistry(tools: ToolDefinition[]): { getAllTools(): ToolDefinition[] } {
  return { getAllTools: () => tools };
}

function makeServer(): McpServerLike & {
  _registrations: Array<{ name: string; handler: Parameters<McpServerLike['registerTool']>[2] }>;
} {
  const _registrations: Array<{ name: string; handler: Parameters<McpServerLike['registerTool']>[2] }> = [];
  return {
    _registrations,
    registerTool(name, _config, handler) {
      _registrations.push({ name, handler });
    },
  };
}

function makeHub(result: unknown): McpHubLike {
  return {
    async callTool() {
      return result;
    },
  };
}

describe('registerPassthroughTools — compare mode hook', () => {
  const tool: ToolDefinition = {
    server: 'echo',
    name: 'echo',
    description: 'Echo input',
    inputSchema: {},
    routing: 'passthrough',
  };

  it('does not invoke buildCompareStats when isEnabled() returns false', async () => {
    const server = makeServer();
    const hub = makeHub({ message: 'hi' });
    const buildCompareStats = vi.fn();
    const hook: CompareModeHook = {
      isEnabled: () => false,
      buildCompareStats,
    };

    registerPassthroughTools(makeRegistry([tool]) as never, server, hub, undefined, hook);

    const response = await server._registrations[0].handler({ message: 'hi' });

    expect(buildCompareStats).not.toHaveBeenCalled();
    expect(response.structuredContent).not.toHaveProperty('compareStats');
  });

  it('attaches compareStats to structuredContent when compare mode is on', async () => {
    const server = makeServer();
    const hub = makeHub({ message: 'hello world' });

    const fakeStats = { path: 'passthrough', diff: { tokens_saved: 42 } };
    const buildCompareStats = vi.fn().mockResolvedValue(fakeStats);
    const hook: CompareModeHook = {
      isEnabled: () => true,
      buildCompareStats,
    };

    registerPassthroughTools(makeRegistry([tool]) as never, server, hub, undefined, hook);

    const response = await server._registrations[0].handler({ message: 'hello world' });

    expect(buildCompareStats).toHaveBeenCalledTimes(1);
    const [callServer, callTool, callParams, durationMs, resultBytes] =
      buildCompareStats.mock.calls[0];
    expect(callServer).toBe('echo');
    expect(callTool).toBe('echo');
    expect(callParams).toEqual({ message: 'hello world' });
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(resultBytes).toBe(JSON.stringify({ message: 'hello world' }).length);

    expect(response.structuredContent).toMatchObject({
      success: true,
      compareStats: fakeStats,
    });
  });

  it('still returns the passthrough result when buildCompareStats throws', async () => {
    const server = makeServer();
    const hub = makeHub({ ok: true });

    const hook: CompareModeHook = {
      isEnabled: () => true,
      buildCompareStats: vi.fn().mockRejectedValue(new Error('wrapper crashed')),
    };

    registerPassthroughTools(makeRegistry([tool]) as never, server, hub, undefined, hook);

    const response = await server._registrations[0].handler({});

    expect(response.structuredContent).toMatchObject({ success: true, result: { ok: true } });
    expect(response.structuredContent).not.toHaveProperty('compareStats');
  });
});
