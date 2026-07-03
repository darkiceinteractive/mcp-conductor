/**
 * 01-conductor-protocol.test.ts
 *
 * Direct MCP protocol tests — no AI CLI involved.
 * Validates the two-phase startup sequence and core protocol compliance.
 *
 * Key insight: list_servers / discover_tools / passthrough_call all require
 * hub initialisation to complete. Only the 25 static tools (get_capabilities,
 * get_metrics, etc.) respond immediately after initialize().
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { McpStdioClient } from './helpers/mcp-stdio-client.js';
import { spawnConductor, type ConductorHandle } from './helpers/conductor-spawn.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONDUCTOR_DIST = resolve(join(__dirname, '..', '..', '..', 'dist', 'index.js'));

// All 25 static tools that must be present immediately after initialize()
const STATIC_TOOL_NAMES = [
  'execute_code',
  'list_servers',
  'discover_tools',
  'get_metrics',
  'set_mode',
  'set_compare_mode',
  'reload_servers',
  'get_capabilities',
  'compare_modes',
  'passthrough_call',
  'brave_web_search',
  'add_server',
  'remove_server',
  'update_server',
  'get_memory_stats',
  'predict_cost',
  'get_hot_paths',
  'record_session',
  'stop_recording',
  'replay_session',
  'import_servers_from_claude',
  'test_server',
  'diagnose_server',
  'recommend_routing',
  'export_to_claude',
] as const;

// Known server names from ~/.mcp-conductor.json
const KNOWN_SERVERS = [
  'context7', 'sequential-thinking', 'taskmaster-ai', 'filesystem',
  'memory', 'playwright', 'github', 'serena', 'brave-search',
  'clickup', 'ibkr', 'medium', 'yfinance', 'alphavantage',
  'afr', 'yahoo-finance', 'my-server', 'srv-a', 'srv-b', 'tv', 'chrome-devtools',
];

function makeClient(): McpStdioClient {
  return new McpStdioClient('node', [CONDUCTOR_DIST], {
    MCP_CONDUCTOR_CONFIG: '/Users/mattcrombie/.mcp-conductor.json',
    NODE_ENV: 'test',
  });
}

// ---------------------------------------------------------------------------
// Startup Protocol — tests that need hub init share a single beforeAll client
// ---------------------------------------------------------------------------

describe('Conductor Startup Protocol', { timeout: 120_000 }, () => {
  // Shared fully-initialised client for tests that need passthrough tools
  let hubClient: McpStdioClient;

  beforeAll(async () => {
    hubClient = makeClient();
    const changedPromise = hubClient.waitForToolsChanged(90_000);
    await hubClient.initialize();
    await changedPromise;
  }, 120_000);

  afterAll(async () => {
    await hubClient?.close().catch(() => { /* ignore */ });
  });

  it('provides static tools immediately after initialize()', async () => {
    // Spawn a fresh client — we measure from construction to first listTools
    const client = makeClient();
    const t0 = Date.now();

    try {
      await client.initialize();
      const { tools } = await client.listTools();
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(5000);
      expect(tools.length).toBeGreaterThanOrEqual(25);

      const toolNames = tools.map((t) => t.name);
      for (const name of STATIC_TOOL_NAMES) {
        expect(toolNames, `Static tool "${name}" missing from initial tools/list`).toContain(name);
      }
    } finally {
      await client.close().catch(() => { /* ignore */ });
    }
  });

  it('emits tools/list_changed after hub initialization', () => {
    // Verified by the fact that beforeAll completed without timing out
    expect(hubClient.getToolsChangedCount()).toBeGreaterThanOrEqual(1);
  });

  it('tool count after hub init is greater than 25 (passthrough tools present)', async () => {
    const { tools } = await hubClient.listTools();
    expect(tools.length).toBeGreaterThan(25);
    console.log(`  Total tools after hub init: ${tools.length}`);
  });

  it('passthrough tools follow server__tool naming pattern', async () => {
    const { tools } = await hubClient.listTools();
    const passthroughTools = tools.filter((t) => t.name.includes('__'));

    expect(passthroughTools.length).toBeGreaterThan(0);

    for (const tool of passthroughTools) {
      const serverPrefix = tool.name.split('__')[0];
      expect(serverPrefix).toBeTruthy();
      expect(serverPrefix!.length).toBeGreaterThan(0);
    }

    const prefixes = new Set(passthroughTools.map((t) => t.name.split('__')[0]));
    const knownPrefixPresent = KNOWN_SERVERS.some((s) => prefixes.has(s));
    expect(
      knownPrefixPresent,
      `No known server prefix found in passthrough tools. Got: ${[...prefixes].join(', ')}`
    ).toBe(true);
  });

  it('list_servers returns all configured servers (requires hub init)', async () => {
    const result = await hubClient.callTool('list_servers', {});

    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`list_servers did not return valid JSON. Got: ${text.slice(0, 200)}`);
    }

    const serverData = parsed as { servers?: Array<{ name: string }> };
    expect(serverData.servers).toBeDefined();
    expect(Array.isArray(serverData.servers)).toBe(true);

    const serverNames = serverData.servers!.map((s) => s.name);
    for (const known of KNOWN_SERVERS) {
      expect(serverNames, `Server "${known}" missing from list_servers`).toContain(known);
    }
  });

  it('discover_tools returns tools for filesystem server (requires hub init)', async () => {
    const result = await hubClient.callTool('discover_tools', { server: 'filesystem' });

    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);

    const lowerText = text.toLowerCase();
    const hasFilesystemTools =
      lowerText.includes('list_directory') ||
      lowerText.includes('read_file') ||
      lowerText.includes('list-directory') ||
      lowerText.includes('read-file');

    expect(
      hasFilesystemTools,
      `discover_tools(filesystem) output doesn't mention filesystem tools. Got: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  it('static tools are ready before hub init completes', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      // Call get_capabilities immediately — don't wait for toolsChanged
      const t0 = Date.now();
      const result = await client.callTool('get_capabilities', {});
      const latencyMs = Date.now() - t0;

      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]?.text).toBeTruthy();
      expect(latencyMs).toBeLessThan(3000);
    } finally {
      await client.close().catch(() => { /* ignore */ });
    }
  });

  it('startup timing: static tools < 5s, full toolset < 90s', async () => {
    const client = makeClient();
    const spawnT0 = Date.now();

    try {
      const changedPromise = client.waitForToolsChanged(90_000);
      await client.initialize();
      const staticToolsMs = Date.now() - spawnT0;

      await changedPromise;
      const fullToolsetMs = Date.now() - spawnT0;

      console.log(`  Static tools ready: ${staticToolsMs}ms`);
      console.log(`  Full toolset ready: ${fullToolsetMs}ms`);

      expect(staticToolsMs).toBeLessThan(5000);
      expect(fullToolsetMs).toBeLessThan(90_000);
    } finally {
      await client.close().catch(() => { /* ignore */ });
    }
  });
});

// ---------------------------------------------------------------------------
// MCP Protocol Compliance — simple per-test lifecycle
// ---------------------------------------------------------------------------

describe('MCP Protocol Compliance', { timeout: 30_000 }, () => {
  let conductor: ConductorHandle;

  beforeEach(async () => {
    conductor = await spawnConductor();
  });

  afterEach(async () => {
    await conductor?.close().catch(() => { /* ignore */ });
  });

  it('responds to tools/list with valid MCP schema', async () => {
    const { tools } = await conductor.client.listTools();

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(25);

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);

      if (tool.description !== undefined) {
        expect(typeof tool.description).toBe('string');
      }

      if (tool.inputSchema !== undefined) {
        expect(typeof tool.inputSchema).toBe('object');
        expect(tool.inputSchema).not.toBeNull();
      }
    }
  });

  it('tool call returns content array with text type', async () => {
    const result = await conductor.client.callTool('get_capabilities', {});

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);

    const first = result.content[0]!;
    expect(first.type).toBe('text');
    expect(typeof first.text).toBe('string');
    expect(first.text!.length).toBeGreaterThan(0);

    expect(() => { JSON.parse(first.text!); }).not.toThrow();
  });

  it('unknown tool call returns MCP error', async () => {
    let threw = false;
    let result: Awaited<ReturnType<typeof conductor.client.callTool>> | null = null;

    try {
      result = await conductor.client.callTool('nonexistent_tool_xyz_abc', {});
    } catch {
      threw = true;
    }

    const isError = threw || result?.isError === true;
    expect(isError, 'Expected an error for unknown tool, got success').toBe(true);
  });

  it('invalid params return error not crash', async () => {
    try {
      await conductor.client.callTool('list_servers', { invalid_param_xxx_yyy: true } as Record<string, unknown>);
    } catch {
      // Error expected — just verify conductor is still responsive
    }

    // Conductor must still respond after error
    const result = await conductor.client.callTool('get_capabilities', {});
    expect(result.content.length).toBeGreaterThan(0);
  });
});
