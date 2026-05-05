/**
 * Unit tests for src/cli/clients/registry.ts (MC1)
 *
 * Verifies:
 * - getMCPClientConfigPaths() returns ≥ 10 entries on macOS (one per client,
 *   possibly more for additional global paths).
 * - Every entry has all required MCPClientConfigLocation fields populated.
 * - The legacy getClaudeConfigPaths() shim returns only Claude paths.
 */

import { describe, it, expect } from 'vitest';
import {
  getMCPClientConfigPaths,
  type MCPClientConfigLocation,
  type MCPClientId,
} from '../../../src/cli/clients/registry.js';
import { getClaudeConfigPaths } from '../../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CLIENT_IDS: MCPClientId[] = [
  'claude-code',
  'claude-desktop',
  'codex',
  'gemini-cli',
  'cursor',
  'cline',
  'zed',
  'continue',
  'opencode',
  'kimi-code',
];

const VALID_FORMATS = new Set(['json', 'toml', 'yaml']);
const VALID_SCOPES = new Set(['global', 'project']);

function isAbsolutePath(p: string): boolean {
  // Absolute on all platforms: starts with / (Unix) or X:\ (Windows)
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p);
}

// ---------------------------------------------------------------------------
// getMCPClientConfigPaths()
// ---------------------------------------------------------------------------

describe('getMCPClientConfigPaths()', () => {
  it('returns at least 10 entries on the current platform', () => {
    const locations = getMCPClientConfigPaths();
    // 10 distinct clients, some with multiple paths per platform
    expect(locations.length).toBeGreaterThanOrEqual(10);
  });

  it('covers all 10 expected client IDs', () => {
    const locations = getMCPClientConfigPaths();
    const foundIds = new Set(locations.map((l) => l.client));
    for (const id of VALID_CLIENT_IDS) {
      expect(foundIds.has(id), `Missing client: ${id}`).toBe(true);
    }
  });

  it('every entry has all MCPClientConfigLocation fields populated', () => {
    const locations = getMCPClientConfigPaths();
    for (const loc of locations) {
      // client
      expect(VALID_CLIENT_IDS).toContain(loc.client);

      // displayName — non-empty string
      expect(typeof loc.displayName).toBe('string');
      expect(loc.displayName.length).toBeGreaterThan(0);

      // path — absolute path string
      expect(typeof loc.path).toBe('string');
      expect(isAbsolutePath(loc.path), `Non-absolute path: ${loc.path}`).toBe(true);

      // format
      expect(VALID_FORMATS.has(loc.format), `Invalid format: ${loc.format}`).toBe(true);

      // mcpKey — non-empty string
      expect(typeof loc.mcpKey).toBe('string');
      expect(loc.mcpKey.length).toBeGreaterThan(0);

      // exists — boolean (may be true or false; we just check the type)
      expect(typeof loc.exists).toBe('boolean');

      // scope
      expect(VALID_SCOPES.has(loc.scope), `Invalid scope: ${loc.scope}`).toBe(true);
    }
  });

  it('all global entries have scope === "global"', () => {
    const locations = getMCPClientConfigPaths({ includeProject: false });
    for (const loc of locations) {
      expect(loc.scope).toBe('global');
    }
  });

  it('includeProject: true adds project-scoped entries', () => {
    const withProject = getMCPClientConfigPaths({ includeProject: true });
    const withoutProject = getMCPClientConfigPaths({ includeProject: false });
    expect(withProject.length).toBeGreaterThan(withoutProject.length);
    const projectEntries = withProject.filter((l) => l.scope === 'project');
    expect(projectEntries.length).toBeGreaterThan(0);
  });

  it('every path is unique within the returned list', () => {
    const locations = getMCPClientConfigPaths({ includeProject: true });
    const paths = locations.map((l) => l.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  it('returns a stable result on repeated calls', () => {
    const first = getMCPClientConfigPaths();
    const second = getMCPClientConfigPaths();
    expect(first.length).toBe(second.length);
    for (let i = 0; i < first.length; i++) {
      expect(first[i]!.path).toBe(second[i]!.path);
    }
  });
});

// ---------------------------------------------------------------------------
// getClaudeConfigPaths() — backwards-compat shim
// ---------------------------------------------------------------------------

describe('getClaudeConfigPaths() shim', () => {
  it('returns only Claude paths (no other client paths)', () => {
    const claudePaths = getClaudeConfigPaths();
    const allLocations = getMCPClientConfigPaths({ includeProject: true });
    const nonClaudePaths = allLocations
      .filter((l) => !l.client.startsWith('claude-'))
      .map((l) => l.path);

    for (const p of claudePaths) {
      expect(nonClaudePaths.includes(p), `Shim returned non-Claude path: ${p}`).toBe(false);
    }
  });

  it('returns an array of strings', () => {
    const paths = getClaudeConfigPaths();
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths) {
      expect(typeof p).toBe('string');
    }
  });

  it('returns at least one Claude-related path', () => {
    const paths = getClaudeConfigPaths();
    expect(paths.length).toBeGreaterThan(0);
  });

  it('each path is absolute', () => {
    const paths = getClaudeConfigPaths();
    for (const p of paths) {
      expect(isAbsolutePath(p), `Non-absolute path: ${p}`).toBe(true);
    }
  });

  it('only returns paths from the claude-code or claude-desktop clients', () => {
    const claudePaths = new Set(getClaudeConfigPaths());
    const allLocations = getMCPClientConfigPaths({ includeProject: true });

    // Every path returned by the shim must appear in getMCPClientConfigPaths
    // under a claude-* client.
    const claudeLocPaths = new Set(
      allLocations.filter((l) => l.client.startsWith('claude-')).map((l) => l.path),
    );

    for (const p of claudePaths) {
      expect(claudeLocPaths.has(p), `Path not found in claude-* locations: ${p}`).toBe(true);
    }
  });
});
