/**
 * Tests for src/registry/registry.ts (ToolRegistry class)
 *
 * PRD §5 Phase 1 test cases:
 * - refresh populates catalog from connected backends
 * - refresh handles backend that throws during tools/list
 * - getTool returns null for unknown tool
 * - getAllTools returns flat list across servers
 * - getServerTools filters by server
 * - hot reload: tool-added event fires when backend adds tool
 * - hot reload: tool-removed event fires when tool disappears
 * - hot reload: tool-updated event fires when schema changes
 * - annotate: metadata persists across refresh
 */

import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../../../src/registry/registry.js';
import type { BackendBridge, ToolDefinition, JsonSchema } from '../../../src/registry/index.js';
import type { RegistryEvent } from '../../../src/registry/events.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TMP = tmpdir();
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    try { await rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmpPath(label: string): string {
  return join(TMP, `mcp-conductor-reg-${label}-${Date.now()}.json`);
}

function tmpDir(label: string): string {
  return join(TMP, `mcp-conductor-reg-${label}-${Date.now()}`);
}

type RawTool = { name: string; description?: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema };
type ServerEntry = { name: string; status: string; toolCount: number };

/**
 * Build a minimal BackendBridge mock. Callers can mutate `servers` and
 * `toolsByServer` between calls to simulate hot-reload scenarios.
 */
function makeBridge(
  servers: ServerEntry[],
  toolsByServer: Record<string, RawTool[]>
): BackendBridge & {
  _fireConnected(name: string): void;
  _fireDisconnected(name: string): void;
} {
  const connectedListeners: Array<(name: string) => void> = [];
  const disconnectedListeners: Array<(name: string) => void> = [];

  return {
    listServers: () => [...servers],
    getServerTools: (serverName: string) => toolsByServer[serverName] ?? [],
    on(event, listener) {
      if (event === 'serverConnected') connectedListeners.push(listener as (name: string) => void);
      else disconnectedListeners.push(listener as (name: string) => void);
    },
    off(event, listener) {
      if (event === 'serverConnected') {
        const idx = connectedListeners.indexOf(listener as (name: string) => void);
        if (idx !== -1) connectedListeners.splice(idx, 1);
      } else {
        const idx = disconnectedListeners.indexOf(listener as (name: string) => void);
        if (idx !== -1) disconnectedListeners.splice(idx, 1);
      }
    },
    _fireConnected(name: string) {
      connectedListeners.forEach((l) => l(name));
    },
    _fireDisconnected(name: string) {
      disconnectedListeners.forEach((l) => l(name));
    },
  };
}

function makeRegistry(
  bridge: BackendBridge,
  extra: { snapshotPath?: string; typesDir?: string; validateInputs?: boolean } = {}
): ToolRegistry {
  return new ToolRegistry({ bridge, ...extra });
}

// ─── refresh ─────────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('populates catalog from connected backends', async () => {
    const bridge = makeBridge(
      [
        { name: 'github', status: 'connected', toolCount: 2 },
        { name: 'filesystem', status: 'connected', toolCount: 1 },
      ],
      {
        github: [
          { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
          { name: 'create_pr', description: 'Create PR', inputSchema: { type: 'object' } },
        ],
        filesystem: [
          { name: 'read_file', description: 'Read file', inputSchema: { type: 'object' } },
        ],
      }
    );

    const registry = makeRegistry(bridge);
    const tools = await registry.refresh();

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toContain('list_issues');
    expect(tools.map((t) => t.name)).toContain('create_pr');
    expect(tools.map((t) => t.name)).toContain('read_file');
  });

  it('skips servers that are not connected', async () => {
    const bridge = makeBridge(
      [
        { name: 'github', status: 'connected', toolCount: 1 },
        { name: 'offline', status: 'disconnected', toolCount: 0 },
      ],
      {
        github: [{ name: 'list_repos', description: 'List repos', inputSchema: {} }],
        offline: [{ name: 'offline_tool', description: 'Never reached', inputSchema: {} }],
      }
    );

    const registry = makeRegistry(bridge);
    const tools = await registry.refresh();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_repos');
  });

  it('handles backend that throws during tools/list', async () => {
    const bridge = makeBridge(
      [{ name: 'bad-server', status: 'connected', toolCount: 0 }],
      {}
    );

    // Override getServerTools to throw for this server
    const originalGet = bridge.getServerTools.bind(bridge);
    bridge.getServerTools = (name: string) => {
      if (name === 'bad-server') throw new Error('Connection reset');
      return originalGet(name);
    };

    const registry = makeRegistry(bridge);

    // Must not throw — errors per backend are swallowed
    await expect(registry.refresh()).resolves.not.toThrow();

    const tools = registry.getAllTools();
    expect(tools).toHaveLength(0);
  });

  it('returns empty array when no servers are connected', async () => {
    const bridge = makeBridge([], {});
    const registry = makeRegistry(bridge);
    const tools = await registry.refresh();
    expect(tools).toHaveLength(0);
  });

  it('applies missing description and inputSchema defaults', async () => {
    const bridge = makeBridge(
      [{ name: 'test', status: 'connected', toolCount: 1 }],
      {
        test: [{ name: 'bare_tool' }], // no description or inputSchema
      }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const tool = registry.getTool('test', 'bare_tool');
    expect(tool).not.toBeNull();
    expect(tool!.description).toBe('');
    expect(tool!.inputSchema).toEqual({});
  });
});

// ─── getTool / getAllTools / getServerTools ───────────────────────────────────

describe('lookup', () => {
  async function populatedRegistry(): Promise<ToolRegistry> {
    const bridge = makeBridge(
      [
        { name: 'github', status: 'connected', toolCount: 2 },
        { name: 'search', status: 'connected', toolCount: 1 },
      ],
      {
        github: [
          { name: 'list_issues', description: 'List', inputSchema: {} },
          { name: 'create_pr', description: 'Create', inputSchema: {} },
        ],
        search: [{ name: 'web_search', description: 'Search', inputSchema: {} }],
      }
    );
    const reg = makeRegistry(bridge);
    await reg.refresh();
    return reg;
  }

  it('getTool returns the tool when present', async () => {
    const reg = await populatedRegistry();
    const tool = reg.getTool('github', 'list_issues');
    expect(tool).not.toBeNull();
    expect(tool!.server).toBe('github');
    expect(tool!.name).toBe('list_issues');
  });

  it('getTool returns null for unknown tool', async () => {
    const reg = await populatedRegistry();
    expect(reg.getTool('github', 'nonexistent')).toBeNull();
    expect(reg.getTool('nonexistent-server', 'list_issues')).toBeNull();
  });

  it('getAllTools returns flat list across servers', async () => {
    const reg = await populatedRegistry();
    const all = reg.getAllTools();
    expect(all).toHaveLength(3);
    const names = all.map((t) => t.name);
    expect(names).toContain('list_issues');
    expect(names).toContain('create_pr');
    expect(names).toContain('web_search');
  });

  it('getServerTools filters correctly by server', async () => {
    const reg = await populatedRegistry();
    const ghTools = reg.getServerTools('github');
    expect(ghTools).toHaveLength(2);
    expect(ghTools.every((t) => t.server === 'github')).toBe(true);

    const searchTools = reg.getServerTools('search');
    expect(searchTools).toHaveLength(1);
    expect(searchTools[0].name).toBe('web_search');
  });

  it('getServerTools returns empty array for unknown server', async () => {
    const reg = await populatedRegistry();
    expect(reg.getServerTools('nonexistent')).toHaveLength(0);
  });
});

// ─── hot reload events ────────────────────────────────────────────────────────

describe('hot reload events', () => {
  it('fires tool-added event when backend adds a new tool', async () => {
    const toolsByServer: Record<string, RawTool[]> = {
      github: [{ name: 'list_issues', description: 'List', inputSchema: {} }],
    };
    const servers: ServerEntry[] = [{ name: 'github', status: 'connected', toolCount: 1 }];
    const bridge = makeBridge(servers, toolsByServer);

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const events: RegistryEvent[] = [];
    registry.watch((e) => events.push(e));

    // Simulate backend adding a new tool before reconnect
    toolsByServer.github.push({ name: 'create_pr', description: 'PR', inputSchema: {} });
    bridge._fireConnected('github');

    // Give async handlers time to complete
    await new Promise((r) => setTimeout(r, 50));

    const added = events.filter((e) => e.type === 'tool-added');
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added.some((e) => e.tool === 'create_pr')).toBe(true);
  });

  it('fires tool-removed event when tool disappears from backend', async () => {
    const toolsByServer: Record<string, RawTool[]> = {
      github: [
        { name: 'list_issues', description: 'List', inputSchema: {} },
        { name: 'delete_repo', description: 'Delete', inputSchema: {} },
      ],
    };
    const servers: ServerEntry[] = [{ name: 'github', status: 'connected', toolCount: 2 }];
    const bridge = makeBridge(servers, toolsByServer);

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const events: RegistryEvent[] = [];
    registry.watch((e) => events.push(e));

    // Remove delete_repo from backend
    toolsByServer.github = [{ name: 'list_issues', description: 'List', inputSchema: {} }];
    bridge._fireConnected('github');

    await new Promise((r) => setTimeout(r, 50));

    const removed = events.filter((e) => e.type === 'tool-removed');
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(removed.some((e) => e.tool === 'delete_repo')).toBe(true);
  });

  it('fires tool-updated event when schema changes', async () => {
    const toolsByServer: Record<string, RawTool[]> = {
      github: [
        {
          name: 'list_issues',
          description: 'List issues',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
        },
      ],
    };
    const servers: ServerEntry[] = [{ name: 'github', status: 'connected', toolCount: 1 }];
    const bridge = makeBridge(servers, toolsByServer);

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const events: RegistryEvent[] = [];
    registry.watch((e) => events.push(e));

    // Change the schema on reconnect
    toolsByServer.github[0].inputSchema = {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    };
    bridge._fireConnected('github');

    await new Promise((r) => setTimeout(r, 50));

    const updated = events.filter((e) => e.type === 'tool-updated');
    expect(updated.length).toBeGreaterThanOrEqual(1);
    expect(updated.some((e) => e.tool === 'list_issues')).toBe(true);
  });

  it('fires server-disconnected event on bridge disconnect', () => {
    const bridge = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 0 }],
      {}
    );
    const registry = makeRegistry(bridge);

    const events: RegistryEvent[] = [];
    registry.watch((e) => events.push(e));

    bridge._fireDisconnected('github');

    const disconnected = events.filter((e) => e.type === 'server-disconnected');
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0].server).toBe('github');
  });

  it('watch returns unsubscribe that stops events', async () => {
    const toolsByServer: Record<string, RawTool[]> = {
      github: [{ name: 'list_issues', description: 'List', inputSchema: {} }],
    };
    const bridge = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      toolsByServer
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const events: RegistryEvent[] = [];
    const { unsubscribe } = registry.watch((e) => events.push(e));

    // First reconnect — events captured
    bridge._fireConnected('github');
    await new Promise((r) => setTimeout(r, 50));

    const beforeCount = events.length;

    // Unsubscribe then fire again
    unsubscribe();
    toolsByServer.github.push({ name: 'new_tool', description: 'New', inputSchema: {} });
    bridge._fireConnected('github');
    await new Promise((r) => setTimeout(r, 50));

    // No new events after unsubscribe
    expect(events.length).toBe(beforeCount);
  });
});

// ─── annotate ────────────────────────────────────────────────────────────────

describe('annotate', () => {
  it('applies metadata to an existing tool', async () => {
    const bridge = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      { github: [{ name: 'list_issues', description: 'List', inputSchema: {} }] }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    registry.annotate('github', 'list_issues', {
      cost: 'low',
      cacheable: true,
      cacheTtl: 60_000,
      routing: 'passthrough',
    });

    const tool = registry.getTool('github', 'list_issues')!;
    expect(tool.cost).toBe('low');
    expect(tool.cacheable).toBe(true);
    expect(tool.cacheTtl).toBe(60_000);
    expect(tool.routing).toBe('passthrough');
  });

  it('metadata persists across refresh', async () => {
    const toolsByServer: Record<string, RawTool[]> = {
      github: [{ name: 'list_issues', description: 'List', inputSchema: {} }],
    };
    const servers: ServerEntry[] = [{ name: 'github', status: 'connected', toolCount: 1 }];
    const bridge = makeBridge(servers, toolsByServer);

    const registry = makeRegistry(bridge);
    await registry.refresh();

    registry.annotate('github', 'list_issues', { cacheable: true, cost: 'medium' });

    // Re-refresh simulates backend re-scan
    await registry.refresh();

    const tool = registry.getTool('github', 'list_issues')!;
    expect(tool.cacheable).toBe(true);
    expect(tool.cost).toBe('medium');
  });

  it('is a no-op for unknown tools', async () => {
    const bridge = makeBridge([], {});
    const registry = makeRegistry(bridge);

    // Must not throw
    expect(() => registry.annotate('ghost', 'nonexistent', { cost: 'high' })).not.toThrow();
  });

  it('does not allow annotating core schema fields (name, description)', async () => {
    const bridge = makeBridge(
      [{ name: 'test', status: 'connected', toolCount: 1 }],
      { test: [{ name: 'my_tool', description: 'original', inputSchema: {} }] }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    // name and description are not in the allowed annotation list — silently ignored
    registry.annotate('test', 'my_tool', {
      description: 'OVERRIDDEN',
      name: 'hacked_name',
    } as Partial<ToolDefinition>);

    const tool = registry.getTool('test', 'my_tool')!;
    expect(tool.description).toBe('original');
    expect(tool.name).toBe('my_tool');
  });
});

// ─── validateInput ────────────────────────────────────────────────────────────

describe('validateInput', () => {
  it('validates against tool inputSchema', async () => {
    const bridge = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      {
        github: [
          {
            name: 'list_issues',
            description: 'List',
            inputSchema: {
              type: 'object',
              properties: { owner: { type: 'string' }, repo: { type: 'string' } },
              required: ['owner', 'repo'],
            },
          },
        ],
      }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    expect(
      registry.validateInput('github', 'list_issues', { owner: 'darkice', repo: 'mcp' }).valid
    ).toBe(true);
    expect(
      registry.validateInput('github', 'list_issues', { owner: 'darkice' }).valid
    ).toBe(false);
  });

  it('returns valid: true for unknown tool (fail-open)', async () => {
    const bridge = makeBridge([], {});
    const registry = makeRegistry(bridge);

    const result = registry.validateInput('ghost', 'nonexistent', { anything: true });
    expect(result.valid).toBe(true);
  });

  it('always returns valid: true when validateInputs: false', async () => {
    const bridge = makeBridge(
      [{ name: 'test', status: 'connected', toolCount: 1 }],
      {
        test: [
          {
            name: 'strict_tool',
            description: 'Strict',
            inputSchema: {
              type: 'object',
              properties: { required_field: { type: 'string' } },
              required: ['required_field'],
            },
          },
        ],
      }
    );

    const registry = makeRegistry(bridge, { validateInputs: false });
    await registry.refresh();

    // Missing required field, but validation is disabled
    const result = registry.validateInput('test', 'strict_tool', {});
    expect(result.valid).toBe(true);
  });
});

// ─── snapshot save/load (via class methods) ───────────────────────────────────

describe('snapshot via ToolRegistry', () => {
  it('saveSnapshot persists catalog; loadSnapshot restores it', async () => {
    const path = tmpPath('class-snap');
    cleanupPaths.push(path);

    const bridge = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      { github: [{ name: 'list_issues', description: 'List', inputSchema: {} }] }
    );

    const registry = makeRegistry(bridge, { snapshotPath: path });
    await registry.refresh();
    await registry.saveSnapshot();

    // Fresh registry with empty bridge — load snapshot without refresh
    const bridge2 = makeBridge([], {});
    const registry2 = makeRegistry(bridge2, { snapshotPath: path });
    await registry2.loadSnapshot();

    const tools = registry2.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_issues');
  });

  it('saveSnapshot throws when snapshotPath is not configured', async () => {
    const bridge = makeBridge([], {});
    const registry = makeRegistry(bridge); // no snapshotPath

    await expect(registry.saveSnapshot()).rejects.toThrow('snapshotPath');
  });

  it('loadSnapshot with no path configured is a no-op', async () => {
    const bridge = makeBridge([], {});
    const registry = makeRegistry(bridge); // no snapshotPath

    // Must not throw
    await expect(registry.loadSnapshot()).resolves.toBeUndefined();
  });

  it('does not overwrite live catalog entries with snapshot', async () => {
    const path = tmpPath('no-overwrite');
    cleanupPaths.push(path);

    // Save a snapshot with one tool
    const bridge1 = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      { github: [{ name: 'old_tool', description: 'Snapshot description', inputSchema: {} }] }
    );
    const reg1 = makeRegistry(bridge1, { snapshotPath: path });
    await reg1.refresh();
    await reg1.saveSnapshot();

    // Second registry already has the same tool via live refresh with different description
    const bridge2 = makeBridge(
      [{ name: 'github', status: 'connected', toolCount: 1 }],
      { github: [{ name: 'old_tool', description: 'Live description', inputSchema: {} }] }
    );
    const reg2 = makeRegistry(bridge2, { snapshotPath: path });
    await reg2.refresh();

    // Now load snapshot — existing live entry must NOT be overwritten
    await reg2.loadSnapshot();

    const tool = reg2.getTool('github', 'old_tool')!;
    expect(tool.description).toBe('Live description');
  });
});

// ─── generateTypes / writeTypesToDir (integration smoke) ─────────────────────

describe('type generation integration', () => {
  it('generateTypes returns a non-empty string containing all server namespaces', async () => {
    const bridge = makeBridge(
      [
        { name: 'github', status: 'connected', toolCount: 1 },
        { name: 'filesystem', status: 'connected', toolCount: 1 },
      ],
      {
        github: [{ name: 'list_issues', description: 'List', inputSchema: { type: 'object' } }],
        filesystem: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
      }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const dts = await registry.generateTypes();
    expect(dts).toContain('github');
    expect(dts).toContain('filesystem');
    expect(dts).toContain('declare global');
  });

  it('writeTypesToDir writes expected files', async () => {
    const dir = tmpDir('write');
    cleanupPaths.push(dir);

    const bridge = makeBridge(
      [{ name: 'brave_search', status: 'connected', toolCount: 1 }],
      { brave_search: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object' } }] }
    );

    const registry = makeRegistry(bridge);
    await registry.refresh();

    const written = await registry.writeTypesToDir(dir);

    expect(written.some((p) => p.endsWith('brave_search.d.ts'))).toBe(true);
    expect(written.some((p) => p.endsWith('brave_search.routing.json'))).toBe(true);
    expect(written.some((p) => p.endsWith('_index.d.ts'))).toBe(true);
  });
});
