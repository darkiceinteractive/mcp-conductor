/**
 * T4 — gmail MCP: recorded-fixture functional tests.
 *
 * Requires owner to run: npm run record:fixtures -- gmail
 * Fixtures land at: test/fixtures/recordings/gmail/
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordedFixture } from '../../../scripts/record-fixtures.js';

const FIXTURES_DIR = resolve(process.cwd(), 'test/fixtures/recordings/gmail');

function loadFixtures(): RecordedFixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as RecordedFixture);
}

describe('gmail MCP — recorded fixtures', () => {
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    it.skip('requires recording — run: npm run record:fixtures -- gmail', () => {
      expect(true).toBe(true);
    });
    return;
  }

  describe('fixture shape validation', () => {
    for (const fixture of fixtures) {
      it(`${fixture.tool} — fixture is well-formed`, () => {
        expect(fixture.server).toBe('gmail');
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
      });
    }
  });
});
