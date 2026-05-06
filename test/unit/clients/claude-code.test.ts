/**
 * Unit tests for src/cli/clients/claude-code.ts (MC2)
 *
 * Covers:
 * - parse() returns NormalisedClientConfig from a valid file
 * - parse() returns null for a missing file
 * - serialize() with keepOnlyConductor writes only the conductor entry
 * - serialize() without keepOnlyConductor preserves other servers + non-MCP keys
 * - serialize() writes a .bak.YYYYMMDDHHMMSS backup before overwriting
 * - round-trip: parse then serialize produces a consistent file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import adapter — side-effect registers it in ADAPTERS.
import { CLAUDE_CODE_ADAPTER } from '../../../src/cli/clients/claude-code.js';
import { ADAPTERS } from '../../../src/cli/clients/index.js';
import type { NormalisedServerEntry } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'npx',
  args: ['@darkiceinteractive/mcp-conductor'],
};

const SAMPLE_CONFIG = {
  apiKeyHelper: '/usr/local/bin/get-key',
  mcpServers: {
    'my-server': {
      command: 'node',
      args: ['/path/to/server.js'],
      env: { MY_VAR: 'value' },
    },
    'other-server': {
      command: 'python3',
      args: ['-m', 'my_mcp'],
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeTmp(name: string, content: object): string {
  const p = join(tmpDir, name);
  writeFileSync(p, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  return p;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

function findBackups(originalPath: string): string[] {
  const base = originalPath.split('/').pop()!;
  return readdirSync(tmpDir)
    .filter((f) => f.startsWith(base + '.bak.'))
    .map((f) => join(tmpDir, f));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cc-adapter-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLAUDE_CODE_ADAPTER', () => {
  it('is registered in ADAPTERS under "claude-code"', () => {
    expect(ADAPTERS.get('claude-code')).toBe(CLAUDE_CODE_ADAPTER);
  });

  // -------------------------------------------------------------------------
  // parse()
  // -------------------------------------------------------------------------

  describe('parse()', () => {
    it('returns NormalisedClientConfig for a valid settings file', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);

      const result = CLAUDE_CODE_ADAPTER.parse(p);

      expect(result).not.toBeNull();
      expect(result!.servers['my-server']).toEqual({
        command: 'node',
        args: ['/path/to/server.js'],
        env: { MY_VAR: 'value' },
      });
      expect(result!.servers['other-server']).toEqual({
        command: 'python3',
        args: ['-m', 'my_mcp'],
      });
      // raw must carry non-MCP keys through
      expect((result!.raw as Record<string, unknown>)['apiKeyHelper']).toBe('/usr/local/bin/get-key');
    });

    it('returns null when the file does not exist', () => {
      const result = CLAUDE_CODE_ADAPTER.parse(join(tmpDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('returns null when the file has no mcpServers key', () => {
      const p = writeTmp('empty.json', { apiKeyHelper: '/usr/bin/get-key' });
      expect(CLAUDE_CODE_ADAPTER.parse(p)).toBeNull();
    });

    it('returns null when mcpServers is an empty object', () => {
      const p = writeTmp('no-servers.json', { mcpServers: {} });
      expect(CLAUDE_CODE_ADAPTER.parse(p)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // serialize() — keepOnlyConductor: true
  // -------------------------------------------------------------------------

  describe('serialize() — keepOnlyConductor: true', () => {
    it('replaces mcpServers with only the conductor entry', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(p)!;

      CLAUDE_CODE_ADAPTER.serialize(p, config, {
        keepOnlyConductor: true,
        conductorEntry: CONDUCTOR_ENTRY,
      });

      const written = readJson(p);
      const servers = written['mcpServers'] as Record<string, unknown>;
      expect(Object.keys(servers)).toEqual(['mcp-conductor']);
      expect(servers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
    });

    it('preserves non-mcpServers keys from raw', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(p)!;

      CLAUDE_CODE_ADAPTER.serialize(p, config, {
        keepOnlyConductor: true,
        conductorEntry: CONDUCTOR_ENTRY,
      });

      const written = readJson(p);
      expect(written['apiKeyHelper']).toBe('/usr/local/bin/get-key');
    });
  });

  // -------------------------------------------------------------------------
  // serialize() — keepOnlyConductor: false / omitted
  // -------------------------------------------------------------------------

  describe('serialize() — keepOnlyConductor omitted', () => {
    it('writes all servers and adds the conductor entry', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(p)!;

      CLAUDE_CODE_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

      const written = readJson(p);
      const servers = written['mcpServers'] as Record<string, unknown>;
      expect(servers).toHaveProperty('my-server');
      expect(servers).toHaveProperty('other-server');
      expect(servers).toHaveProperty('mcp-conductor');
      expect(servers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
    });

    it('preserves non-mcpServers keys from raw', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(p)!;

      CLAUDE_CODE_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

      const written = readJson(p);
      expect(written['apiKeyHelper']).toBe('/usr/local/bin/get-key');
    });
  });

  // -------------------------------------------------------------------------
  // Backup behaviour
  // -------------------------------------------------------------------------

  describe('backup behaviour', () => {
    it('creates a .bak.YYYYMMDDHHMMSS file before overwriting an existing file', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(p)!;

      CLAUDE_CODE_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

      const backups = findBackups(p);
      expect(backups.length).toBe(1);
      expect(backups[0]).toMatch(/\.bak\.\d{14}(\.[0-9a-f]{4})?$/);
    });

    it('does NOT create a backup when the target file does not yet exist', () => {
      const sourcePath = writeTmp('source.json', SAMPLE_CONFIG);
      const config = CLAUDE_CODE_ADAPTER.parse(sourcePath)!;

      const newPath = join(tmpDir, 'brand-new.json');
      expect(existsSync(newPath)).toBe(false);

      CLAUDE_CODE_ADAPTER.serialize(newPath, config, { conductorEntry: CONDUCTOR_ENTRY });

      expect(existsSync(newPath)).toBe(true);
      const backups = findBackups(newPath);
      expect(backups.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('parse → serialize → parse yields the same server map plus conductor', () => {
      const p = writeTmp('settings.json', SAMPLE_CONFIG);

      const before = CLAUDE_CODE_ADAPTER.parse(p)!;
      CLAUDE_CODE_ADAPTER.serialize(p, before, { conductorEntry: CONDUCTOR_ENTRY });
      const after = CLAUDE_CODE_ADAPTER.parse(p)!;

      expect(after.servers['my-server']).toEqual(before.servers['my-server']);
      expect(after.servers['other-server']).toEqual(before.servers['other-server']);
      expect(after.servers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
    });
  });
});
