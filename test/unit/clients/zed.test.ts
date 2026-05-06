/**
 * Unit tests for src/cli/clients/zed.ts (ZED_ADAPTER)
 *
 * Verifies:
 * 1. parse() round-trips source:"custom" entries correctly
 * 2. parse() skips source:"extension" entries and logs a warning
 * 3. parse() reads from context_servers (NOT mcpServers)
 * 4. parse() returns null for a missing file
 * 5. parse() returns null for unparseable JSON (graceful fallback)
 * 6. parse() returns empty servers when context_servers is absent
 * 7. serialize() injects source:"custom" on every written entry
 * 8. serialize() preserves other top-level Zed settings (theme, font_size, vim_mode)
 * 9. serialize() with keepOnlyConductor writes only the mcp-conductor entry
 * 10. serialize() upserts mcp-conductor while keeping existing custom servers
 * 11. serialize() writes a .bak.YYYYMMDDHHMMSS backup of the existing file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZED_ADAPTER } from '../../../src/cli/clients/zed.js';
import type { SerializeOptions } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'zed-adapter-test-'));
}

function writeSettings(dir: string, content: object): string {
  const p = join(dir, 'settings.json');
  writeFileSync(p, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return p;
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const CONDUCTOR_ENTRY: SerializeOptions['conductorEntry'] = {
  command: 'npx',
  args: ['@darkiceinteractive/mcp-conductor'],
  env: {},
};

function baseOptions(overrides?: Partial<SerializeOptions>): SerializeOptions {
  return { conductorEntry: CONDUCTOR_ENTRY, ...overrides };
}

// ---------------------------------------------------------------------------
// client identifier
// ---------------------------------------------------------------------------

describe('ZED_ADAPTER.client', () => {
  it('is "zed"', () => {
    expect(ZED_ADAPTER.client).toBe('zed');
  });
});

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe('ZED_ADAPTER.parse()', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips source:custom entries (reads context_servers, not mcpServers)', () => {
    const p = writeSettings(tmp, {
      theme: 'One Dark',
      context_servers: {
        'my-server': {
          source: 'custom',
          command: 'node',
          args: ['server.js'],
          env: { PORT: '3000' },
        },
      },
    });

    const result = ZED_ADAPTER.parse(p);

    expect(result).not.toBeNull();
    expect(result!.servers['my-server']).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { PORT: '3000' },
    });
  });

  it('skips source:extension entries and logs a warning', () => {
    // logger uses console.error (stderr)
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const p = writeSettings(tmp, {
      context_servers: {
        'ext-server': { source: 'extension' },
        'my-server': { source: 'custom', command: 'uvx', args: ['mcp-server'] },
      },
    });

    const result = ZED_ADAPTER.parse(p);

    expect(result).not.toBeNull();
    expect(Object.keys(result!.servers)).not.toContain('ext-server');
    expect(result!.servers['my-server']).toEqual({ command: 'uvx', args: ['mcp-server'] });
    // A warning line referencing the skipped entry must have been emitted
    const allOutput = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('skipping non-custom source entry');

    warnSpy.mockRestore();
  });

  it('does NOT read from mcpServers key — returns empty servers when only mcpServers present', () => {
    const p = writeSettings(tmp, {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'] },
      },
    });

    const result = ZED_ADAPTER.parse(p);

    expect(result).not.toBeNull();
    expect(Object.keys(result!.servers)).toHaveLength(0);
  });

  it('returns null for a file that does not exist', () => {
    const result = ZED_ADAPTER.parse(join(tmp, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null for unparseable content (e.g. JSON5 comment)', () => {
    const p = join(tmp, 'settings.json');
    // JSON5-style comment makes it invalid JSON
    writeFileSync(p, '{ "theme": "One Dark", // comment\n }', 'utf8');

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = ZED_ADAPTER.parse(p);
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('returns empty servers when context_servers key is absent', () => {
    const p = writeSettings(tmp, { theme: 'Gruvbox', font_size: 14 });

    const result = ZED_ADAPTER.parse(p);

    expect(result).not.toBeNull();
    expect(result!.servers).toEqual({});
    // raw object must be preserved for round-trip writes
    expect((result!.raw as Record<string, unknown>)['theme']).toBe('Gruvbox');
  });
});

// ---------------------------------------------------------------------------
// serialize()
// ---------------------------------------------------------------------------

describe('ZED_ADAPTER.serialize()', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('injects source:"custom" on every entry written to context_servers', () => {
    const p = writeSettings(tmp, {
      context_servers: {
        'my-server': { source: 'custom', command: 'node', args: ['s.js'] },
      },
    });

    const parsed = ZED_ADAPTER.parse(p)!;
    ZED_ADAPTER.serialize(p, parsed, baseOptions());

    const out = readSettings(p);
    const cs = out['context_servers'] as Record<string, Record<string, unknown>>;

    for (const [name, entry] of Object.entries(cs)) {
      expect(entry['source'], `entry "${name}" is missing source:"custom"`).toBe('custom');
    }
    expect(cs['mcp-conductor']!['source']).toBe('custom');
  });

  it('preserves other top-level Zed settings (theme, font_size, vim_mode)', () => {
    const p = writeSettings(tmp, {
      theme: 'One Dark',
      font_size: 16,
      vim_mode: true,
      context_servers: {},
    });

    const parsed = ZED_ADAPTER.parse(p)!;
    ZED_ADAPTER.serialize(p, parsed, baseOptions());

    const out = readSettings(p);
    expect(out['theme']).toBe('One Dark');
    expect(out['font_size']).toBe(16);
    expect(out['vim_mode']).toBe(true);
  });

  it('keepOnlyConductor: writes only the mcp-conductor entry, drops all others', () => {
    const p = writeSettings(tmp, {
      theme: 'Gruvbox',
      context_servers: {
        'server-a': { source: 'custom', command: 'node', args: ['a.js'] },
        'server-b': { source: 'custom', command: 'uvx', args: ['b'] },
      },
    });

    const parsed = ZED_ADAPTER.parse(p)!;
    ZED_ADAPTER.serialize(p, parsed, baseOptions({ keepOnlyConductor: true }));

    const out = readSettings(p);
    const cs = out['context_servers'] as Record<string, unknown>;

    expect(Object.keys(cs)).toEqual(['mcp-conductor']);
    // Other top-level settings must still be present
    expect(out['theme']).toBe('Gruvbox');
  });

  it('upserts mcp-conductor while keeping existing custom servers in round-trip mode', () => {
    const p = writeSettings(tmp, {
      context_servers: {
        'existing-server': { source: 'custom', command: 'deno', args: ['run', 's.ts'] },
      },
    });

    const parsed = ZED_ADAPTER.parse(p)!;
    ZED_ADAPTER.serialize(p, parsed, baseOptions());

    const out = readSettings(p);
    const cs = out['context_servers'] as Record<string, Record<string, unknown>>;

    expect(cs['existing-server']).toBeDefined();
    expect(cs['mcp-conductor']).toBeDefined();
    expect(cs['mcp-conductor']!['command']).toBe('npx');
    expect(cs['mcp-conductor']!['source']).toBe('custom');
  });

  it('creates a .bak.YYYYMMDDHHMMSS backup before writing', () => {
    const p = writeSettings(tmp, {
      context_servers: {
        'a': { source: 'custom', command: 'node', args: [] },
      },
    });

    const parsed = ZED_ADAPTER.parse(p)!;
    ZED_ADAPTER.serialize(p, parsed, baseOptions());

    const files = readdirSync(tmp);
    const backups = files.filter((f) => f.includes('.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // Suffix must be exactly 14 digits (YYYYMMDDHHMMSS)
    expect(backups[0]).toMatch(/\.bak\.\d{14}$/);
  });
});
