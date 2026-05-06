/**
 * Unit tests for src/cli/clients/claude-desktop.ts (MC2)
 *
 * Verifies:
 * 1. parse() returns NormalisedClientConfig when the file is valid JSON with mcpServers.
 * 2. parse() returns null when the file does not exist (missing-file).
 * 3. serialize() with keepOnlyConductor:true writes only the mcp-conductor entry.
 * 4. serialize() without keepOnlyConductor preserves existing servers and other top-level keys.
 * 5. serialize() writes a .bak.YYYYMMDDHHMMSS backup before overwriting an existing file.
 * 6. Round-trip: parse → serialize → parse produces a consistent, correct result.
 * 7. ADAPTERS map contains the claude-desktop adapter after module import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLAUDE_DESKTOP_ADAPTER } from '../../../src/cli/clients/claude-desktop.js';
import { ADAPTERS } from '../../../src/cli/clients/index.js';
import type { NormalisedServerEntry } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `mcp-cd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(filePath: string, content: unknown): void {
  writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
}

function readConfig(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'node',
  args: ['/usr/local/lib/mcp-conductor/dist/index.js'],
  env: { LOG_LEVEL: 'info' },
};

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — parse(): valid file with mcpServers
// ---------------------------------------------------------------------------

describe('CLAUDE_DESKTOP_ADAPTER.parse()', () => {
  it('returns NormalisedClientConfig for a valid config file', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, {
      mcpServers: {
        'my-server': { command: 'uvx', args: ['my-pkg'], env: { TOKEN: 'abc' } },
        'bare-server': { command: 'node' },
      },
      someOtherKey: 'preserved',
    });

    const result = CLAUDE_DESKTOP_ADAPTER.parse(configPath);

    expect(result).not.toBeNull();
    expect(result!.servers['my-server']).toEqual({
      command: 'uvx',
      args: ['my-pkg'],
      env: { TOKEN: 'abc' },
    });
    expect(result!.servers['bare-server']).toEqual({ command: 'node' });
    // raw must carry the full original object including non-MCP keys
    expect((result!.raw as Record<string, unknown>)['someOtherKey']).toBe('preserved');
  });

  // -------------------------------------------------------------------------
  // Test 2 — parse(): missing file
  // -------------------------------------------------------------------------

  it('returns null when the file does not exist', () => {
    const result = CLAUDE_DESKTOP_ADAPTER.parse(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null when mcpServers key is absent', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, { someOtherKey: 'value' });

    const result = CLAUDE_DESKTOP_ADAPTER.parse(configPath);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeFileSync(configPath, '{ not valid json }', 'utf-8');

    const result = CLAUDE_DESKTOP_ADAPTER.parse(configPath);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — serialize(): keepOnlyConductor: true
// ---------------------------------------------------------------------------

describe('CLAUDE_DESKTOP_ADAPTER.serialize() — keepOnlyConductor', () => {
  it('writes only mcp-conductor to mcpServers when keepOnlyConductor is true', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, {
      mcpServers: {
        'old-server': { command: 'python', args: ['-m', 'old'] },
        'another': { command: 'node' },
      },
    });

    const parsed = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    CLAUDE_DESKTOP_ADAPTER.serialize(configPath, parsed, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = readConfig(configPath);
    const mcpServers = written['mcpServers'] as Record<string, unknown>;

    expect(Object.keys(mcpServers)).toEqual(['mcp-conductor']);
    expect(mcpServers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
  });

  // -------------------------------------------------------------------------
  // Test 4 — serialize(): preserves other keys and existing servers
  // -------------------------------------------------------------------------

  it('preserves non-mcpServers top-level keys when keepOnlyConductor is false', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, {
      mcpServers: { 'github': { command: 'uvx', args: ['mcp-server-github'] } },
      themeMode: 'dark',
      analyticsEnabled: false,
      nestedConfig: { fontSize: 14 },
    });

    const parsed = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    CLAUDE_DESKTOP_ADAPTER.serialize(configPath, parsed, {
      keepOnlyConductor: false,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = readConfig(configPath);
    expect(written['themeMode']).toBe('dark');
    expect(written['analyticsEnabled']).toBe(false);
    expect(written['nestedConfig']).toEqual({ fontSize: 14 });

    const mcpServers = written['mcpServers'] as Record<string, unknown>;
    expect(mcpServers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
    expect(mcpServers['github']).toEqual({ command: 'uvx', args: ['mcp-server-github'] });
  });

  it('conductorEntry always wins when a server named mcp-conductor already exists', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, {
      mcpServers: {
        'mcp-conductor': { command: 'old', args: ['stale'] },
      },
    });

    const parsed = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    CLAUDE_DESKTOP_ADAPTER.serialize(configPath, parsed, {
      keepOnlyConductor: false,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = readConfig(configPath);
    const mcpServers = written['mcpServers'] as Record<string, unknown>;
    expect(mcpServers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — serialize(): backup behaviour
// ---------------------------------------------------------------------------

describe('CLAUDE_DESKTOP_ADAPTER.serialize() — backup', () => {
  it('writes a .bak.YYYYMMDDHHMMSS backup file before overwriting', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, { mcpServers: { 'server-a': { command: 'node' } } });

    const parsed = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    CLAUDE_DESKTOP_ADAPTER.serialize(configPath, parsed, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const files = readdirSync(tmpDir);
    const backups = files.filter((f) => /^claude_desktop_config\.json\.bak\.\d{14}/.test(f));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('does not write a backup when the file did not previously exist', () => {
    const configPath = join(tmpDir, 'new_config.json');
    // File does not exist yet — serialize should write without backup.
    CLAUDE_DESKTOP_ADAPTER.serialize(
      configPath,
      { servers: {}, raw: {} },
      { keepOnlyConductor: true, conductorEntry: CONDUCTOR_ENTRY },
    );

    expect(existsSync(configPath)).toBe(true);
    const files = readdirSync(tmpDir);
    const backups = files.filter((f) => f.includes('.bak.'));
    expect(backups.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Round-trip
// ---------------------------------------------------------------------------

describe('CLAUDE_DESKTOP_ADAPTER round-trip', () => {
  it('parse → serialize → parse produces consistent mcpServers', () => {
    const configPath = join(tmpDir, 'claude_desktop_config.json');
    writeConfig(configPath, {
      mcpServers: {
        'filesystem': { command: 'uvx', args: ['mcp-server-filesystem', '/home'] },
        'slack': {
          command: 'node',
          args: ['/opt/slack-mcp/index.js'],
          env: { SLACK_TOKEN: 'xoxb-test' },
        },
      },
      userPrefs: { theme: 'light' },
    });

    // First parse
    const first = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    expect(Object.keys(first.servers).sort()).toEqual(['filesystem', 'slack']);

    // Serialize (add conductor, keep rest)
    CLAUDE_DESKTOP_ADAPTER.serialize(configPath, first, {
      keepOnlyConductor: false,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    // Second parse — must include all three servers and preserved key
    const second = CLAUDE_DESKTOP_ADAPTER.parse(configPath)!;
    expect(second.servers['filesystem']).toEqual({
      command: 'uvx',
      args: ['mcp-server-filesystem', '/home'],
    });
    expect(second.servers['slack']).toEqual({
      command: 'node',
      args: ['/opt/slack-mcp/index.js'],
      env: { SLACK_TOKEN: 'xoxb-test' },
    });
    expect(second.servers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
    expect((second.raw as Record<string, unknown>)['userPrefs']).toEqual({ theme: 'light' });
  });
});

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

describe('ADAPTERS auto-registration', () => {
  it('ADAPTERS map contains claude-desktop after importing the module', () => {
    expect(ADAPTERS.has('claude-desktop')).toBe(true);
    expect(ADAPTERS.get('claude-desktop')).toBe(CLAUDE_DESKTOP_ADAPTER);
  });

  it('CLAUDE_DESKTOP_ADAPTER.client matches the MCPClientId', () => {
    expect(CLAUDE_DESKTOP_ADAPTER.client).toBe('claude-desktop');
  });
});
