/**
 * Unit tests for src/cli/clients/opencode.ts (MC2 — OpenCode adapter)
 *
 * Verifies:
 * 1. parse() reads from the `mcp` key, not `mcpServers`.
 * 2. type: "local" entries are normalised to {command, args, env}.
 * 3. type: "remote" entries are skipped with a console.warn.
 * 4. serialize() injects type: "local" on every written entry.
 * 5. enabled: false entries are importable; flag survives round-trip in raw.
 * 6. keepOnlyConductor: true writes only the mcp-conductor entry.
 * 7. Other top-level keys are preserved on serialize.
 * 8. Full round-trip: parse → serialize produces correct output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { OPENCODE_ADAPTER } from '../../../src/cli/clients/opencode.js';

// ---------------------------------------------------------------------------
// Mock node:fs so tests never touch the real filesystem.
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockCopyFileSync = vi.mocked(copyFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigJson(mcp: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ mcp, ...extra });
}

const CONDUCTOR_ENTRY = {
  command: 'node',
  args: ['/path/to/conductor/dist/index.js'],
  env: { CONDUCTOR_MODE: 'passthrough' },
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: file exists
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. parse() uses `mcp` key, not `mcpServers`
// ---------------------------------------------------------------------------

describe('parse() — mcp key (not mcpServers)', () => {
  it('returns null when only mcpServers key is present (wrong key)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { 'my-server': { type: 'local', command: 'node', args: ['srv.js'] } },
      }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).toBeNull();
  });

  it('returns servers when mcp key is present', () => {
    mockReadFileSync.mockReturnValue(
      makeConfigJson({ 'my-server': { type: 'local', command: 'node', args: ['srv.js'] } }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).not.toBeNull();
    expect(result!.servers['my-server']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. type: "local" normalisation
// ---------------------------------------------------------------------------

describe('parse() — type: "local" normalisation', () => {
  it('normalises command, args, and env from a local entry', () => {
    mockReadFileSync.mockReturnValue(
      makeConfigJson({
        'fs-server': {
          type: 'local',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { DEBUG: '1' },
        },
      }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).not.toBeNull();
    const entry = result!.servers['fs-server']!;
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(entry.env).toEqual({ DEBUG: '1' });
  });

  it('omits env key when not present in the local entry', () => {
    mockReadFileSync.mockReturnValue(
      makeConfigJson({ 'bare-server': { type: 'local', command: 'uvx', args: ['my-mcp'] } }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).not.toBeNull();
    const entry = result!.servers['bare-server']!;
    expect(entry.command).toBe('uvx');
    expect('env' in entry).toBe(false);
  });

  it('returns null when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = OPENCODE_ADAPTER.parse('/nonexistent/opencode.json');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. type: "remote" skip with warning
// ---------------------------------------------------------------------------

describe('parse() — type: "remote" skip with warning', () => {
  it('skips a remote-only config and emits console.warn mentioning the server name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(
      makeConfigJson({
        'remote-server': { type: 'remote', url: 'https://example.com/mcp' },
      }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    // All entries were remote → nothing importable → null
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('remote-server');
    expect(warnSpy.mock.calls[0]![0]).toContain('remote');
    warnSpy.mockRestore();
  });

  it('imports local entries and warns once for each remote entry in a mixed config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(
      makeConfigJson({
        'local-server': { type: 'local', command: 'node', args: ['srv.js'] },
        'remote-server': { type: 'remote', url: 'https://example.com/mcp' },
      }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.servers)).toEqual(['local-server']);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. serialize() injects type: "local" on every entry
// ---------------------------------------------------------------------------

describe('serialize() — type: "local" injected on all entries', () => {
  it('writes type: "local" on every mcp entry, including conductor', () => {
    const raw = {
      mcp: { 'my-server': { type: 'local', command: 'node', args: ['srv.js'] } },
    };
    const config = {
      servers: { 'my-server': { command: 'node', args: ['srv.js'] } },
      raw,
    };

    OPENCODE_ADAPTER.serialize('/fake/opencode.json', config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = JSON.parse(
      (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string,
    ) as { mcp: Record<string, { type: string }> };

    for (const [name, entry] of Object.entries(written.mcp)) {
      expect(entry.type, `Entry "${name}" missing type: "local"`).toBe('local');
    }
    // conductor must be present too
    expect(written.mcp['mcp-conductor']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. enabled: false handling
// ---------------------------------------------------------------------------

describe('enabled: false round-trip', () => {
  it('parse() imports an enabled: false entry into servers (still importable)', () => {
    mockReadFileSync.mockReturnValue(
      makeConfigJson({
        'disabled-server': { type: 'local', command: 'node', args: ['srv.js'], enabled: false },
      }),
    );
    const result = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(result).not.toBeNull();
    expect(result!.servers['disabled-server']).toBeDefined();
    expect(result!.servers['disabled-server']!.command).toBe('node');
  });

  it('serialize() preserves enabled: false from raw on round-trip', () => {
    const raw = {
      mcp: {
        'disabled-server': { type: 'local', command: 'node', args: ['srv.js'], enabled: false },
      },
    };
    const config = {
      servers: { 'disabled-server': { command: 'node', args: ['srv.js'] } },
      raw,
    };

    OPENCODE_ADAPTER.serialize('/fake/opencode.json', config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = JSON.parse(
      (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string,
    ) as { mcp: Record<string, { enabled?: boolean }> };

    expect(written.mcp['disabled-server']!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. keepOnlyConductor
// ---------------------------------------------------------------------------

describe('serialize() — keepOnlyConductor', () => {
  it('writes only the mcp-conductor entry when keepOnlyConductor is true', () => {
    const raw = {
      mcp: {
        'server-a': { type: 'local', command: 'node', args: ['a.js'] },
        'server-b': { type: 'local', command: 'node', args: ['b.js'] },
      },
      theme: 'dark',
    };
    const config = {
      servers: {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'node', args: ['b.js'] },
      },
      raw,
    };

    OPENCODE_ADAPTER.serialize('/fake/opencode.json', config, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = JSON.parse(
      (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string,
    ) as { mcp: Record<string, { type: string; command: string }> };

    expect(Object.keys(written.mcp)).toEqual(['mcp-conductor']);
    expect(written.mcp['mcp-conductor']!.type).toBe('local');
    expect(written.mcp['mcp-conductor']!.command).toBe(CONDUCTOR_ENTRY.command);
  });
});

// ---------------------------------------------------------------------------
// 7. Preserves other top-level keys
// ---------------------------------------------------------------------------

describe('serialize() — preserves other top-level keys', () => {
  it('retains non-mcp top-level keys from raw', () => {
    const raw = {
      mcp: { 'my-server': { type: 'local', command: 'node', args: ['srv.js'] } },
      theme: 'dark',
      keybindings: { 'ctrl+k': 'clear' },
    };
    const config = {
      servers: { 'my-server': { command: 'node', args: ['srv.js'] } },
      raw,
    };

    OPENCODE_ADAPTER.serialize('/fake/opencode.json', config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = JSON.parse(
      (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string,
    ) as { theme: string; keybindings: Record<string, string> };

    expect(written.theme).toBe('dark');
    expect(written.keybindings).toEqual({ 'ctrl+k': 'clear' });
  });
});

// ---------------------------------------------------------------------------
// 8. Full round-trip: parse → serialize
// ---------------------------------------------------------------------------

describe('round-trip: parse → serialize', () => {
  it('produces a config with type: "local", conductor added, and raw keys preserved', () => {
    const original = {
      mcp: {
        'existing-server': { type: 'local', command: 'npx', args: ['srv'], env: { KEY: 'val' } },
      },
      theme: 'light',
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(original));

    // Step 1: parse
    const parsed = OPENCODE_ADAPTER.parse('/fake/opencode.json');
    expect(parsed).not.toBeNull();

    // Step 2: serialize back
    OPENCODE_ADAPTER.serialize('/fake/opencode.json', parsed!, { conductorEntry: CONDUCTOR_ENTRY });

    const written = JSON.parse(
      (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string,
    ) as {
      mcp: Record<string, { type: string; command: string; env?: Record<string, string> }>;
      theme: string;
    };

    // existing-server preserved with type: "local"
    expect(written.mcp['existing-server']!.type).toBe('local');
    expect(written.mcp['existing-server']!.command).toBe('npx');
    expect(written.mcp['existing-server']!.env).toEqual({ KEY: 'val' });

    // conductor added
    expect(written.mcp['mcp-conductor']).toBeDefined();
    expect(written.mcp['mcp-conductor']!.type).toBe('local');

    // top-level key preserved
    expect(written.theme).toBe('light');

    // backup written (copyFileSync called once for the existing file)
    expect(mockCopyFileSync).toHaveBeenCalledOnce();
  });
});
