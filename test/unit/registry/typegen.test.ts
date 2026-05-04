/**
 * Tests for src/registry/typegen.ts
 *
 * PRD §5 Phase 1 test cases:
 * - converts simple object schema to interface
 * - converts enum to TS union
 * - converts array of strings
 * - preserves description as JSDoc
 * - handles recursive schemas (fallback to unknown)
 * - handles oneOf / anyOf / allOf
 * - combined index references all server namespaces
 *
 * Plan amendment tests:
 * - @example JSDoc blocks emitted from examples[]
 * - <server>.routing.json written with correct routing decisions
 * - routing defaults to execute_code when tool.routing is unset
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateServerTypes,
  generateIndexTypes,
  buildRoutingManifest,
  writeTypesToDir,
} from '../../../src/registry/typegen.js';
import type { ToolDefinition } from '../../../src/registry/index.js';

const TMP = tmpdir();

function tmpDir(label: string): string {
  return join(TMP, `mcp-conductor-typegen-${label}-${Date.now()}`);
}

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    server: 'test',
    name: 'my_tool',
    description: 'A test tool',
    inputSchema: { type: 'object' },
    ...overrides,
  };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const d of cleanupDirs.splice(0)) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── generateServerTypes ─────────────────────────────────────────────────

describe('generateServerTypes', () => {
  it('converts simple object schema to interface', async () => {
    const tool = makeTool({
      name: 'list_issues',
      description: 'List issues',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        required: ['owner', 'repo'],
      },
    });

    const dts = await generateServerTypes('github', [tool]);

    expect(dts).toContain('namespace github');
    // json-schema-to-typescript capitalises the interface name; check the suffix only
    expect(dts).toMatch(/ListIssues_Input|list_issues_Input/);
    expect(dts).toContain('owner');
    expect(dts).toContain('repo');
  });

  it('converts enum to TS union type', async () => {
    const tool = makeTool({
      name: 'filter_issues',
      inputSchema: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      },
    });

    const dts = await generateServerTypes('github', [tool]);

    // json-schema-to-typescript produces union literal types for enums
    expect(dts).toMatch(/open|closed/);
  });

  it('converts array of strings', async () => {
    const tool = makeTool({
      name: 'tag_tool',
      inputSchema: {
        type: 'object',
        properties: { labels: { type: 'array', items: { type: 'string' } } },
      },
    });

    const dts = await generateServerTypes('test', [tool]);

    expect(dts).toContain('string[]');
  });

  it('preserves description as JSDoc comment', async () => {
    const tool = makeTool({
      description: 'List all open issues for a repository',
      inputSchema: { type: 'object' },
    });

    const dts = await generateServerTypes('test', [tool]);

    expect(dts).toContain('List all open issues for a repository');
    expect(dts).toContain('/**');
    expect(dts).toContain('*/');
  });

  it('handles recursive schemas without crashing (fallback to unknown)', async () => {
    const recursiveSchema = {
      type: 'object' as const,
      properties: {
        child: { $ref: '#' },
      },
    };

    const tool = makeTool({ inputSchema: recursiveSchema });

    // Must resolve (not throw) even for problematic schemas
    const dts = await generateServerTypes('test', [tool]);
    expect(typeof dts).toBe('string');
    expect(dts.length).toBeGreaterThan(0);
  });

  it('handles oneOf schema without throwing', async () => {
    const tool = makeTool({
      name: 'flexible_tool',
      inputSchema: {
        oneOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      },
    });

    await expect(generateServerTypes('test', [tool])).resolves.toBeTypeOf('string');
  });

  it('handles anyOf schema without throwing', async () => {
    const tool = makeTool({
      name: 'anyof_tool',
      inputSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    });

    await expect(generateServerTypes('test', [tool])).resolves.toBeTypeOf('string');
  });

  it('handles allOf schema without throwing', async () => {
    const tool = makeTool({
      name: 'allof_tool',
      inputSchema: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'string' } } },
        ],
      },
    });

    await expect(generateServerTypes('test', [tool])).resolves.toBeTypeOf('string');
  });

  // ── Plan amendment: @example JSDoc ─────────────────────────────────────

  it('emits @example JSDoc blocks from examples[] (plan amendment)', async () => {
    const tool = makeTool({
      name: 'search_issues',
      description: 'Search for issues',
      examples: [
        {
          description: 'Search open bugs',
          args: { q: 'bug', state: 'open' },
          result: [{ id: 1, title: 'Bug found' }],
        },
      ],
    });

    const dts = await generateServerTypes('github', [tool]);

    expect(dts).toContain('@example');
    expect(dts).toContain('Search open bugs');
    expect(dts).toContain('"q":"bug"');
  });

  it('emits @example block without description when description field absent', async () => {
    const tool = makeTool({
      examples: [{ args: { x: 1 }, result: { y: 2 } }],
    });

    const dts = await generateServerTypes('test', [tool]);

    expect(dts).toContain('@example');
    expect(dts).toContain('"x":1');
  });
});

// ─── generateIndexTypes ───────────────────────────────────────────────────

describe('generateIndexTypes', () => {
  it('combined index references all server namespaces', () => {
    const index = generateIndexTypes(['github', 'filesystem', 'brave_search']);

    expect(index).toContain('github');
    expect(index).toContain('filesystem');
    expect(index).toContain('brave_search');
    expect(index).toContain('declare global');
    expect(index).toContain('namespace mcp');
    expect(index).toContain('namespace tools');
    expect(index).toContain('export {}');
  });

  it('returns valid skeleton for empty server list', () => {
    const index = generateIndexTypes([]);
    expect(index).toContain('declare global');
    expect(index).toContain('export {}');
  });
});

// ─── buildRoutingManifest ─────────────────────────────────────────────────

describe('buildRoutingManifest', () => {
  it('defaults to execute_code when tool.routing is unset (plan amendment)', () => {
    const tools: ToolDefinition[] = [
      makeTool({ name: 'list_repos', server: 'github' }),
      makeTool({ name: 'create_repo', server: 'github', routing: 'passthrough' }),
    ];

    const manifest = buildRoutingManifest('github', tools);

    expect(manifest.server).toBe('github');
    expect(manifest.tools['list_repos']).toBe('execute_code');
    expect(manifest.tools['create_repo']).toBe('passthrough');
    expect(typeof manifest.generatedAt).toBe('number');
    expect(manifest.generatedAt).toBeGreaterThan(0);
  });

  it('respects hidden routing value', () => {
    const tool = makeTool({ name: 'internal_tool', routing: 'hidden' });
    const manifest = buildRoutingManifest('test', [tool]);
    expect(manifest.tools['internal_tool']).toBe('hidden');
  });

  it('includes generatedAt timestamp', () => {
    const before = Date.now();
    const manifest = buildRoutingManifest('test', [makeTool()]);
    const after = Date.now();
    expect(manifest.generatedAt).toBeGreaterThanOrEqual(before);
    expect(manifest.generatedAt).toBeLessThanOrEqual(after);
  });
});

// ─── writeTypesToDir ─────────────────────────────────────────────────────

describe('writeTypesToDir', () => {
  it('writes <server>.d.ts, <server>.routing.json, and _index.d.ts', async () => {
    const dir = tmpDir('write');
    cleanupDirs.push(dir);

    const tools: ToolDefinition[] = [
      makeTool({ server: 'github', name: 'list_issues', routing: 'execute_code' }),
      makeTool({ server: 'github', name: 'create_pr', routing: 'passthrough' }),
    ];

    const written = await writeTypesToDir(dir, new Map([['github', tools]]));

    expect(written.some((p) => p.endsWith('github.d.ts'))).toBe(true);
    expect(written.some((p) => p.endsWith('github.routing.json'))).toBe(true);
    expect(written.some((p) => p.endsWith('_index.d.ts'))).toBe(true);

    // Verify routing.json content matches the plan amendment spec
    const routingPath = written.find((p) => p.endsWith('github.routing.json'))!;
    const routing = JSON.parse(await readFile(routingPath, 'utf8'));

    expect(routing.server).toBe('github');
    expect(routing.tools['list_issues']).toBe('execute_code');
    expect(routing.tools['create_pr']).toBe('passthrough');
  });

  it('creates the output directory if it does not exist', async () => {
    const dir = join(TMP, `mcp-conductor-typegen-missing-${Date.now()}`, 'nested');
    cleanupDirs.push(dir);

    await expect(
      writeTypesToDir(dir, new Map([['test', [makeTool({ server: 'test' })]]])
      )
    ).resolves.not.toThrow();
  });

  it('handles multiple servers', async () => {
    const dir = tmpDir('multi');
    cleanupDirs.push(dir);

    const toolsByServer = new Map([
      ['github', [makeTool({ server: 'github', name: 'list_issues' })]],
      ['filesystem', [makeTool({ server: 'filesystem', name: 'read_file' })]],
    ]);

    const written = await writeTypesToDir(dir, toolsByServer);

    expect(written.some((p) => p.endsWith('github.d.ts'))).toBe(true);
    expect(written.some((p) => p.endsWith('filesystem.d.ts'))).toBe(true);
    expect(written.some((p) => p.endsWith('_index.d.ts'))).toBe(true);

    // _index.d.ts should reference both servers
    const indexPath = written.find((p) => p.endsWith('_index.d.ts'))!;
    const indexContent = await readFile(indexPath, 'utf8');
    expect(indexContent).toContain('github');
    expect(indexContent).toContain('filesystem');
  });
});
