/**
 * Unit tests for MC4 exportForClient().
 *
 * Verifies that exportForClient() writes the correct native format for:
 * - codex    (TOML, mcp_servers table)
 * - zed      (JSON, context_servers with source:"custom")
 * - opencode (JSON, mcp key with type:"local")
 * - claude-desktop (JSON, mcpServers key — the default/backwards-compat path)
 *
 * Also verifies:
 * - deriveExportFilename() returns the correct extension per client
 * - listExportableClients() returns all 10 known clients
 * - outputPath override is respected
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';

import {
  exportForClient,
  deriveExportFilename,
  listExportableClients,
} from '../../../src/cli/commands/export-servers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'export-per-client-test-'));
}

// ---------------------------------------------------------------------------
// deriveExportFilename()
// ---------------------------------------------------------------------------

describe('deriveExportFilename()', () => {
  it('returns .toml for codex', () => {
    expect(deriveExportFilename('codex')).toBe('codex-config.toml');
  });

  it('returns .yaml for continue', () => {
    expect(deriveExportFilename('continue')).toBe('continue-config.yaml');
  });

  it('returns .json for all other clients', () => {
    const jsonClients = [
      'claude-desktop', 'claude-code', 'gemini-cli', 'cursor',
      'cline', 'zed', 'opencode', 'kimi-code',
    ] as const;
    for (const c of jsonClients) {
      const name = deriveExportFilename(c);
      expect(name).toMatch(/\.json$/);
      expect(name).toContain(c);
    }
  });
});

// ---------------------------------------------------------------------------
// listExportableClients()
// ---------------------------------------------------------------------------

describe('listExportableClients()', () => {
  it('returns all 10 known client IDs', () => {
    const clients = listExportableClients();
    expect(clients).toHaveLength(10);
    const expected = [
      'claude-desktop', 'claude-code', 'codex', 'gemini-cli',
      'cursor', 'cline', 'zed', 'continue', 'opencode', 'kimi-code',
    ];
    for (const id of expected) {
      expect(clients).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// exportForClient() — codex (TOML with mcp_servers table)
// ---------------------------------------------------------------------------

describe('exportForClient() — codex', () => {
  let tmp: string;

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes a TOML file containing [mcp_servers.mcp-conductor]', () => {
    tmp = makeTmp();
    const result = exportForClient({ clientId: 'codex', outputDir: tmp });

    expect(result.clientId).toBe('codex');
    expect(result.outputPath).toMatch(/\.toml$/);
    expect(existsSync(result.outputPath)).toBe(true);

    const content = readFileSync(result.outputPath, 'utf-8');
    const parsed = TOML.parse(content) as Record<string, unknown>;

    expect(parsed['mcp_servers']).toBeDefined();
    const servers = parsed['mcp_servers'] as Record<string, Record<string, unknown>>;
    expect(servers['mcp-conductor']).toBeDefined();
    expect(servers['mcp-conductor']!['command']).toBe('npx');
    const args = servers['mcp-conductor']!['args'] as string[];
    expect(args).toContain('-y');
    expect(args).toContain('@darkiceinteractive/mcp-conductor@latest');
  });
});

// ---------------------------------------------------------------------------
// exportForClient() — zed (JSON with context_servers + source:"custom")
// ---------------------------------------------------------------------------

describe('exportForClient() — zed', () => {
  let tmp: string;

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes a JSON file with context_servers and source:"custom"', () => {
    tmp = makeTmp();
    const result = exportForClient({ clientId: 'zed', outputDir: tmp });

    expect(result.clientId).toBe('zed');
    expect(result.outputPath).toMatch(/\.json$/);
    expect(existsSync(result.outputPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.outputPath, 'utf-8')) as Record<string, unknown>;

    // Zed uses context_servers, NOT mcpServers
    expect(parsed['context_servers']).toBeDefined();
    expect(parsed['mcpServers']).toBeUndefined();

    const cs = parsed['context_servers'] as Record<string, Record<string, unknown>>;
    expect(cs['mcp-conductor']).toBeDefined();
    expect(cs['mcp-conductor']!['source']).toBe('custom');
    expect(cs['mcp-conductor']!['command']).toBe('npx');
  });
});

// ---------------------------------------------------------------------------
// exportForClient() — opencode (JSON with mcp key + type:"local")
// ---------------------------------------------------------------------------

describe('exportForClient() — opencode', () => {
  let tmp: string;

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes a JSON file with mcp key and type:"local"', () => {
    tmp = makeTmp();
    const result = exportForClient({ clientId: 'opencode', outputDir: tmp });

    expect(result.clientId).toBe('opencode');
    expect(result.outputPath).toMatch(/\.json$/);
    expect(existsSync(result.outputPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.outputPath, 'utf-8')) as Record<string, unknown>;

    // OpenCode uses 'mcp', NOT 'mcpServers'
    expect(parsed['mcp']).toBeDefined();
    expect(parsed['mcpServers']).toBeUndefined();

    const mcp = parsed['mcp'] as Record<string, Record<string, unknown>>;
    expect(mcp['mcp-conductor']).toBeDefined();
    expect(mcp['mcp-conductor']!['type']).toBe('local');
    expect(mcp['mcp-conductor']!['command']).toBe('npx');
  });
});

// ---------------------------------------------------------------------------
// exportForClient() — claude-desktop (default / backwards compat)
// ---------------------------------------------------------------------------

describe('exportForClient() — claude-desktop (default)', () => {
  let tmp: string;

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes a JSON file with mcpServers key when clientId=claude-desktop', () => {
    tmp = makeTmp();
    const result = exportForClient({ clientId: 'claude-desktop', outputDir: tmp });

    expect(result.clientId).toBe('claude-desktop');
    expect(existsSync(result.outputPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.outputPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed['mcpServers']).toBeDefined();
    const servers = parsed['mcpServers'] as Record<string, Record<string, unknown>>;
    expect(servers['mcp-conductor']).toBeDefined();
    expect(servers['mcp-conductor']!['command']).toBe('npx');
  });

  it('defaults to claude-desktop when clientId is omitted', () => {
    tmp = makeTmp();
    const result = exportForClient({ outputDir: tmp });
    expect(result.clientId).toBe('claude-desktop');
  });

  it('writes to the exact outputPath when provided', () => {
    tmp = makeTmp();
    const exactPath = join(tmp, 'custom-output.json');
    const result = exportForClient({ clientId: 'claude-desktop', outputPath: exactPath });
    expect(result.outputPath).toBe(exactPath);
    expect(existsSync(exactPath)).toBe(true);
  });
});
