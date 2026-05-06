/**
 * Unit tests for src/cli/clients/kimi-code.ts (MC2 — kimi-code adapter)
 *
 * Verifies:
 * - parse(): stdio entries normalised correctly
 * - parse(): HTTP entries skipped with a logged warning
 * - parse(): missing file returns null
 * - parse(): file with no mcpServers returns null
 * - serialize(): keepOnlyConductor removes all servers except conductor
 * - serialize(): preserves other top-level keys
 * - serialize(): backup file is written (.bak.YYYYMMDDHHMMSS)
 * - round-trip: parse() → serialize() → parse() produces equivalent output
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIMI_CODE_ADAPTER } from '../../../src/cli/clients/kimi-code.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-code-test-'));
}

function writeJson(filePath: string, obj: unknown): void {
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

const CONDUCTOR_ENTRY = {
  command: 'npx',
  args: ['@darkiceinteractive/mcp-conductor'],
  env: {} as Record<string, string>,
};

// ---------------------------------------------------------------------------
// parse() tests
// ---------------------------------------------------------------------------

describe('KIMI_CODE_ADAPTER.parse()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('missing-file: returns null when file does not exist', () => {
    const result = KIMI_CODE_ADAPTER.parse(join(dir, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  it('returns null when mcpServers key is absent', () => {
    const p = join(dir, 'config.json');
    writeJson(p, { someOtherKey: true });
    expect(KIMI_CODE_ADAPTER.parse(p)).toBeNull();
  });

  it('returns null when mcpServers is present but empty', () => {
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: {} });
    expect(KIMI_CODE_ADAPTER.parse(p)).toBeNull();
  });

  it('normalises a stdio entry into NormalisedServerEntry shape', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' } },
      },
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.servers['my-server']).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'abc' },
    });
  });

  it('defaults args and env to empty collections when omitted from stdio entry', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: { 'bare-server': { command: 'uvx' } },
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p);
    expect(cfg!.servers['bare-server']).toEqual({ command: 'uvx', args: [], env: {} });
  });

  it('HTTP-entry-skipped: skips HTTP entries and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'error'); // logger writes to stderr via console.error
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: {
        'http-server': { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer tok' } },
        'stdio-server': { command: 'node', args: [] },
      },
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p);
    expect(cfg).not.toBeNull();
    // HTTP server must not appear in normalised servers
    expect(Object.keys(cfg!.servers)).not.toContain('http-server');
    // Stdio server must be present
    expect(Object.keys(cfg!.servers)).toContain('stdio-server');
    // At least one warn-level message must mention HTTP
    const allOutput = warnSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/skipping HTTP entry/i);
    warnSpy.mockRestore();
  });

  it('preserves raw config object for subsequent round-trip writes', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: { 'srv': { command: 'node', args: ['srv.js'] } },
      customSetting: 'keep-me',
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p);
    expect((cfg!.raw as Record<string, unknown>)['customSetting']).toBe('keep-me');
  });
});

// ---------------------------------------------------------------------------
// serialize() tests
// ---------------------------------------------------------------------------

describe('KIMI_CODE_ADAPTER.serialize()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('backup-written: writes a .bak.YYYYMMDDHHMMSS file before overwriting', () => {
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: { 'srv': { command: 'node' } } });
    const cfg = KIMI_CODE_ADAPTER.parse(p)!;

    KIMI_CODE_ADAPTER.serialize(p, cfg, { conductorEntry: CONDUCTOR_ENTRY });

    const files = readdirSync(dir);
    const backups = files.filter((f) => /\.bak\.\d{14}/.test(f));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^config\.json\.bak\.\d{14}/);
  });

  it('preserves-other-keys: non-mcpServers top-level keys survive the write', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: { 'srv': { command: 'node' } },
      extraKey: 'preserved',
      nestedConfig: { foo: 42 },
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p)!;
    KIMI_CODE_ADAPTER.serialize(p, cfg, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readJson(p) as Record<string, unknown>;
    expect(written['extraKey']).toBe('preserved');
    expect((written['nestedConfig'] as Record<string, unknown>)['foo']).toBe(42);
  });

  it('upserts the conductor entry under the "mcp-conductor" key', () => {
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: { 'srv': { command: 'node' } } });
    const cfg = KIMI_CODE_ADAPTER.parse(p)!;
    KIMI_CODE_ADAPTER.serialize(p, cfg, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readJson(p) as { mcpServers: Record<string, unknown> };
    const conductorEntry = written.mcpServers['mcp-conductor'] as Record<string, unknown>;
    expect(conductorEntry).toBeDefined();
    expect(conductorEntry['command']).toBe('npx');
    expect(conductorEntry['args']).toEqual(['@darkiceinteractive/mcp-conductor']);
  });

  it('keepOnlyConductor: replaces all servers with only the conductor entry', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'python', args: ['b.py'] },
        'http-srv': { url: 'https://example.com' },
      },
    });
    const cfg = KIMI_CODE_ADAPTER.parse(p)!;
    KIMI_CODE_ADAPTER.serialize(p, cfg, {
      conductorEntry: CONDUCTOR_ENTRY,
      keepOnlyConductor: true,
    });

    const written = readJson(p) as { mcpServers: Record<string, unknown> };
    const keys = Object.keys(written.mcpServers);
    expect(keys).toEqual(['mcp-conductor']);
  });

  it('round-trip: parse → serialize → parse yields equivalent servers and metadata', () => {
    const p = join(dir, 'config.json');
    writeJson(p, {
      mcpServers: {
        'alpha': { command: 'node', args: ['alpha.js'], env: { KEY: 'val' } },
        'beta': { command: 'uvx', args: ['beta'] },
      },
      meta: { version: '1' },
    });

    const first = KIMI_CODE_ADAPTER.parse(p)!;
    KIMI_CODE_ADAPTER.serialize(p, first, { conductorEntry: CONDUCTOR_ENTRY });
    const second = KIMI_CODE_ADAPTER.parse(p)!;

    // Original servers preserved
    expect(second.servers['alpha']).toEqual(first.servers['alpha']);
    expect(second.servers['beta']).toEqual(first.servers['beta']);
    // Conductor entry injected
    expect(second.servers['mcp-conductor']).toBeDefined();
    expect(second.servers['mcp-conductor']!.command).toBe('npx');
    // Non-MCP top-level key preserved
    expect((second.raw as Record<string, unknown>)['meta']).toEqual({ version: '1' });
  });
});
