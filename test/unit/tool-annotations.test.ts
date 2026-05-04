import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { shutdownStreamManager } from '../../src/streaming/index.js';
import { shutdownMetricsCollector } from '../../src/metrics/index.js';
import { shutdownModeHandler } from '../../src/modes/index.js';
import { shutdownSkillsEngine } from '../../src/skills/index.js';

/**
 * Assert every tool registered by MCPExecutorServer carries the annotations
 * agreed in Phase 1.2 (readOnlyHint / destructiveHint / idempotentHint /
 * openWorldHint). If a new tool is added without annotations, this test
 * fails loudly with the tool name so the author can classify it.
 */

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type RegisteredTool = {
  annotations?: ToolAnnotations;
};

type McpServerInternals = {
  _registeredTools: Record<string, RegisteredTool>;
};

function getRegisteredTools(server: MCPExecutorServer): Record<string, RegisteredTool> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (server as any).server as McpServerInternals;
  return inner._registeredTools;
}

// Ground-truth classification for every tool the server exposes.
// Update this map when adding a new tool; the coverage test below
// will fail if any registered tool is missing from this map.
const EXPECTED: Record<string, ToolAnnotations> = {
  execute_code:       { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true },
  passthrough_call:   { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true },
  list_servers:       { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  discover_tools:     { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  get_metrics:        { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  get_memory_stats:   { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  get_capabilities:   { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  compare_modes:      { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  set_mode:           { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  reload_servers:     { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  brave_web_search:   { readOnlyHint: true,  idempotentHint: false, openWorldHint: true },
  add_server:         { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  remove_server:      { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  update_server:      { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  // Phase 7 observability tools
  predict_cost:       { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  get_hot_paths:      { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  record_session:     { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  stop_recording:     { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  replay_session:     { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  add_server:                   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  remove_server:                { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  update_server:                { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  // X2 lifecycle tools
  import_servers_from_claude:   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  test_server:                  { readOnlyHint: true,  idempotentHint: true,  openWorldHint: true },
  diagnose_server:              { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
  recommend_routing:            { readOnlyHint: false, idempotentHint: true,  openWorldHint: false },
  export_to_claude:             { readOnlyHint: true,  idempotentHint: true,  openWorldHint: false },
};

describe('Tool annotations', () => {
  let server: MCPExecutorServer;

  beforeAll(() => {
    server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });
  });

  afterAll(() => {
    // Best-effort cleanup of singletons so the test doesn't leak intervals.
    shutdownStreamManager();
    shutdownMetricsCollector();
    shutdownModeHandler();
    shutdownSkillsEngine();
  });

  it('registers every expected tool', () => {
    const registered = getRegisteredTools(server);
    const registeredNames = Object.keys(registered).sort();
    const expectedNames = Object.keys(EXPECTED).sort();

    expect(registeredNames).toEqual(expectedNames);
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} has correct annotations`, () => {
      const registered = getRegisteredTools(server);
      const tool = registered[name];
      expect(tool, `Tool ${name} should be registered`).toBeDefined();
      expect(tool.annotations, `Tool ${name} should have annotations`).toBeDefined();

      for (const [key, value] of Object.entries(expected)) {
        expect(
          tool.annotations![key as keyof ToolAnnotations],
          `Tool ${name}: annotations.${key} should be ${value}`,
        ).toBe(value);
      }
    });
  }

  it('every registered tool has some annotation', () => {
    const registered = getRegisteredTools(server);
    for (const [name, tool] of Object.entries(registered)) {
      expect(
        tool.annotations,
        `Tool ${name} must declare annotations (readOnlyHint / destructiveHint / idempotentHint / openWorldHint)`,
      ).toBeDefined();
    }
  });
});
