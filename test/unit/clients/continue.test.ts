/**
 * Unit tests for src/cli/clients/continue.ts (MC2 — Continue.dev adapter)
 *
 * Coverage:
 * 1. YAML parse — happy path with mcpServers
 * 2. YAML parse — returns null for missing file
 * 3. YAML parse — returns null for file with no mcpServers key
 * 4. JSON fallback — project drop-in .json file parsed correctly
 * 5. serialize — preserves-other-keys (models, slashCommands survive round-trip)
 * 6. serialize — keepOnlyConductor removes all other servers
 * 7. serialize — backup written (.bak.YYYYMMDDHHMMSS beside original)
 * 8. serialize — missing-file does not throw, writes new file
 * 9. serialize — JSON .json round-trip preserves structure
 *
 * Note on comment preservation: the `yaml` package (v2) does NOT preserve
 * comments on stringify.  This is a known limitation of virtually all YAML
 * serialisers.  Comments are silently dropped during a round-trip; this is
 * acceptable and documented here so users are not surprised.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTINUE_ADAPTER } from '../../../src/cli/clients/continue.js';
import type { NormalisedClientConfig, NormalisedServerEntry } from '../../../src/cli/clients/adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write content to a uniquely-named temp file and return its absolute path. */
function writeTmp(content: string, ext = '.yaml'): string {
  const path = join(tmpdir(), `continue-test-${randomUUID()}${ext}`);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Collect all backup files sitting beside `sourcePath` in the same dir. */
function findBackups(sourcePath: string): string[] {
  const dir = tmpdir();
  const base = sourcePath.slice(dir.length + 1); // filename portion
  return readdirSync(dir)
    .filter((f) => f.startsWith(base) && /\.bak\.\d{14}$/.test(f))
    .map((f) => join(dir, f));
}

/** Paths registered here are removed (with any backups) after each test. */
const toCleanup: string[] = [];

afterEach(() => {
  for (const p of toCleanup.splice(0)) {
    for (const bak of findBackups(p)) {
      try { unlinkSync(bak); } catch { /* ignore */ }
    }
    try { unlinkSync(p); } catch { /* ignore */ }
  }
});

const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'node',
  args: ['/usr/local/lib/mcp-conductor/dist/index.js'],
};

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe('CONTINUE_ADAPTER.parse()', () => {
  it('parses a YAML config with mcpServers', () => {
    const yaml = [
      'mcpServers:',
      '  my-server:',
      '    command: uvx',
      '    args:',
      '      - mcp-server-fetch',
      '    env:',
      '      DEBUG: "1"',
    ].join('\n') + '\n';

    const path = writeTmp(yaml);
    toCleanup.push(path);

    const result = CONTINUE_ADAPTER.parse(path);
    expect(result).not.toBeNull();
    expect(result!.servers['my-server']).toEqual({
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: { DEBUG: '1' },
    });
  });

  it('returns null for a missing file', () => {
    const path = join(tmpdir(), `nonexistent-${randomUUID()}.yaml`);
    expect(CONTINUE_ADAPTER.parse(path)).toBeNull();
  });

  it('returns null for a YAML file with no mcpServers key', () => {
    const path = writeTmp('models:\n  - name: gpt-4\n');
    toCleanup.push(path);
    expect(CONTINUE_ADAPTER.parse(path)).toBeNull();
  });

  it('falls back to JSON.parse for .json extension (project drop-in)', () => {
    const doc = {
      mcpServers: {
        'json-server': { command: 'node', args: ['/path/server.js'] },
      },
    };
    const path = writeTmp(JSON.stringify(doc, null, 2), '.json');
    toCleanup.push(path);

    const result = CONTINUE_ADAPTER.parse(path);
    expect(result).not.toBeNull();
    expect(result!.servers['json-server']).toMatchObject({
      command: 'node',
      args: ['/path/server.js'],
    });
  });
});

// ---------------------------------------------------------------------------
// serialize()
// ---------------------------------------------------------------------------

describe('CONTINUE_ADAPTER.serialize()', () => {
  it('preserves models and slashCommands across a round-trip', () => {
    const yaml = [
      'models:',
      '  - title: GPT-4',
      '    provider: openai',
      '    model: gpt-4',
      'slashCommands:',
      '  - name: share',
      'mcpServers:',
      '  existing:',
      '    command: python3',
      '    args: ["-m", "mcp"]',
    ].join('\n') + '\n';

    const path = writeTmp(yaml);
    toCleanup.push(path);

    const config = CONTINUE_ADAPTER.parse(path)!;
    expect(config).not.toBeNull();

    CONTINUE_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const reparsed = CONTINUE_ADAPTER.parse(path)!;
    expect(reparsed).not.toBeNull();

    // Conductor was injected
    expect(reparsed.servers['mcp-conductor']).toMatchObject({ command: 'node' });
    // Existing server preserved in merge mode
    expect(reparsed.servers['existing']).toMatchObject({ command: 'python3' });

    // models / slashCommands preserved via config.raw
    const rawDoc = reparsed.raw as Record<string, unknown>;
    expect(rawDoc['models']).toBeDefined();
    expect(rawDoc['slashCommands']).toBeDefined();
  });

  it('keepOnlyConductor removes all other servers', () => {
    const yaml = [
      'mcpServers:',
      '  server-a:',
      '    command: node',
      '    args: ["/a.js"]',
      '  server-b:',
      '    command: uvx',
      '    args: ["mcp-b"]',
    ].join('\n') + '\n';

    const path = writeTmp(yaml);
    toCleanup.push(path);

    const config = CONTINUE_ADAPTER.parse(path)!;
    CONTINUE_ADAPTER.serialize(path, config, {
      conductorEntry: CONDUCTOR_ENTRY,
      keepOnlyConductor: true,
    });

    const reparsed = CONTINUE_ADAPTER.parse(path)!;
    expect(Object.keys(reparsed.servers)).toEqual(['mcp-conductor']);
    expect(reparsed.servers['mcp-conductor']).toMatchObject({ command: 'node' });
  });

  it('writes a .bak.YYYYMMDDHHMMSS backup before mutating the file', () => {
    const yaml = [
      'mcpServers:',
      '  my-server:',
      '    command: node',
      '    args: ["/srv.js"]',
    ].join('\n') + '\n';

    const path = writeTmp(yaml);
    toCleanup.push(path);

    const config = CONTINUE_ADAPTER.parse(path)!;
    CONTINUE_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const backups = findBackups(path);
    expect(backups.length).toBeGreaterThanOrEqual(1);
    for (const bak of backups) {
      expect(bak).toMatch(/\.bak\.\d{14}$/);
      expect(existsSync(bak)).toBe(true);
    }
  });

  it('serialize on a missing file does not throw and writes conductor entry', () => {
    const path = join(tmpdir(), `new-config-${randomUUID()}.yaml`);
    toCleanup.push(path);

    // File does not exist — config.raw is empty, servers map is empty
    const config: NormalisedClientConfig = { servers: {}, raw: {} };

    expect(() =>
      CONTINUE_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY }),
    ).not.toThrow();

    expect(existsSync(path)).toBe(true);

    const reparsed = CONTINUE_ADAPTER.parse(path);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.servers['mcp-conductor']).toMatchObject({ command: 'node' });
  });

  it('round-trip with .json extension preserves structure', () => {
    const doc = {
      mcpServers: {
        'json-server': { command: 'node', args: ['/path/server.js'] },
      },
      models: [{ name: 'gpt-4' }],
    };
    const path = writeTmp(JSON.stringify(doc, null, 2), '.json');
    toCleanup.push(path);

    const config = CONTINUE_ADAPTER.parse(path)!;
    CONTINUE_ADAPTER.serialize(path, config, { conductorEntry: CONDUCTOR_ENTRY });

    const reparsed = CONTINUE_ADAPTER.parse(path)!;
    expect(reparsed.servers['mcp-conductor']).toMatchObject({ command: 'node' });
    expect(reparsed.servers['json-server']).toMatchObject({ command: 'node' });
    const rawDoc = reparsed.raw as Record<string, unknown>;
    expect(Array.isArray(rawDoc['models'])).toBe(true);
  });
});
