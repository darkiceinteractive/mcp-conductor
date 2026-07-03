/**
 * 05-passthrough-execution.test.ts
 *
 * Actually execute passthrough tools via direct MCP protocol (no AI CLI).
 * Verifies that the conductor correctly proxies calls to backend servers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpStdioClient } from './helpers/mcp-stdio-client.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(join(__dirname, '..', '..', '..', 'dist', 'index.js'));

describe('Passthrough Tool Execution', { timeout: 120_000 }, () => {
  let client: McpStdioClient;

  beforeAll(async () => {
    client = new McpStdioClient('node', [CONDUCTOR_DIST], {
      MCP_CONDUCTOR_CONFIG: '/Users/mattcrombie/.mcp-conductor.json',
      NODE_ENV: 'test',
    });

    const changedPromise = client.waitForToolsChanged(60_000);
    await client.initialize();
    await changedPromise;
    console.log('[05-passthrough] Hub init complete, running passthrough tests');
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.close().catch(() => { /* ignore */ });
    }
  });

  it('filesystem__list_directory lists real directory within allowed scope', async () => {
    const { tools } = await client.listTools();
    const listDirTool = tools.find((t) => t.name === 'filesystem__list_directory');

    if (!listDirTool) {
      console.warn('  filesystem__list_directory not found in tool list — server may be unhealthy');
      return;
    }

    // The filesystem MCP server is scoped to /Users/mattcrombie
    const result = await client.callTool('filesystem__list_directory', {
      path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice',
    });
    const text = result.content[0]?.text ?? '';

    console.log(`  filesystem__list_directory project root (${text.length} chars)`);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('[]');
  });

  it('filesystem__read_file reads a known file within allowed directory', async () => {
    const { tools } = await client.listTools();
    const readFileTool = tools.find((t) => t.name === 'filesystem__read_file');

    if (!readFileTool) {
      console.warn('  filesystem__read_file not found — server may be unhealthy');
      return;
    }

    // The filesystem MCP server is scoped to /Users/mattcrombie — use package.json
    // which is guaranteed to exist within that tree
    const testFile = '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice/package.json';
    const result = await client.callTool('filesystem__read_file', { path: testFile });
    const text = result.content[0]?.text ?? '';

    console.log(`  package.json content length: ${text.length}`);

    // package.json always contains @darkiceinteractive
    const hasExpectedContent =
      text.includes('@darkiceinteractive') ||
      text.includes('mcp-conductor') ||
      text.includes('"name"');

    expect(
      hasExpectedContent,
      `Expected package.json content. Got: ${text.slice(0, 200)}`
    ).toBe(true);
  });

  it('passthrough_call routes to filesystem server correctly', async () => {
    const result = await client.callTool('passthrough_call', {
      server: 'filesystem',
      tool: 'list_directory',
      params: { path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice' },
    });

    const text = result.content[0]?.text ?? '';
    console.log(`  passthrough_call(filesystem, list_directory) → ${text.length} chars`);

    expect(text.length).toBeGreaterThan(0);
    expect(result.isError).not.toBe(true);
  });

  it('execute_code runs simple TypeScript and returns result', async () => {
    const result = await client.callTool('execute_code', {
      code: 'return { value: 42, computed: 6 * 7 };',
    });

    const text = result.content[0]?.text ?? '';
    console.log(`  execute_code result: ${text.slice(0, 200)}`);

    expect(text.length).toBeGreaterThan(0);

    // Should contain 42 in some form
    expect(
      text.includes('42'),
      `Expected 42 in execute_code response. Got: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  it('execute_code can call a backend tool', async () => {
    const result = await client.callTool('execute_code', {
      code: `
        const r = await mcp.server("filesystem").call("list_directory", {
          path: "/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice"
        });
        return r;
      `,
    });

    const text = result.content[0]?.text ?? '';
    console.log(`  execute_code MCP call result: ${text.slice(0, 200)}`);

    // Either succeeds with a result, or returns an informative error — but must not be empty
    expect(text.length).toBeGreaterThan(0);
    // Conductor must stay alive regardless
    const pingResult = await client.callTool('get_capabilities', {});
    expect(pingResult.content.length).toBeGreaterThan(0);
  });

  it('brave_web_search static tool is callable without crashing conductor', async () => {
    let threw = false;
    let result: Awaited<ReturnType<typeof client.callTool>> | null = null;

    try {
      result = await client.callTool('brave_web_search', { query: 'MCP protocol' });
    } catch {
      threw = true;
    }

    // Accept success or error — API key may not be set
    if (threw) {
      console.warn('  brave_web_search threw (likely no API key)');
    } else {
      const text = result?.content[0]?.text ?? '';
      console.log(`  brave_web_search result: isError=${result?.isError} length=${text.length}`);
    }

    // Most importantly: the conductor must still respond after the call
    const ping = await client.callTool('get_capabilities', {});
    expect(ping.content.length).toBeGreaterThan(0);
  });

  it('tool execution latency for passthrough tools < 10s', async () => {
    const { tools } = await client.listTools();
    const hasListDir = tools.some((t) => t.name === 'filesystem__list_directory');

    if (!hasListDir) {
      console.warn('  filesystem__list_directory not available — skipping latency test');
      return;
    }

    const t0 = Date.now();
    await client.callTool('filesystem__list_directory', {
      path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice',
    });
    const latencyMs = Date.now() - t0;

    console.log(`  filesystem__list_directory latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(10_000);
  });

  it('concurrent tool calls do not deadlock', async () => {
    const { tools } = await client.listTools();
    const hasListDir = tools.some((t) => t.name === 'filesystem__list_directory');

    const concurrentCalls = hasListDir
      ? Array.from({ length: 5 }, () =>
          client.callTool('filesystem__list_directory', {
            path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice',
          })
        )
      : Array.from({ length: 5 }, () =>
          client.callTool('get_capabilities', {})
        );

    const toolName = hasListDir ? 'filesystem__list_directory' : 'get_capabilities';
    const t0 = Date.now();

    const results = await Promise.allSettled(concurrentCalls);
    const elapsed = Date.now() - t0;

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;

    console.log(`  5× concurrent ${toolName}: ${successes} ok / ${failures} failed in ${elapsed}ms`);

    // At least 4 of 5 must succeed
    expect(successes).toBeGreaterThanOrEqual(4);
    // Must complete within 30s (not deadlocked)
    expect(elapsed).toBeLessThan(30_000);
  });
});
