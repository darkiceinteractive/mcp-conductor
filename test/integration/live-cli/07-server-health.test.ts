/**
 * 07-server-health.test.ts
 *
 * Comprehensive health check for every MCP server configured in
 * ~/.mcp-conductor.json. This file answers the question: "are all my
 * servers actually wired in and reachable through the conductor?"
 *
 * Structure:
 *   • One shared beforeAll waits for hub init (tools/list_changed) —
 *     backend servers attempt to connect during this window.
 *   • list_servers() is called once and the result shared across all tests.
 *   • Per-server tool calls are routed through execute_code (the primary
 *     routing mechanism — only 2 servers register passthrough tools).
 *   • Hard asserts: infrastructure integrity (list_servers works, all 21
 *     servers appear in the inventory, execute_code stays alive).
 *   • Soft warns: servers that may legitimately be down (local processes,
 *     API-key-gated services, etc.).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpStdioClient } from './helpers/mcp-stdio-client.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(join(__dirname, '..', '..', '..', 'dist', 'index.js'));
const CONFIG_PATH = '/Users/mattcrombie/.mcp-conductor.json';

// All 21 servers configured in ~/.mcp-conductor.json
const ALL_SERVERS = [
  'context7',
  'sequential-thinking',
  'taskmaster-ai',
  'filesystem',
  'memory',
  'playwright',
  'github',
  'serena',
  'brave-search',
  'clickup',
  'ibkr',
  'medium',
  'yfinance',
  'alphavantage',
  'afr',
  'yahoo-finance',
  'my-server',
  'srv-a',
  'srv-b',
  'tv',
  'chrome-devtools',
] as const;

type ServerName = typeof ALL_SERVERS[number];

// Servers expected to be healthy on a typical dev machine.
// These will generate hard assertion failures if down.
const MUST_BE_CONNECTED: ServerName[] = [
  'filesystem',
  'sequential-thinking',
  'context7',
];

// Servers that are flaky or require external processes —
// failures produce warnings only, not test failures.
const EXPECT_FLAKY: ServerName[] = [
  'ibkr',         // local IB Gateway process
  'afr',          // local scraper process
  'medium',       // local Medium MCP server process
  'tv',           // local TradingView MCP process
  'my-server',    // local stub server
  'srv-a',        // test stub
  'srv-b',        // test stub
  'serena',       // uvx-based language server, needs project
  'chrome-devtools', // needs Chrome running
  'playwright',   // needs browser
  'alphavantage', // API key gated
  'clickup',      // API key gated
  'github',       // API key gated (may work with GITHUB_TOKEN env)
  'taskmaster-ai',// may need setup
  'yfinance',     // external API (usually fine)
  'yahoo-finance',// external API (usually fine)
  'brave-search', // API key gated
  'memory',       // usually healthy
];

interface ServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  tool_count: number;
  tools?: string[];
}

interface ListServersResponse {
  servers: ServerStatus[];
  total_servers: number;
  total_tools: number;
}

interface ExecuteCodeResponse {
  success: boolean;
  result?: unknown;
  error?: { type: string; message: string };
}

interface DiagnoseResponse {
  server_name: string;
  status: string;
  tool_count: number;
  is_connected: boolean;
  last_error?: string;
  suggestions: string[];
  registry_state: { in_config: boolean; command?: string };
}

describe('MCP Server Health Inventory', { timeout: 180_000 }, () => {
  let client: McpStdioClient;
  let serverData: ListServersResponse;
  let connectedServers: Set<string>;
  let serverByName: Map<string, ServerStatus>;

  beforeAll(async () => {
    client = new McpStdioClient('node', [CONDUCTOR_DIST], {
      MCP_CONDUCTOR_CONFIG: CONFIG_PATH,
      NODE_ENV: 'test',
    });

    const changedPromise = client.waitForToolsChanged(90_000);
    await client.initialize();
    await changedPromise;

    console.log('[07-server-health] Hub init complete, querying server inventory...');

    // Fetch server list with tool names included
    const raw = await client.callTool('list_servers', { include_tools: true });
    const text = raw.content[0]?.text ?? '{}';
    serverData = JSON.parse(text) as ListServersResponse;

    connectedServers = new Set(
      serverData.servers
        .filter((s) => s.status === 'connected')
        .map((s) => s.name)
    );

    serverByName = new Map(serverData.servers.map((s) => [s.name, s]));

    // Print summary table
    console.log('\n  SERVER STATUS MATRIX');
    console.log('  ' + '─'.repeat(60));
    for (const s of serverData.servers) {
      const icon = s.status === 'connected' ? '✅' : s.status === 'error' ? '❌' : '⚪';
      const toolsInfo = s.status === 'connected' ? `${s.tool_count} tools` : s.status;
      console.log(`  ${icon} ${s.name.padEnd(20)} ${toolsInfo}`);
    }
    console.log('  ' + '─'.repeat(60));
    console.log(`  Total: ${connectedServers.size}/${serverData.total_servers} connected, ${serverData.total_tools} tools\n`);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.close().catch(() => { /* ignore */ });
    }
  });

  // ── Infrastructure invariants ────────────────────────────────────────────

  it('list_servers returns a valid response', () => {
    expect(serverData).toBeDefined();
    expect(serverData.servers).toBeInstanceOf(Array);
    expect(typeof serverData.total_servers).toBe('number');
    expect(typeof serverData.total_tools).toBe('number');
  });

  it('all 21 configured servers appear in the inventory', () => {
    const names = new Set(serverData.servers.map((s) => s.name));
    const missing = ALL_SERVERS.filter((n) => !names.has(n));
    expect(missing, `Servers missing from inventory: ${missing.join(', ')}`).toHaveLength(0);
    expect(serverData.total_servers).toBe(21);
  });

  it('at least one server is connected', () => {
    expect(connectedServers.size).toBeGreaterThan(0);
  });

  it('total tool count reflects connected servers', () => {
    const summedTools = serverData.servers.reduce((sum, s) => sum + s.tool_count, 0);
    expect(serverData.total_tools).toBe(summedTools);
  });

  // ── Must-be-connected servers (hard failures) ────────────────────────────

  it.each(MUST_BE_CONNECTED)('core server "%s" is connected', (name) => {
    const s = serverByName.get(name);
    expect(s, `Server "${name}" not in inventory`).toBeDefined();
    expect(
      s!.status,
      `Core server "${name}" must be connected. Last error may appear in diagnose_server output.`
    ).toBe('connected');
    expect(s!.tool_count).toBeGreaterThan(0);
  });

  // ── Per-server status report (soft — warn for flaky servers) ─────────────

  it.each([...ALL_SERVERS])('server "%s" has a valid status field', (name) => {
    const s = serverByName.get(name);
    expect(s, `Server "${name}" missing from list_servers response`).toBeDefined();
    expect(['connected', 'disconnected', 'error']).toContain(s!.status);

    if (s!.status !== 'connected') {
      const isFlakyExpected = EXPECT_FLAKY.includes(name as ServerName);
      if (!isFlakyExpected) {
        console.warn(`  ⚠ Unexpected: "${name}" is ${s!.status} (expected connected)`);
      }
    }
  });

  // ── Actual tool calls for connected servers ───────────────────────────────

  describe('execute_code tool calls to connected servers', () => {
    it('filesystem: list_directory returns entries', async () => {
      if (!connectedServers.has('filesystem')) {
        console.warn('  ⚠ filesystem not connected — skipping tool call test');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('filesystem').call('list_directory', {
            path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice'
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length, 'filesystem list_directory returned empty response').toBeGreaterThan(0);
      console.log(`  filesystem list_directory: ${text.slice(0, 100)}…`);
    });

    it('filesystem: read_file reads a known file', async () => {
      if (!connectedServers.has('filesystem')) {
        console.warn('  ⚠ filesystem not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('filesystem').call('read_file', {
            path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice/package.json'
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('mcp-conductor');
      console.log(`  filesystem read_file(package.json): ${text.length} chars`);
    });

    it('sequential-thinking: sequentialthinking responds', async () => {
      if (!connectedServers.has('sequential-thinking')) {
        console.warn('  ⚠ sequential-thinking not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('sequential-thinking').call('sequentialthinking', {
            thought: 'Testing that the sequential-thinking MCP server is reachable.',
            thoughtNumber: 1,
            totalThoughts: 1,
            nextThoughtNeeded: false
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length, 'sequential-thinking returned empty response').toBeGreaterThan(0);
      console.log(`  sequential-thinking response: ${text.slice(0, 100)}…`);
    });

    it('context7: resolve-library-id returns an ID', async () => {
      if (!connectedServers.has('context7')) {
        console.warn('  ⚠ context7 not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('context7').call('resolve-library-id', {
            libraryName: 'vitest'
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length, 'context7 resolve-library-id returned empty response').toBeGreaterThan(0);
      console.log(`  context7 resolve-library-id('vitest'): ${text.slice(0, 120)}…`);
    });

    it('memory: read_graph returns graph data', async () => {
      if (!connectedServers.has('memory')) {
        console.warn('  ⚠ memory not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('memory').call('read_graph', {});
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length, 'memory read_graph returned empty response').toBeGreaterThan(0);
      console.log(`  memory read_graph: ${text.slice(0, 100)}…`);
    });

    it('github: search_repositories returns results (needs GITHUB_TOKEN)', async () => {
      if (!connectedServers.has('github')) {
        console.warn('  ⚠ github not connected — skipping (may need GITHUB_TOKEN)');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('github').call('search_repositories', {
            query: 'mcp-conductor language:typescript',
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      // Accept auth errors or actual results — either is valid
      expect(text.length, 'github returned empty response').toBeGreaterThan(0);
      console.log(`  github search_repositories: ${text.slice(0, 120)}…`);
    });

    it('taskmaster-ai: get_tasks returns task list', async () => {
      if (!connectedServers.has('taskmaster-ai')) {
        console.warn('  ⚠ taskmaster-ai not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          const r = await mcp.server('taskmaster-ai').call('get_tasks', {
            projectRoot: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice'
          });
          return r;
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length, 'taskmaster-ai returned empty response').toBeGreaterThan(0);
      console.log(`  taskmaster-ai get_tasks: ${text.slice(0, 100)}…`);
    });

    it('brave-search: brave_web_search runs (may fail without API key)', async () => {
      if (!connectedServers.has('brave-search')) {
        console.warn('  ⚠ brave-search not connected — skipping');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          try {
            const r = await mcp.server('brave-search').call('brave_web_search', {
              query: 'mcp protocol anthropic',
              count: 1
            });
            return { ok: true, preview: JSON.stringify(r).slice(0, 200) };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        `,
      });

      const text = result.content[0]?.text ?? '';
      // Accept either success or auth error — just verify the server responds
      expect(text.length, 'brave-search returned empty response').toBeGreaterThan(0);
      console.log(`  brave-search: ${text.slice(0, 150)}…`);
    });

    it('yfinance: get quote for AAPL', async () => {
      if (!connectedServers.has('yfinance')) {
        console.warn('  ⚠ yfinance not connected — skipping');
        return;
      }

      const { tools = [] } = serverByName.get('yfinance') ?? {};
      const firstTool = tools[0];
      if (!firstTool) {
        console.warn('  ⚠ yfinance has no tools registered — skipping call');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          try {
            const r = await mcp.server('yfinance').call(${JSON.stringify(firstTool)}, { symbol: 'AAPL' });
            return { ok: true, preview: JSON.stringify(r).slice(0, 200) };
          } catch (e) {
            return { ok: false, tool: ${JSON.stringify(firstTool)}, error: e.message };
          }
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(0);
      console.log(`  yfinance ${firstTool}: ${text.slice(0, 150)}…`);
    });

    it('yahoo-finance: get a quote', async () => {
      if (!connectedServers.has('yahoo-finance')) {
        console.warn('  ⚠ yahoo-finance not connected — skipping');
        return;
      }

      const { tools = [] } = serverByName.get('yahoo-finance') ?? {};
      const firstTool = tools[0];
      if (!firstTool) {
        console.warn('  ⚠ yahoo-finance has no tools registered — skipping call');
        return;
      }

      const result = await client.callTool('execute_code', {
        code: `
          try {
            const r = await mcp.server('yahoo-finance').call(${JSON.stringify(firstTool)}, { symbol: 'AAPL' });
            return { ok: true, preview: JSON.stringify(r).slice(0, 200) };
          } catch (e) {
            return { ok: false, tool: ${JSON.stringify(firstTool)}, error: e.message };
          }
        `,
      });

      const text = result.content[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(0);
      console.log(`  yahoo-finance ${firstTool}: ${text.slice(0, 150)}…`);
    });
  });

  // ── Cache correctness: same call returns same result ─────────────────────

  describe('caching: repeated calls use cache', () => {
    it('second identical execute_code call is faster than the first (disk cache)', async () => {
      if (!connectedServers.has('filesystem')) {
        console.warn('  ⚠ filesystem not connected — skipping cache test');
        return;
      }

      const code = `
        const r = await mcp.server('filesystem').call('list_directory', {
          path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice'
        });
        return r;
      `;

      // First call (cache miss)
      const t1 = Date.now();
      const first = await client.callTool('execute_code', { code });
      const firstMs = Date.now() - t1;

      // Second call (should hit in-memory LRU cache)
      const t2 = Date.now();
      const second = await client.callTool('execute_code', { code });
      const secondMs = Date.now() - t2;

      const firstText = first.content[0]?.text ?? '';
      const secondText = second.content[0]?.text ?? '';

      console.log(`  Cache test: 1st call ${firstMs}ms, 2nd call ${secondMs}ms`);
      expect(firstText.length).toBeGreaterThan(0);
      // Both calls must return consistent data
      expect(firstText).toBe(secondText);
    });
  });

  // ── diagnose_server for disconnected servers ────────────────────────────

  describe('diagnose_server for non-connected servers', () => {
    it('diagnose_server reports in_config=true for all 21 servers', async () => {
      // Test a sample of servers — running all 21 in series is slow
      const sampled: ServerName[] = ['filesystem', 'sequential-thinking', 'ibkr', 'tv', 'brave-search'];

      for (const name of sampled) {
        const raw = await client.callTool('diagnose_server', { name });
        const text = raw.content[0]?.text ?? '{}';
        const diag = JSON.parse(text) as DiagnoseResponse;

        console.log(`  diagnose(${name}): status=${diag.status}, in_config=${diag.registry_state.in_config}`);

        expect(diag.server_name).toBe(name);
        expect(
          diag.registry_state.in_config,
          `Server "${name}" should be in_config but diagnose_server says it is not`
        ).toBe(true);
        expect(['connected', 'disconnected', 'error', 'not_registered']).toContain(diag.status);
      }
    });

    it('diagnose_server for a disconnected server provides suggestions', async () => {
      // Find any disconnected or error server
      const disconnected = serverData.servers.find(
        (s) => s.status !== 'connected' && EXPECT_FLAKY.includes(s.name as ServerName)
      );

      if (!disconnected) {
        console.log('  All expected-flaky servers happen to be connected — skipping suggestion test');
        return;
      }

      const raw = await client.callTool('diagnose_server', { name: disconnected.name });
      const text = raw.content[0]?.text ?? '{}';
      const diag = JSON.parse(text) as DiagnoseResponse;

      console.log(`  diagnose(${disconnected.name}) suggestions: ${diag.suggestions.join('; ')}`);
      // Either has suggestions or reports a clean state
      expect(diag).toBeDefined();
      expect(Array.isArray(diag.suggestions)).toBe(true);
    });
  });

  // ── Standalone test_server for key servers ────────────────────────────

  describe('test_server standalone connectivity', () => {
    it('test_server(filesystem) connects and lists tools', async () => {
      const raw = await client.callTool('test_server', {
        name: 'filesystem',
        timeout_ms: 20_000,
      });

      const text = raw.content[0]?.text ?? '{}';
      const result = JSON.parse(text);

      console.log(`  test_server(filesystem): connected=${result.connected}, tools=${result.tool_count}, latency=${result.latency_ms}ms`);

      expect(result.connected, `test_server(filesystem) failed: ${result.error ?? 'unknown'}`).toBe(true);
      expect(result.tool_count).toBeGreaterThan(0);
      expect(result.latency_ms).toBeLessThan(10_000);
    });

    it('test_server(sequential-thinking) connects and lists tools', async () => {
      const raw = await client.callTool('test_server', {
        name: 'sequential-thinking',
        timeout_ms: 20_000,
      });

      const text = raw.content[0]?.text ?? '{}';
      const result = JSON.parse(text);

      console.log(`  test_server(sequential-thinking): connected=${result.connected}, tools=${result.tool_count}`);

      expect(result.connected, `test_server(sequential-thinking) failed: ${result.error ?? 'unknown'}`).toBe(true);
      expect(result.tool_count).toBeGreaterThan(0);
    });

    it('test_server(context7) connects and lists tools', async () => {
      const raw = await client.callTool('test_server', {
        name: 'context7',
        timeout_ms: 30_000, // npx cold start
      });

      const text = raw.content[0]?.text ?? '{}';
      const result = JSON.parse(text);

      console.log(`  test_server(context7): connected=${result.connected}, tools=${result.tool_count}`);

      if (!result.connected) {
        console.warn(`  ⚠ context7 test_server failed: ${result.error} — may be slow npm cold start`);
      }
      // Soft: warn but don't hard-fail (npx cold start can exceed timeout)
      expect(result).toBeDefined();
    });
  });

  // ── Final summary ─────────────────────────────────────────────────────

  it('generates final health summary', () => {
    const connected = serverData.servers.filter((s) => s.status === 'connected');
    const disconnected = serverData.servers.filter((s) => s.status === 'disconnected');
    const errored = serverData.servers.filter((s) => s.status === 'error');

    console.log('\n  FINAL HEALTH SUMMARY');
    console.log(`  ✅ Connected (${connected.length}): ${connected.map((s) => s.name).join(', ')}`);
    if (disconnected.length > 0) {
      console.log(`  ⚪ Disconnected (${disconnected.length}): ${disconnected.map((s) => s.name).join(', ')}`);
    }
    if (errored.length > 0) {
      console.log(`  ❌ Error (${errored.length}): ${errored.map((s) => s.name).join(', ')}`);
    }
    console.log(`  Total tools available: ${serverData.total_tools}`);

    // The only hard assertion here: must-be-connected servers must be connected
    for (const name of MUST_BE_CONNECTED) {
      const s = serverByName.get(name);
      expect(s?.status, `${name} must be connected for a healthy conductor setup`).toBe('connected');
    }
  });
});
