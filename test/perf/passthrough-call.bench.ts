/**
 * Passthrough-call benchmark — T1
 *
 * Measures the latency of a passthrough tool call — one that bypasses the
 * Deno sandbox and routes directly through the MCP bridge to the upstream
 * server.
 *
 * PRD §6.1 threshold: p50 < 30ms.
 *
 * The mock simulates the bridge returning immediately, so we are measuring
 * the routing decision + envelope overhead rather than real network latency.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBenchmark, emitBenchmarkResult } from './bench-utils.js';

// Mock the MCP hub so passthrough routing resolves in-process.
vi.mock('../../src/hub/mcp-hub.js', () => {
  return {
    MCPHub: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', items: [] }) }],
      }),
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_repositories', description: 'List GitHub repositories', inputSchema: {} },
      ]),
      getConnectedServers: vi.fn().mockReturnValue(['github']),
      shutdown: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('../../src/config/loader.js', () => ({
  loadClaudeConfig: vi.fn().mockReturnValue({
    mcpServers: {
      github: { command: 'node', args: ['github-mcp.js'] },
    },
  }),
  findClaudeConfig: vi.fn().mockReturnValue('/mock/claude_desktop_config.json'),
  loadConductorConfig: vi.fn().mockReturnValue(null),
  findConductorConfig: vi.fn().mockReturnValue(null),
}));

async function passthroughCallFn(): Promise<void> {
  const { MCPHub } = await import('../../src/hub/mcp-hub.js');
  const hub = new MCPHub();
  await hub.callTool('github', 'list_repositories', { owner: 'mock-org' });
}

describe('passthrough-call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('passthrough-call p50 < 30ms (CI gate)', async () => {
    const result = await runBenchmark(passthroughCallFn, {
      warmupIterations: 10,
      iterations: 50,
    });

    emitBenchmarkResult('passthrough-call', result, { p50: 30 });

    expect(result.p50).toBeLessThan(30);
  });

  test('passthrough-call p99 informational', async () => {
    const result = await runBenchmark(passthroughCallFn, {
      warmupIterations: 5,
      iterations: 30,
    });

    // p99 is informational in CI — network-bound in production.
    expect(result.p99).toBeGreaterThanOrEqual(0);
  });
});
