/**
 * Unit tests for src/cli/clients/gemini-cli.ts  (MC2)
 *
 * Verifies:
 * 1. parse() returns null when file is missing.
 * 2. parse() returns null when JSON is malformed.
 * 3. parse() returns null when mcpServers key is absent.
 * 4. parse() correctly normalises a well-formed config.
 * 5. serialize() writes expected JSON in full (non-keepOnlyConductor) mode.
 * 6. serialize() with keepOnlyConductor=true writes only the conductor entry.
 * 7. Round-trip: `timeout` and `excludeTools` survive parse → serialize unchanged.
 * 8. serialize() creates a .bak.* backup of an existing file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GEMINI_CLI_ADAPTER } from '../../../src/cli/clients/gemini-cli.js';
import type { NormalisedServerEntry } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'npx',
  args: ['-y', '@darkiceinteractive/mcp-conductor'],
};

/** Produce a synthetic settings.json content string with optional overrides. */
function makeSettingsJson(extra?: Record<string, unknown>): string {
  const base = {
    mcpServers: {
      'test-server': {
        command: 'node',
        args: ['dist/server.js'],
        env: { API_KEY: 'redacted' },
        timeout: 30000,
        excludeTools: ['foo'],
      },
    },
    theme: 'dark',
    ...extra,
  };
  return JSON.stringify(base, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gemini-cli-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function readTmpJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// parse() tests
// ---------------------------------------------------------------------------

describe('GEMINI_CLI_ADAPTER.parse()', () => {
  it('returns null for a missing file', () => {
    const result = GEMINI_CLI_ADAPTER.parse(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const p = writeTmp('bad.json', '{ not valid json !!');
    expect(GEMINI_CLI_ADAPTER.parse(p)).toBeNull();
  });

  it('returns null when mcpServers key is absent', () => {
    const p = writeTmp('no-mcp.json', JSON.stringify({ theme: 'dark' }));
    expect(GEMINI_CLI_ADAPTER.parse(p)).toBeNull();
  });

  it('normalises a well-formed config, promoting only command/args/env', () => {
    const p = writeTmp('settings.json', makeSettingsJson());
    const result = GEMINI_CLI_ADAPTER.parse(p);

    expect(result).not.toBeNull();
    expect(result!.servers['test-server']).toMatchObject({
      command: 'node',
      args: ['dist/server.js'],
      env: { API_KEY: 'redacted' },
    });
    // Gemini-specific extras must NOT appear in the normalised entry.
    expect(
      (result!.servers['test-server'] as Record<string, unknown>)['timeout'],
    ).toBeUndefined();
    expect(
      (result!.servers['test-server'] as Record<string, unknown>)['excludeTools'],
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serialize() tests
// ---------------------------------------------------------------------------

describe('GEMINI_CLI_ADAPTER.serialize()', () => {
  it('writes expected JSON in full mode and preserves non-mcpServers top-level keys', () => {
    const p = writeTmp('settings.json', makeSettingsJson());
    const config = GEMINI_CLI_ADAPTER.parse(p)!;

    GEMINI_CLI_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readTmpJson(p);
    // Top-level non-mcpServers key preserved.
    expect(written['theme']).toBe('dark');
    // Conductor entry injected.
    const servers = written['mcpServers'] as Record<string, unknown>;
    expect(servers['mcp-conductor']).toMatchObject({ command: 'npx' });
    // Original server still present.
    expect(servers['test-server']).toBeDefined();
  });

  it('keepOnlyConductor=true writes only the conductor entry under mcpServers', () => {
    const p = writeTmp('settings.json', makeSettingsJson());
    const config = GEMINI_CLI_ADAPTER.parse(p)!;

    GEMINI_CLI_ADAPTER.serialize(p, config, {
      keepOnlyConductor: true,
      conductorEntry: CONDUCTOR_ENTRY,
    });

    const written = readTmpJson(p);
    const servers = written['mcpServers'] as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['mcp-conductor']);
    expect(servers['mcp-conductor']).toMatchObject({ command: 'npx' });
  });

  it('creates a .bak.* backup when the original file exists', () => {
    const p = writeTmp('settings.json', makeSettingsJson());
    const config = GEMINI_CLI_ADAPTER.parse(p)!;

    GEMINI_CLI_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

    const backups = readdirSync(tmpDir).filter((f) => f.includes('.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trip: timeout and excludeTools survive parse → serialize unchanged', () => {
    const p = writeTmp('settings.json', makeSettingsJson());
    const config = GEMINI_CLI_ADAPTER.parse(p)!;

    GEMINI_CLI_ADAPTER.serialize(p, config, { conductorEntry: CONDUCTOR_ENTRY });

    const written = readTmpJson(p);
    const servers = written['mcpServers'] as Record<string, Record<string, unknown>>;
    const testServer = servers['test-server'];

    expect(testServer).toBeDefined();
    expect(testServer!['timeout']).toBe(30000);
    expect(testServer!['excludeTools']).toEqual(['foo']);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('GEMINI_CLI_ADAPTER identity', () => {
  it('has client === "gemini-cli"', () => {
    expect(GEMINI_CLI_ADAPTER.client).toBe('gemini-cli');
  });
});
