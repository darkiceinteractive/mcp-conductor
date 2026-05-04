/**
 * Tests for src/server/passthrough-registrar.ts
 *
 * Covers:
 * 1. Tools with routing:"passthrough" are registered under <server>__<tool> names.
 * 2. Tools with no routing (or routing:"execute_code") are NOT registered.
 * 3. Tool name is sanitised (non-alphanumeric chars replaced with _).
 * 4. The registered handler forwards params to mcpHub.callTool() and returns
 *    the result as text content.
 * 5. Return value is the count of registered tools.
 * 6. built-in recommendations apply only when routing is absent; user
 *    annotations take precedence.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildPassthroughToolName,
  registerPassthroughTools,
  type McpServerLike,
  type McpHubLike,
} from '../../src/server/passthrough-registrar.js';
import {
  applyBuiltInRecommendations,
  BUILT_IN_ROUTING,
} from '../../src/registry/built-in-recommendations.js';
import type { ToolDefinition } from '../../src/registry/index.js';

// ─── Stub helpers ─────────────────────────────────────────────────────────────

/** Minimal ToolRegistry stub — only getAllTools() is needed. */
function makeRegistry(tools: ToolDefinition[]): { getAllTools(): ToolDefinition[] } {
  return { getAllTools: () => tools };
}

/** Capture every registerTool call for inspection. */
function makeServer(): McpServerLike & {
  _registrations: Array<{
    name: string;
    config: Parameters<McpServerLike['registerTool']>[1];
    handler: Parameters<McpServerLike['registerTool']>[2];
  }>;
} {
  const _registrations: Array<{
    name: string;
    config: Parameters<McpServerLike['registerTool']>[1];
    handler: Parameters<McpServerLike['registerTool']>[2];
  }> = [];

  return {
    _registrations,
    registerTool(name, config, handler) {
      _registrations.push({ name, config, handler });
    },
  };
}

/** Simple hub stub that records calls and returns a canned result. */
function makeHub(result: unknown = { data: 'ok' }): McpHubLike & {
  _calls: Array<{ server: string; tool: string; params: Record<string, unknown> }>;
} {
  const _calls: Array<{ server: string; tool: string; params: Record<string, unknown> }> = [];
  return {
    _calls,
    async callTool(server, tool, params) {
      _calls.push({ server, tool, params });
      return result;
    },
  };
}

// ─── buildPassthroughToolName ─────────────────────────────────────────────────

describe('buildPassthroughToolName', () => {
  it('joins server and tool with double underscore', () => {
    expect(buildPassthroughToolName('github', 'get_me')).toBe('github__get_me');
  });

  it('preserves hyphens in server name (hyphens are valid in MCP tool names)', () => {
    // MCP tool names allow ^[a-zA-Z0-9_-]+$ so hyphens are preserved, not replaced.
    expect(buildPassthroughToolName('brave-search', 'brave_web_search')).toBe(
      'brave-search__brave_web_search'
    );
  });

  it('replaces dots and spaces with underscores', () => {
    expect(buildPassthroughToolName('my.server', 'tool name')).toBe(
      'my_server__tool_name'
    );
  });
});

// ─── registerPassthroughTools ────────────────────────────────────────────────

describe('registerPassthroughTools', () => {
  it('registers only tools with routing:"passthrough"', () => {
    const tools: ToolDefinition[] = [
      { server: 'github', name: 'get_me', description: 'Get auth user', inputSchema: {}, routing: 'passthrough' },
      { server: 'github', name: 'create_repo', description: 'Create repo', inputSchema: {}, routing: 'execute_code' },
      { server: 'github', name: 'list_issues', description: 'List issues', inputSchema: {} }, // no routing -> execute_code default
    ];

    const server = makeServer();
    const hub = makeHub();
    const count = registerPassthroughTools(makeRegistry(tools) as never, server, hub);

    expect(count).toBe(1);
    expect(server._registrations).toHaveLength(1);
    expect(server._registrations[0].name).toBe('github__get_me');
  });

  it('registered handler calls hub.callTool with correct server, tool, params', async () => {
    const tools: ToolDefinition[] = [
      {
        server: 'filesystem',
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        routing: 'passthrough',
      },
    ];

    const server = makeServer();
    const hub = makeHub({ content: 'hello' });
    registerPassthroughTools(makeRegistry(tools) as never, server, hub);

    const handler = server._registrations[0].handler;
    await handler({ path: '/tmp/test.txt' });

    expect(hub._calls).toHaveLength(1);
    expect(hub._calls[0]).toEqual({
      server: 'filesystem',
      tool: 'read_file',
      params: { path: '/tmp/test.txt' },
    });
  });

  it('handler returns result as text content', async () => {
    const tools: ToolDefinition[] = [
      { server: 'brave-search', name: 'brave_web_search', description: 'Search', inputSchema: {}, routing: 'passthrough' },
    ];

    const result = [{ title: 'Result', url: 'https://example.com' }];
    const server = makeServer();
    const hub = makeHub(result);
    registerPassthroughTools(makeRegistry(tools) as never, server, hub);

    const handler = server._registrations[0].handler;
    const response = await handler({ query: 'test' });

    expect(response.content[0].type).toBe('text');
    expect(JSON.parse(response.content[0].text)).toEqual(result);
    expect(response.structuredContent).toMatchObject({ success: true, result });
  });

  it('returns 0 and registers nothing when no passthrough tools present', () => {
    const tools: ToolDefinition[] = [
      { server: 'github', name: 'delete_repo', description: 'Delete', inputSchema: {}, routing: 'execute_code' },
    ];

    const server = makeServer();
    const hub = makeHub();
    const count = registerPassthroughTools(makeRegistry(tools) as never, server, hub);

    expect(count).toBe(0);
    expect(server._registrations).toHaveLength(0);
  });
});

// ─── applyBuiltInRecommendations ─────────────────────────────────────────────

describe('applyBuiltInRecommendations', () => {
  it('annotates known passthrough tools when routing is absent', () => {
    const tools: Array<{ server: string; name: string; routing?: string }> = [
      { server: 'github', name: 'get_me' },
      { server: 'github', name: 'create_repo' },
      { server: 'filesystem', name: 'read_file' },
      { server: 'filesystem', name: 'write_file' },
      { server: 'brave-search', name: 'brave_web_search' },
    ];

    const annotations: Array<{ server: string; name: string; routing: string }> = [];
    applyBuiltInRecommendations(tools, (server, name, meta) => {
      annotations.push({ server, name, routing: meta.routing });
    });

    expect(annotations).toContainEqual({ server: 'github', name: 'get_me', routing: 'passthrough' });
    expect(annotations).toContainEqual({ server: 'github', name: 'create_repo', routing: 'execute_code' });
    expect(annotations).toContainEqual({ server: 'filesystem', name: 'read_file', routing: 'passthrough' });
    expect(annotations).toContainEqual({ server: 'filesystem', name: 'write_file', routing: 'execute_code' });
    expect(annotations).toContainEqual({ server: 'brave-search', name: 'brave_web_search', routing: 'passthrough' });
  });

  it('never overrides a user-supplied routing annotation', () => {
    const tools: Array<{ server: string; name: string; routing?: string }> = [
      { server: 'github', name: 'get_me', routing: 'execute_code' }, // user forced execute_code
    ];

    const annotate = vi.fn();
    applyBuiltInRecommendations(tools, annotate);

    expect(annotate).not.toHaveBeenCalled();
  });

  it('skips tools from unknown servers entirely', () => {
    const tools: Array<{ server: string; name: string; routing?: string }> = [
      { server: 'my-custom-server', name: 'do_thing' },
    ];

    const annotate = vi.fn();
    applyBuiltInRecommendations(tools, annotate);

    expect(annotate).not.toHaveBeenCalled();
  });

  it('BUILT_IN_ROUTING covers github, filesystem, brave-search', () => {
    expect(BUILT_IN_ROUTING).toHaveProperty('github');
    expect(BUILT_IN_ROUTING).toHaveProperty('filesystem');
    expect(BUILT_IN_ROUTING).toHaveProperty('brave-search');

    expect(BUILT_IN_ROUTING['github'].passthrough).toContain('get_me');
    expect(BUILT_IN_ROUTING['github'].passthrough).toContain('list_repositories');
    expect(BUILT_IN_ROUTING['filesystem'].passthrough).toContain('read_file');
    expect(BUILT_IN_ROUTING['filesystem'].passthrough).not.toContain('write_file');
    expect(BUILT_IN_ROUTING['brave-search'].passthrough).toContain('brave_web_search');
  });
});
