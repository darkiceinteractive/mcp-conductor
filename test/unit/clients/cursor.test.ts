/**
 * Unit tests for src/cli/clients/cursor.ts (MC2)
 *
 * Verifies:
 * - parse() returns null for a missing file.
 * - parse() correctly normalises a valid Cursor mcp.json.
 * - serialize() writes the conductor entry and creates a backup.
 * - serialize() with keepOnlyConductor strips all other servers.
 * - serialize() preserves other top-level keys from config.raw.
 * - Round-trip: parse → serialize → parse produces the same servers map.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import the adapter (also triggers ADAPTERS.set registration as a side-effect).
import { CURSOR_ADAPTER } from '../../../src/cli/clients/cursor.js';
import { ADAPTERS } from '../../../src/cli/clients/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp: string;

function writeMcpJson(obj: unknown): string {
  const path = join(tmp, 'mcp.json');
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8');
  return path;
}

function readMcpJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const CONDUCTOR_ENTRY = {
  command: 'npx',
  args: ['-y', '@darkiceinteractive/mcp-conductor'],
  env: { MCP_CONDUCTOR_MODE: 'passthrough' },
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cursor-adapter-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CURSOR_ADAPTER', () => {
  it('is registered in ADAPTERS under "cursor"', () => {
    expect(ADAPTERS.get('cursor')).toBe(CURSOR_ADAPTER);
    expect(CURSOR_ADAPTER.client).toBe('cursor');
  });

  it('parse() returns null for a missing file', () => {
    const result = CURSOR_ADAPTER.parse(join(tmp, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('parse() correctly normalises a valid Cursor mcp.json', () => {
    const path = writeMcpJson({
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
        'minimal-server': { command: 'uvx' },
      },
      otherKey: 'preserved',
    });

    const config = CURSOR_ADAPTER.parse(path);
    expect(config).not.toBeNull();
    expect(config!.servers['my-server']).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
    });
    expect(config!.servers['minimal-server']).toEqual({ command: 'uvx' });
    // raw should preserve all original top-level keys
    expect((config!.raw as Record<string, unknown>)['otherKey']).toBe('preserved');
  });

  it('serialize() writes conductor entry and creates a backup', () => {
    const path = writeMcpJson({
      mcpServers: { 'existing-server': { command: 'python', args: ['-m', 'server'] } },
    });

    const config = CURSOR_ADAPTER.parse(path)!;
    CURSOR_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readMcpJson(path) as Record<string, unknown>;
    const servers = written['mcpServers'] as Record<string, unknown>;
    expect(servers).toHaveProperty('mcp-conductor');
    expect(servers['mcp-conductor']).toMatchObject({ command: 'npx' });
    expect(servers).toHaveProperty('existing-server');

    // A .bak.YYYYMMDDHHMMSS backup file should have been created in the same dir.
    const siblings = readdirSync(tmp);
    const backups = siblings.filter((f) => f.includes('.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('serialize() with keepOnlyConductor removes all other servers', () => {
    const path = writeMcpJson({
      mcpServers: {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'deno', args: ['b.ts'] },
      },
    });

    const config = CURSOR_ADAPTER.parse(path)!;
    CURSOR_ADAPTER.serialize(path, config, {
      conductorEntry: CONDUCTOR_ENTRY,
      keepOnlyConductor: true,
    });

    const written = readMcpJson(path) as Record<string, unknown>;
    const servers = written['mcpServers'] as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['mcp-conductor']);
  });

  it('serialize() preserves other top-level keys from config.raw', () => {
    const path = writeMcpJson({
      mcpServers: { 'my-server': { command: 'node' } },
      customSetting: true,
      anotherField: { nested: 42 },
    });

    const config = CURSOR_ADAPTER.parse(path)!;
    CURSOR_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readMcpJson(path) as Record<string, unknown>;
    expect(written['customSetting']).toBe(true);
    expect(written['anotherField']).toEqual({ nested: 42 });
  });

  it('round-trip: parse → serialize → parse produces the same servers', () => {
    const path = writeMcpJson({
      mcpServers: {
        'server-x': {
          command: 'uvx',
          args: ['--from', 'my-pkg', 'server'],
          env: { PORT: '3000' },
        },
      },
    });

    // First parse
    const config = CURSOR_ADAPTER.parse(path)!;

    // Serialize (adds conductor, preserves server-x)
    CURSOR_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    // Second parse
    const config2 = CURSOR_ADAPTER.parse(path)!;

    // server-x must survive the round-trip unchanged.
    expect(config2.servers['server-x']).toEqual(config.servers['server-x']);
    // mcp-conductor must be present.
    expect(config2.servers['mcp-conductor']).toMatchObject({ command: 'npx' });
  });
});
