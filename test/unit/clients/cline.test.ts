/**
 * Unit tests for src/cli/clients/cline.ts (MC2-cline)
 *
 * Covers:
 * 1. parse() returns null for missing file
 * 2. parse() returns null for malformed JSON
 * 3. parse() returns null when mcpServers is absent / empty
 * 4. parse() correctly normalises a valid config
 * 5. serialize() writes merged config and creates a .bak backup
 * 6. serialize() with keepOnlyConductor strips all servers except conductor
 * 7. serialize() preserves non-mcpServers keys from original config
 * 8. serialize() creates parent directories when file does not yet exist
 * 9. Deep VS Code globalStorage path round-trip via temp dir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLINE_ADAPTER } from '../../../src/cli/clients/cline.js';
import type { NormalisedClientConfig } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `cline-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, filename: string, data: unknown): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

function findBackups(filePath: string): string[] {
  const dir = join(filePath, '..');
  const base = filePath.split('/').pop()!;
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`));
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CONDUCTOR_ENTRY = {
  command: 'node',
  args: ['/path/to/conductor/dist/index.js'],
  env: { PORT: '3000' },
};

const VALID_CONFIG = {
  mcpServers: {
    'github-mcp': {
      command: 'uvx',
      args: ['mcp-server-github'],
      env: { GITHUB_TOKEN: 'ghp_REDACTED' },
    },
    'filesystem-mcp': {
      command: 'node',
      args: ['/home/user/.mcp/filesystem/index.js'],
    },
  },
};

// ---------------------------------------------------------------------------
// parse() tests
// ---------------------------------------------------------------------------

describe('CLINE_ADAPTER.parse()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    const result = CLINE_ADAPTER.parse(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null when the file contains malformed JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{ not valid json', 'utf-8');
    expect(CLINE_ADAPTER.parse(path)).toBeNull();
  });

  it('returns null when mcpServers is absent or empty', () => {
    const noKey = writeFixture(tmpDir, 'no-key.json', { someOtherKey: true });
    expect(CLINE_ADAPTER.parse(noKey)).toBeNull();

    const emptyKey = writeFixture(tmpDir, 'empty-key.json', { mcpServers: {} });
    expect(CLINE_ADAPTER.parse(emptyKey)).toBeNull();
  });

  it('correctly normalises a valid config with two servers', () => {
    const path = writeFixture(tmpDir, 'cline_mcp_settings.json', VALID_CONFIG);
    const result = CLINE_ADAPTER.parse(path);

    expect(result).not.toBeNull();
    expect(Object.keys(result!.servers)).toHaveLength(2);

    // github-mcp: command + args + env
    expect(result!.servers['github-mcp']).toEqual({
      command: 'uvx',
      args: ['mcp-server-github'],
      env: { GITHUB_TOKEN: 'ghp_REDACTED' },
    });

    // filesystem-mcp: command + args only — env must not be present
    expect(result!.servers['filesystem-mcp']).toEqual({
      command: 'node',
      args: ['/home/user/.mcp/filesystem/index.js'],
    });
    expect(result!.servers['filesystem-mcp']!.env).toBeUndefined();

    // raw round-trips the original parsed object
    expect(result!.raw).toEqual(VALID_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// serialize() tests
// ---------------------------------------------------------------------------

describe('CLINE_ADAPTER.serialize()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes merged config and creates a .bak.YYYYMMDDHHMMSS backup', () => {
    const path = writeFixture(tmpDir, 'cline_mcp_settings.json', VALID_CONFIG);
    const parsed = CLINE_ADAPTER.parse(path)!;

    CLINE_ADAPTER.serialize(path, parsed, { conductorEntry: CONDUCTOR_ENTRY });

    // Exactly one backup must exist with the correct timestamp suffix format.
    const backups = findBackups(path);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/\.bak\.\d{14}$/);

    // Written file contains original servers AND the conductor.
    const written = JSON.parse(readFileSync(path, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers).toHaveProperty('github-mcp');
    expect(written.mcpServers).toHaveProperty('filesystem-mcp');
    expect(written.mcpServers).toHaveProperty('mcp-conductor');
    expect(written.mcpServers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
  });

  it('keepOnlyConductor removes all servers except mcp-conductor', () => {
    const path = writeFixture(tmpDir, 'cline_mcp_settings.json', VALID_CONFIG);
    const parsed = CLINE_ADAPTER.parse(path)!;

    CLINE_ADAPTER.serialize(path, parsed, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = JSON.parse(readFileSync(path, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(['mcp-conductor']);
    expect(written.mcpServers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
  });

  it('preserves non-mcpServers keys from the original config', () => {
    const configWithExtra = {
      someExtensionKey: 'preserved',
      anotherKey: { nested: true },
      mcpServers: {
        'my-server': { command: 'node', args: ['index.js'] },
      },
    };
    const path = writeFixture(tmpDir, 'cline_mcp_settings.json', configWithExtra);
    const parsed = CLINE_ADAPTER.parse(path)!;

    CLINE_ADAPTER.serialize(path, parsed, { conductorEntry: CONDUCTOR_ENTRY });

    const written = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(written['someExtensionKey']).toBe('preserved');
    expect(written['anotherKey']).toEqual({ nested: true });
  });

  it('creates parent directories when the settings file does not yet exist', () => {
    const deepDir = join(
      tmpDir,
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
    );
    const path = join(deepDir, 'cline_mcp_settings.json');

    expect(existsSync(deepDir)).toBe(false);

    const emptyConfig: NormalisedClientConfig = { servers: {}, raw: {} };
    CLINE_ADAPTER.serialize(path, emptyConfig, { conductorEntry: CONDUCTOR_ENTRY });

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers).toHaveProperty('mcp-conductor');
  });
});

// ---------------------------------------------------------------------------
// Deep VS Code globalStorage path round-trip
// ---------------------------------------------------------------------------

describe('CLINE_ADAPTER — VS Code globalStorage path round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves and round-trips the deep globalStorage directory structure', () => {
    // Replicate the exact VS Code extension storage path under tmpDir so the
    // test exercises the real directory-creation and file-write path without
    // touching the developer's actual Cline installation.
    const globalStoragePath = join(
      tmpDir,
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );

    // Path must contain the stable extension-ID segment.
    expect(globalStoragePath).toContain('saoudrizwan.claude-dev');
    expect(globalStoragePath).toContain('cline_mcp_settings.json');

    // First write: directory tree does not exist yet.
    const initialConfig: NormalisedClientConfig = {
      servers: {
        'test-server': { command: 'node', args: ['test.js'] },
      },
      raw: {
        mcpServers: { 'test-server': { command: 'node', args: ['test.js'] } },
      },
    };
    CLINE_ADAPTER.serialize(globalStoragePath, initialConfig, {
      conductorEntry: CONDUCTOR_ENTRY,
    });

    expect(existsSync(globalStoragePath)).toBe(true);

    // Round-trip: parse the written file and verify all servers are present.
    const reparsed = CLINE_ADAPTER.parse(globalStoragePath);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.servers).toHaveProperty('test-server');
    expect(reparsed!.servers).toHaveProperty('mcp-conductor');
    expect(reparsed!.servers['mcp-conductor']).toEqual(CONDUCTOR_ENTRY);
  });
});
