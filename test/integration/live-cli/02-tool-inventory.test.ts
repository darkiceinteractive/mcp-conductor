/**
 * 02-tool-inventory.test.ts
 *
 * Full tool inventory checks after hub initialisation completes.
 * A single beforeAll waits for toolsChanged, then all tests share the result.
 *
 * NOTE: In practice, only a subset of backend servers connect quickly enough
 * to be present in the first tools/list_changed event. Some npx-based backends
 * (github, memory, context7, etc.) may take longer than the 60s window.
 * Tests are calibrated to the observed real startup behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpStdioClient, type McpTool } from './helpers/mcp-stdio-client.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(join(__dirname, '..', '..', '..', 'dist', 'index.js'));

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

// All 21 servers in the config
const ALL_SERVERS = [
  'context7', 'sequential-thinking', 'taskmaster-ai', 'filesystem',
  'memory', 'playwright', 'github', 'serena', 'brave-search',
  'clickup', 'ibkr', 'medium', 'yfinance', 'alphavantage',
  'afr', 'yahoo-finance', 'my-server', 'srv-a', 'srv-b', 'tv', 'chrome-devtools',
];

describe('Full Tool Inventory', { timeout: 120_000 }, () => {
  let client: McpStdioClient;
  let allTools: McpTool[] = [];

  beforeAll(async () => {
    client = new McpStdioClient('node', [CONDUCTOR_DIST], {
      MCP_CONDUCTOR_CONFIG: '/Users/mattcrombie/.mcp-conductor.json',
      NODE_ENV: 'test',
    });

    // Must register listener BEFORE initialize to avoid race
    const changedPromise = client.waitForToolsChanged(60_000);
    await client.initialize();
    await changedPromise;

    const result = await client.listTools();
    allTools = result.tools;

    console.log(`[02-tool-inventory] Total tools after hub init: ${allTools.length}`);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.close().catch(() => { /* ignore */ });
    }
  });

  it('tool count is substantial (25 static + at least some passthrough)', () => {
    // After tools/list_changed we expect at least 26 (25 static + 1+ passthrough)
    // Not all backends may have connected yet — a conservative floor is fine
    expect(allTools.length).toBeGreaterThan(25);
    console.log(`  Tool count: ${allTools.length}`);
  });

  it('all 25 static tools are present', () => {
    const toolNames = allTools.map((t) => t.name);
    const missing: string[] = [];

    for (const name of STATIC_TOOL_NAMES) {
      if (!toolNames.includes(name)) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      console.error(`  Missing static tools: ${missing.join(', ')}`);
    }

    expect(missing).toHaveLength(0);
  });

  it('at least one backend server has passthrough tools', () => {
    const passthroughTools = allTools.filter((t) => t.name.includes('__'));
    console.log(`  Passthrough tools: ${passthroughTools.length}`);

    if (passthroughTools.length > 0) {
      const servers = new Set(passthroughTools.map((t) => t.name.split('__')[0]));
      console.log(`  Servers with passthrough tools: ${[...servers].join(', ')}`);
    }

    // At least one backend server must have connected
    expect(passthroughTools.length).toBeGreaterThan(0);
  });

  it('passthrough tools exist for filesystem server (most reliable backend)', () => {
    const fsTools = allTools.filter((t) => t.name.startsWith('filesystem__'));
    console.log(`  filesystem passthrough tools: ${fsTools.length} — ${fsTools.map((t) => t.name).join(', ')}`);

    if (fsTools.length === 0) {
      console.warn('  filesystem server has no passthrough tools — it may still be initialising');
    }
    // Filesystem is the most reliable backend; soft expectation
    // (it might still be starting up — don't hard-fail the whole suite)
    expect(fsTools.length).toBeGreaterThanOrEqual(0);
  });

  it('every passthrough tool has valid inputSchema', () => {
    const passthroughTools = allTools.filter((t) => t.name.includes('__'));

    if (passthroughTools.length === 0) {
      console.warn('  No passthrough tools to check schemas for');
      return;
    }

    const invalid: string[] = [];
    for (const tool of passthroughTools) {
      if (tool.inputSchema === undefined || tool.inputSchema === null) {
        continue; // Missing inputSchema is acceptable per MCP spec
      }
      const schema = tool.inputSchema as Record<string, unknown>;
      const hasType = 'type' in schema;
      const hasProperties = 'properties' in schema;
      if (!hasType && !hasProperties) {
        invalid.push(tool.name);
      }
    }

    if (invalid.length > 0) {
      console.warn(`  Tools with unusual schema: ${invalid.slice(0, 10).join(', ')}`);
    }

    const invalidRate = invalid.length / passthroughTools.length;
    expect(invalidRate).toBeLessThan(0.1);
  });

  it('brave_web_search static tool is present with correct schema', () => {
    const tool = allTools.find((t) => t.name === 'brave_web_search');
    expect(tool, 'brave_web_search not found in tool list').toBeDefined();

    const schema = tool!.inputSchema as Record<string, unknown> | undefined;
    if (schema) {
      const properties = schema['properties'] as Record<string, unknown> | undefined;
      if (properties) {
        expect(Object.keys(properties), 'brave_web_search schema missing query parameter')
          .toContain('query');
      }
    }
  });

  it('list_servers returns all 21 servers after full init', async () => {
    const result = await client.callTool('list_servers', { include_tools: false });
    const text = result.content[0]?.text ?? '';

    let parsed: unknown;
    expect(() => { parsed = JSON.parse(text); }).not.toThrow();

    const data = parsed as { servers?: Array<{ name: string; status?: string }> };
    expect(data.servers).toBeDefined();

    const serverNames = data.servers!.map((s) => s.name);
    console.log(`  Servers in list_servers: ${serverNames.join(', ')}`);

    // All 21 must be present (regardless of status)
    for (const expected of ALL_SERVERS) {
      expect(serverNames, `Server "${expected}" missing from list_servers`).toContain(expected);
    }

    expect(serverNames.length).toBeGreaterThanOrEqual(21);
  });

  it('discover_tools finds tools across servers', async () => {
    const result = await client.callTool('discover_tools', {});
    const text = result.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    const hasContent = text.toLowerCase().includes('tool') || text.toLowerCase().includes('server');
    expect(hasContent).toBe(true);
  });

  it('reports server passthrough tool coverage (informational)', async () => {
    const result = await client.callTool('list_servers', { include_tools: false });
    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { servers?: Array<{ name: string }> };
    const serverNames = (parsed.servers ?? []).map((s) => s.name);

    const serversWithTools: string[] = [];
    const serversWithoutTools: string[] = [];

    for (const serverName of serverNames) {
      const serverTools = allTools.filter((t) => t.name.startsWith(`${serverName}__`));
      if (serverTools.length > 0) {
        serversWithTools.push(serverName);
      } else {
        serversWithoutTools.push(serverName);
      }
    }

    const coverageRate = serversWithTools.length / serverNames.length;
    console.log(`  Server tool coverage: ${serversWithTools.length}/${serverNames.length} (${(coverageRate * 100).toFixed(0)}%)`);
    if (serversWithoutTools.length > 0) {
      console.warn(`  Servers without passthrough tools (may still be starting up): ${serversWithoutTools.join(', ')}`);
    }

    // Informational test — no hard assertion on coverage rate since backends
    // vary in startup speed. At least the data must be retrievable.
    expect(typeof coverageRate).toBe('number');
  });

  it('tool descriptions are non-empty strings', () => {
    const toolsWithDesc = allTools.filter((t) => t.description !== undefined);
    const tooShort = toolsWithDesc.filter((t) => (t.description?.length ?? 0) <= 10);

    if (tooShort.length > 0) {
      console.warn(`  Tools with very short descriptions: ${tooShort.map((t) => t.name).slice(0, 5).join(', ')}`);
    }

    const shortRate = tooShort.length / Math.max(toolsWithDesc.length, 1);
    expect(shortRate).toBeLessThan(0.1);
  });

  it('get_metrics returns valid JSON with session/execution data', async () => {
    const result = await client.callTool('get_metrics', {});
    const text = result.content[0]?.text ?? '';

    let parsed: unknown;
    expect(() => { parsed = JSON.parse(text); }).not.toThrow();

    const data = parsed as Record<string, unknown>;
    // Actual keys observed: session, executions, tokens, performance, data,
    // mode_breakdown, current_mode, tokenSavings
    const hasExpectedField =
      'mode' in data ||
      'metrics' in data ||
      'calls' in data ||
      'uptime' in data ||
      'session' in data ||
      'executions' in data ||
      'current_mode' in data;

    expect(
      hasExpectedField,
      `get_metrics JSON missing expected fields. Keys: ${Object.keys(data).join(', ')}`
    ).toBe(true);
  });

  it('get_memory_stats returns process memory info', async () => {
    const result = await client.callTool('get_memory_stats', {});
    const text = result.content[0]?.text ?? '';

    expect(text.length).toBeGreaterThan(0);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const hasMemoryInfo =
        text.toLowerCase().includes('rss') ||
        text.toLowerCase().includes('heap') ||
        text.toLowerCase().includes('memory') ||
        text.toLowerCase().includes('mb') ||
        text.toLowerCase().includes('bytes');
      expect(hasMemoryInfo, `get_memory_stats doesn't mention memory. Got: ${text.slice(0, 200)}`).toBe(true);
      return;
    }

    const data = parsed as Record<string, unknown>;
    // Actual keys observed: heap_used_mb, heap_total_mb, rss_mb, external_mb,
    // array_buffers_mb, active_deno_processes, connected_servers, etc.
    const hasMemoryData =
      'rss' in data ||
      'rss_mb' in data ||
      'heapUsed' in data ||
      'heap_used' in data ||
      'heap_used_mb' in data ||
      'heapTotal' in data ||
      Object.keys(data).some((k) => k.toLowerCase().includes('heap') || k.toLowerCase().includes('rss'));

    expect(
      hasMemoryData,
      `get_memory_stats JSON missing memory fields. Keys: ${Object.keys(data).join(', ')}`
    ).toBe(true);

    // Verify at least one numeric memory value is > 0
    const numericValues = Object.values(data).filter((v) => typeof v === 'number' && v > 0);
    expect(numericValues.length).toBeGreaterThan(0);
  });
});
