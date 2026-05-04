/**
 * T4 — Filesystem MCP: recorded-fixture functional tests.
 *
 * Synthetic fixtures for list_directory and read_file ship in this PR.
 * Additional fixtures are picked up automatically when present.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordedFixture } from '../../../scripts/record-fixtures.js';

const FIXTURES_DIR = resolve(process.cwd(), 'test/fixtures/recordings/filesystem');

function loadFixtures(): RecordedFixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as RecordedFixture);
}

describe('Filesystem MCP — recorded fixtures', () => {
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    it('no fixtures yet — run: npm run record:fixtures -- filesystem', () => {
      expect(true).toBe(true);
    });
    return;
  }

  describe('fixture shape validation', () => {
    for (const fixture of fixtures) {
      it(`${fixture.tool} — fixture is well-formed`, () => {
        expect(fixture.server).toBe('filesystem');
        expect(fixture.tool).toBeTruthy();
        expect(fixture.argsHash).toMatch(/^sha256:[0-9a-f]{16}$/);
        expect(fixture.args).toBeTypeOf('object');
        expect(fixture.response).toBeDefined();
        expect(fixture.responseBytes).toBeGreaterThan(0);
        expect(new Date(fixture.recordedAt).getTime()).not.toBeNaN();
      });
    }
  });

  describe('response shape', () => {
    for (const fixture of fixtures) {
      it(`${fixture.tool} — response has MCP content array`, () => {
        const resp = fixture.response as { content?: unknown[] };
        expect(resp).toHaveProperty('content');
        expect(Array.isArray(resp.content)).toBe(true);
        expect((resp.content ?? []).length).toBeGreaterThan(0);
      });
    }
  });

  describe('tool-specific assertions', () => {
    const listFixture = fixtures.find((f) => f.tool === 'list_directory');
    if (listFixture) {
      it('list_directory — returns array of entries with name and type', () => {
        const resp = listFixture.response as { content: Array<{ text: string }> };
        const text = resp.content[0]?.text ?? '[]';
        const entries = JSON.parse(text) as Array<{ name: string; type: string }>;
        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
          expect(entry).toHaveProperty('name');
          expect(entry).toHaveProperty('type');
          expect(['file', 'directory']).toContain(entry.type);
        }
      });
    }

    const readFixture = fixtures.find((f) => f.tool === 'read_file');
    if (readFixture) {
      it('read_file — returns text content', () => {
        const resp = readFixture.response as { content: Array<{ type: string; text?: string }> };
        const textItem = resp.content.find((c) => c.type === 'text');
        expect(textItem).toBeDefined();
        expect(textItem?.text).toBeTypeOf('string');
        expect((textItem?.text ?? '').length).toBeGreaterThan(0);
      });
    }
  });
});
