/**
 * Unit tests for src/cli/clients/codex.ts (MC2-codex)
 *
 * Covers:
 * 1. parse() — env_vars plain-string values → normalised env
 * 2. parse() — remote-source env_vars emits warning and drops the entry
 * 3. parse() — missing file returns null
 * 4. env_vars translation correctness — mixed plain + remote in one server
 * 5. serialize() — round-trip: write then parse produces equivalent config
 * 6. serialize() — keepOnlyConductor removes all other servers
 * 7. serialize() — preserves other top-level TOML keys from config.raw
 * 8. serialize() — backup file written before overwriting an existing file
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { CODEX_ADAPTER } from '../../../src/cli/clients/codex.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `codex-test-${nanoid(8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTOML(dir: string, filename: string, content: string): string {
  const p = join(dir, filename);
  writeFileSync(p, content, 'utf-8');
  return p;
}

const CONDUCTOR_ENTRY = {
  command: 'npx',
  args: ['-y', '@darkiceinteractive/mcp-conductor'],
  env: {} as Record<string, string>,
};

// ---------------------------------------------------------------------------
// parse() tests
// ---------------------------------------------------------------------------

describe('CODEX_ADAPTER.parse()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1
  it('normalises plain env_vars string values into the env map', () => {
    const dir = tmpDir();
    const toml = [
      '[mcp_servers.my-server]',
      'command = "node"',
      'args = ["server.js"]',
      '',
      '[mcp_servers.my-server.env_vars]',
      'API_KEY = "secret-value"',
      'BASE_URL = "https://example.com"',
    ].join('\n');
    const path = writeTOML(dir, 'config.toml', toml);

    const result = CODEX_ADAPTER.parse(path);

    expect(result).not.toBeNull();
    const server = result!.servers['my-server'];
    expect(server).toBeDefined();
    expect(server!.command).toBe('node');
    expect(server!.args).toEqual(['server.js']);
    expect(server!.env).toEqual({
      API_KEY: 'secret-value',
      BASE_URL: 'https://example.com',
    });
  });

  // Test 2
  it('drops remote-source env_vars and emits a console.warn', () => {
    const dir = tmpDir();
    const toml = [
      '[mcp_servers.remote-server]',
      'command = "uvx"',
      'args = ["mcp-server"]',
      '',
      '[mcp_servers.remote-server.env_vars.MY_TOKEN]',
      'name = "MY_TOKEN"',
      'source = "remote"',
    ].join('\n');
    const path = writeTOML(dir, 'config.toml', toml);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = CODEX_ADAPTER.parse(path);

    expect(result).not.toBeNull();
    const server = result!.servers['remote-server'];
    expect(server).toBeDefined();
    // env should be absent — no plain values survived
    expect(server!.env).toBeUndefined();
    // Warning must reference source="remote"
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('source="remote"'));
  });

  // Test 3
  it('returns null for a non-existent file', () => {
    const result = CODEX_ADAPTER.parse('/tmp/definitely-does-not-exist-xyzzy/config.toml');
    expect(result).toBeNull();
  });

  // Test 4
  it('correctly translates mixed plain and remote env_vars: keeps plain, drops remote', () => {
    const dir = tmpDir();
    const toml = [
      '[mcp_servers.mixed]',
      'command = "deno"',
      '',
      '[mcp_servers.mixed.env_vars]',
      'KEY1 = "kept-value"',
      '',
      '[mcp_servers.mixed.env_vars.KEY2]',
      'name = "KEY2"',
      'source = "remote"',
    ].join('\n');
    const path = writeTOML(dir, 'config.toml', toml);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = CODEX_ADAPTER.parse(path);
    warnSpy.mockRestore();

    expect(result).not.toBeNull();
    expect(result!.servers['mixed']!.env).toEqual({ KEY1: 'kept-value' });
  });
});

// ---------------------------------------------------------------------------
// serialize() tests
// ---------------------------------------------------------------------------

describe('CODEX_ADAPTER.serialize()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 5
  it('round-trips: serialize then parse produces an equivalent config', () => {
    const dir = tmpDir();
    const path = join(dir, 'config.toml');

    const config = {
      servers: {
        'my-server': { command: 'node', args: ['s.js'], env: { TOKEN: 'abc' } },
      },
      raw: {},
    };

    CODEX_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });
    expect(existsSync(path)).toBe(true);

    const reparsed = CODEX_ADAPTER.parse(path);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.servers['my-server']!.command).toBe('node');
    expect(reparsed!.servers['my-server']!.args).toEqual(['s.js']);
    expect(reparsed!.servers['my-server']!.env).toEqual({ TOKEN: 'abc' });
    // conductor entry must be present
    expect(reparsed!.servers['mcp-conductor']!.command).toBe('npx');
    expect(reparsed!.servers['mcp-conductor']!.args).toEqual(['-y', '@darkiceinteractive/mcp-conductor']);
  });

  // Test 6
  it('keepOnlyConductor: writes only the mcp-conductor server', () => {
    const dir = tmpDir();
    const path = join(dir, 'config.toml');

    const config = {
      servers: {
        'other-server': { command: 'python', args: ['-m', 'server'] },
        'another-server': { command: 'deno', args: ['run', 'mod.ts'] },
      },
      raw: {},
    };

    CODEX_ADAPTER.serialize(path, config, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const reparsed = CODEX_ADAPTER.parse(path);
    expect(reparsed).not.toBeNull();
    const serverNames = Object.keys(reparsed!.servers);
    expect(serverNames).toEqual(['mcp-conductor']);
  });

  // Test 7
  it('preserves non-mcp_servers top-level TOML keys from config.raw', () => {
    const dir = tmpDir();
    const path = join(dir, 'config.toml');

    const config = {
      servers: {},
      raw: {
        model: 'o4-mini',
        approval_policy: 'on-failure',
        // mcp_servers key in raw is intentionally overwritten by the serialiser
        mcp_servers: {},
      },
    };

    CODEX_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('model');
    expect(content).toContain('o4-mini');
    expect(content).toContain('approval_policy');
    expect(content).toContain('on-failure');
  });

  // Test 8
  it('writes a .bak.YYYYMMDDHHMMSS backup before overwriting an existing file', () => {
    const dir = tmpDir();
    const path = writeTOML(dir, 'config.toml', '[mcp_servers.old]\ncommand = "old"\n');

    CODEX_ADAPTER.serialize(path, { servers: {}, raw: {} }, { conductorEntry: CONDUCTOR_ENTRY });

    const files = readdirSync(dir);
    const backups = files.filter((f) => f.includes('.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // Backup file must follow the YYYYMMDDHHMMSS (14-digit) timestamp pattern
    expect(backups[0]).toMatch(/config\.toml\.bak\.\d{14}/);
  });
});
