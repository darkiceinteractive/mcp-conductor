/**
 * Tests for src/registry/snapshot.ts
 *
 * PRD §5 Phase 1 test cases:
 * - save and load roundtrip preserves catalog
 * - snapshot survives process restart (persists to disk)
 * - snapshot version mismatch falls back to refresh (returns null)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveSnapshot,
  loadSnapshot,
  SNAPSHOT_VERSION,
} from '../../../src/registry/snapshot.js';
import type { ToolDefinition } from '../../../src/registry/index.js';

const TMP = tmpdir();

function tmpPath(label: string): string {
  return join(TMP, `mcp-conductor-snap-${label}-${Date.now()}.json`);
}

const SAMPLE_CATALOG: ToolDefinition[] = [
  {
    server: 'github',
    name: 'list_issues',
    description: 'List issues in a repo',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    server: 'github',
    name: 'create_issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    routing: 'execute_code',
    cacheable: false,
  },
];

const cleanupPaths: string[] = [];
afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    try { await rm(p, { force: true }); } catch { /* ignore */ }
  }
});

describe('saveSnapshot + loadSnapshot', () => {
  it('save and load roundtrip preserves catalog', async () => {
    const path = tmpPath('roundtrip');
    cleanupPaths.push(path);

    await saveSnapshot(path, SAMPLE_CATALOG);
    const loaded = await loadSnapshot(path);

    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(SAMPLE_CATALOG.length);
    expect(loaded![0].server).toBe('github');
    expect(loaded![0].name).toBe('list_issues');
    expect(loaded![1].routing).toBe('execute_code');
    expect(loaded![1].cacheable).toBe(false);
  });

  it('snapshot survives process restart (raw file has correct fields)', async () => {
    const path = tmpPath('persist');
    cleanupPaths.push(path);

    await saveSnapshot(path, SAMPLE_CATALOG);

    // Simulate a "process restart" by reading the raw file independently
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed.version).toBe(SNAPSHOT_VERSION);
    expect(typeof parsed.savedAt).toBe('number');
    expect(parsed.savedAt).toBeGreaterThan(0);
    expect(Array.isArray(parsed.catalog)).toBe(true);
    expect(parsed.catalog).toHaveLength(SAMPLE_CATALOG.length);
  });

  it('snapshot version mismatch falls back to refresh (returns null)', async () => {
    const path = tmpPath('version-mismatch');
    cleanupPaths.push(path);

    const bogus = { version: '999', savedAt: Date.now(), catalog: SAMPLE_CATALOG };
    await writeFile(path, JSON.stringify(bogus), 'utf8');

    const result = await loadSnapshot(path);
    expect(result).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    const result = await loadSnapshot('/nonexistent/path/that/cannot/exist-mcp.json');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const path = tmpPath('malformed');
    cleanupPaths.push(path);

    await writeFile(path, 'not-valid-json{{{{', 'utf8');

    const result = await loadSnapshot(path);
    expect(result).toBeNull();
  });

  it('creates intermediate directories when saving', async () => {
    const path = join(TMP, `mcp-conductor-nested-${Date.now()}`, 'sub', 'snapshot.json');
    cleanupPaths.push(path);

    await expect(saveSnapshot(path, SAMPLE_CATALOG)).resolves.toBeUndefined();

    const loaded = await loadSnapshot(path);
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(SAMPLE_CATALOG.length);
  });
});
