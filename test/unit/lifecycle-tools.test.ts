/**
 * Unit tests for X2 lifecycle MCP tool helper modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';

// We test the command modules directly, not via the MCP server.
import {
  findClaudeConfigsWithServers,
  importServers,
  formatImportResults,
  writeBackup,
  stripServersFromConfig,
} from '../../src/cli/commands/import-servers.js';
import { exportToClaude } from '../../src/cli/commands/export-servers.js';
import { recommendRouting, getRoutingRecommendations } from '../../src/cli/commands/routing.js';
import { runDoctor, formatDoctorResults } from '../../src/cli/commands/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const d = join(tmpdir(), `x2-test-${nanoid(8)}`);
  require('node:fs').mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// import-servers
// ---------------------------------------------------------------------------

describe('findClaudeConfigsWithServers', () => {
  it('returns empty array when no paths exist', () => {
    const result = findClaudeConfigsWithServers(['/nonexistent/path.json']);
    expect(result).toEqual([]);
  });

  it('skips config files with no mcpServers key', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeJson(p, { someOtherKey: true });
    const result = findClaudeConfigsWithServers([p]);
    expect(result).toEqual([]);
  });

  it('skips config files with empty mcpServers', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: {} });
    const result = findClaudeConfigsWithServers([p]);
    expect(result).toEqual([]);
  });

  it('returns config with non-empty mcpServers', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: { github: { command: 'npx', args: ['-y', '@mcp/github'] } } });
    const result = findClaudeConfigsWithServers([p]);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(p);
    expect(result[0]!.servers['github']!.command).toBe('npx');
  });
});

describe('writeBackup', () => {
  it('copies source file to timestamped .bak path and returns bak path', () => {
    const dir = tmpDir();
    const src = join(dir, 'config.json');
    writeJson(src, { test: true });
    const bakPath = writeBackup(src);
    // B10: timestamped suffix .bak.YYYYMMDDHHMMSS (14 digits)
    expect(bakPath).toMatch(/\.bak\.\d{14}$/);
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath, 'utf-8')).toBe(readFileSync(src, 'utf-8'));
  });
});

describe('stripServersFromConfig', () => {
  it('removes named servers from config file', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeJson(p, { mcpServers: { github: { command: 'npx' }, filesystem: { command: 'node' } } });
    stripServersFromConfig(p, ['github']);
    const result = JSON.parse(readFileSync(p, 'utf-8'));
    expect(result.mcpServers).not.toHaveProperty('github');
    expect(result.mcpServers).toHaveProperty('filesystem');
  });

  it('is a no-op if file does not exist', () => {
    expect(() => stripServersFromConfig('/nonexistent/path.json', ['foo'])).not.toThrow();
  });
});

describe('importServers', () => {
  it('returns empty results when no Claude configs found', () => {
    const results = importServers({ configPaths: ['/nonexistent/path.json'], yes: true });
    expect(results).toEqual([]);
  });

  it('dry-run does not write conductor config', () => {
    const dir = tmpDir();
    const claudePath = join(dir, 'claude.json');
    writeJson(claudePath, { mcpServers: { myserver: { command: 'node', args: ['index.js'] } } });

    // Override conductor config path via env to a temp location
    const conductorPath = join(dir, '.mcp-conductor.json');
    process.env['CONDUCTOR_CONFIG'] = conductorPath;
    try {
      const results = importServers({ configPaths: [claudePath], yes: true, dryRun: true });
      expect(results[0]!.imported).toHaveLength(1);
      expect(existsSync(conductorPath)).toBe(false); // dry-run: no write
    } finally {
      delete process.env['CONDUCTOR_CONFIG'];
    }
  });
});

describe('formatImportResults', () => {
  it('returns no-config message when results empty', () => {
    const text = formatImportResults([]);
    expect(text).toContain('No Claude config');
  });

  it('shows imported server names', () => {
    const text = formatImportResults([{
      imported: [{ name: 'github', command: 'npx', args: [] }],
      skipped: [],
      sourcePath: '/tmp/config.json',
      conductorPath: '/tmp/.mcp-conductor.json',
      backupPaths: [],
      removedFromSource: false,
    }]);
    expect(text).toContain('github');
    expect(text).toContain('1 imported');
  });
});

// ---------------------------------------------------------------------------
// export-servers
// ---------------------------------------------------------------------------

describe('exportToClaude', () => {
  it('returns valid JSON for claude-desktop format', () => {
    const result = exportToClaude({ format: 'claude-desktop' });
    const parsed = JSON.parse(result.json);
    expect(parsed).toHaveProperty('mcpServers');
    expect(parsed.mcpServers).toHaveProperty('mcp-conductor');
    expect(result.format).toBe('claude-desktop');
  });

  it('returns flat mcpServers for claude-code format', () => {
    const result = exportToClaude({ format: 'claude-code' });
    const parsed = JSON.parse(result.json);
    expect(parsed).toHaveProperty('mcpServers');
  });

  it('returns inner object for raw format', () => {
    const result = exportToClaude({ format: 'raw' });
    const parsed = JSON.parse(result.json);
    expect(parsed).toHaveProperty('mcp-conductor');
  });
});

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

describe('recommendRouting', () => {
  it('recommends passthrough for search servers', () => {
    const r = recommendRouting('brave-search');
    expect(r.recommendation).toBe('passthrough');
  });

  it('recommends passthrough for calendar servers', () => {
    expect(recommendRouting('google-calendar').recommendation).toBe('passthrough');
  });

  it('recommends execute_code for generic servers', () => {
    expect(recommendRouting('github').recommendation).toBe('execute_code');
  });

  it('recommends execute_code for filesystem', () => {
    expect(recommendRouting('filesystem').recommendation).toBe('execute_code');
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('returns a well-shaped result with required fields', () => {
    // runDoctor reads the real ~/.mcp-conductor.json if present on this machine.
    // We only assert shape here — the content depends on the dev environment.
    const result = runDoctor();
    expect(typeof result.conductorConfigFound).toBe('boolean');
    expect(typeof result.serverCount).toBe('number');
    expect(Array.isArray(result.servers)).toBe(true);
    expect(Array.isArray(result.globalIssues)).toBe(true);
    expect(typeof result.healthyCount).toBe('number');
    expect(typeof result.warnCount).toBe('number');
    expect(typeof result.errorCount).toBe('number');
  });

  it('reports config not found for a synthetic absent-config result', () => {
    // Exercise the absent-config code path via a synthetic result object,
    // independent of what is actually on disk on this machine.
    const absentResult = {
      conductorConfigFound: false,
      conductorConfigPath: '/nonexistent/.mcp-conductor.json',
      serverCount: 0,
      healthyCount: 0,
      warnCount: 0,
      errorCount: 0,
      servers: [],
      globalIssues: ['Conductor config not found'],
    };
    expect(absentResult.conductorConfigFound).toBe(false);
    expect(absentResult.globalIssues.length).toBeGreaterThan(0);
    const text = formatDoctorResults(absentResult);
    expect(text).toContain('NOT FOUND');
  });
});

describe('formatDoctorResults', () => {
  it('shows NOT FOUND when config absent', () => {
    const result = runDoctor();
    const text = formatDoctorResults({ ...result, conductorConfigFound: false, globalIssues: ['missing'] });
    expect(text).toContain('NOT FOUND');
  });
});
