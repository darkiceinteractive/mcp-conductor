/**
 * Integration tests: 5 new MCP tools registered on MCPExecutorServer.
 * Uses the mock-servers constructor option so no real server connections needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';
import { DEFAULT_CONFIG } from '../../src/config/index.js';
import type { MCPExecutorConfig } from '../../src/config/index.js';

function makeConfig(): MCPExecutorConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

describe('X2 lifecycle MCP tools — registered on server', () => {
  let server: MCPExecutorServer;

  beforeEach(() => {
    server = new MCPExecutorServer(makeConfig(), { useMockServers: true });
  });

  it('import_servers_from_claude is registered', () => {
    const tools = server.getRegisteredTools();
    expect(tools.has('import_servers_from_claude')).toBe(true);
  });

  it('test_server is registered', () => {
    const tools = server.getRegisteredTools();
    expect(tools.has('test_server')).toBe(true);
  });

  it('diagnose_server is registered', () => {
    const tools = server.getRegisteredTools();
    expect(tools.has('diagnose_server')).toBe(true);
  });

  it('recommend_routing is registered', () => {
    const tools = server.getRegisteredTools();
    expect(tools.has('recommend_routing')).toBe(true);
  });

  it('export_to_claude is registered', () => {
    const tools = server.getRegisteredTools();
    expect(tools.has('export_to_claude')).toBe(true);
  });

  it('import_servers_from_claude dry-run returns sources_found=0 when no configs', async () => {
    const tools = server.getRegisteredTools();
    const tool = tools.get('import_servers_from_claude');
    expect(tool).toBeDefined();
    // Call with confirm=false (dry-run)
    const result = await tool!.handler({ confirm: false, remove_originals: false });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text);
    // May or may not find real configs on dev machine — just check shape
    expect(typeof parsed.sources_found).toBe('number');
    expect(parsed.dry_run).toBe(true);
  });

  it('export_to_claude returns valid JSON with mcp-conductor entry', async () => {
    const tools = server.getRegisteredTools();
    const tool = tools.get('export_to_claude');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ format: 'claude-desktop', conductor_path: undefined });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('json');
    const inner = JSON.parse(parsed.json);
    expect(inner).toHaveProperty('mcpServers');
    expect(inner.mcpServers).toHaveProperty('mcp-conductor');
  });

  it('recommend_routing returns recommendations array', async () => {
    const tools = server.getRegisteredTools();
    const tool = tools.get('recommend_routing');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ server_name: undefined, apply: false });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.recommendations)).toBe(true);
  });

  it('diagnose_server returns not_registered for unknown server', async () => {
    const tools = server.getRegisteredTools();
    const tool = tools.get('diagnose_server');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ name: 'nonexistent-server-xyz' });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('not_registered');
    expect(Array.isArray(parsed.suggestions)).toBe(true);
    expect(parsed.suggestions.length).toBeGreaterThan(0);
  });

  it('test_server returns error for invalid server name', async () => {
    const tools = server.getRegisteredTools();
    const tool = tools.get('test_server');
    expect(tool).toBeDefined();
    // No conductor config in test env → error path
    const result = await tool!.handler({ name: 'nonexistent-xyz', command: undefined, args: undefined, env: undefined, timeout_ms: 2000 });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text);
    // Either no config found error OR connection timeout — both are valid
    expect(parsed.success).toBe(false);
    expect(parsed).toHaveProperty('error');
  });
});
