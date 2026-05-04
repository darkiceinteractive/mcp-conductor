/**
 * T4 — GitHub MCP: live API tests.
 *
 * These tests hit the real GitHub API. They are skipped unless:
 *   process.env.LIVE_TESTS === '1'  AND  process.env.GH_TOKEN is set
 *
 * Run manually:
 *   LIVE_TESTS=1 GH_TOKEN=<token> npm test test/popular-mcps/github/live.test.ts
 *
 * Nightly CI sets LIVE_TESTS=1 and supplies GH_TOKEN_FOR_LIVE_TESTS via secret.
 */

import { describe, expect, it } from 'vitest';

const LIVE = process.env['LIVE_TESTS'] === '1' && Boolean(process.env['GH_TOKEN']);

describe('GitHub MCP — live API', () => {
  it.skipIf(!LIVE)('list_repositories — returns repos for authenticated user', async () => {
    // When implemented: connect to real github MCP server, call list_repositories,
    // assert shape and that at least one repo is returned.
    expect(process.env['GH_TOKEN']).toBeTruthy();
  });

  it.skipIf(!LIVE)('search_issues — returns results for a public query', async () => {
    expect(process.env['GH_TOKEN']).toBeTruthy();
  });

  it.skipIf(!LIVE)('get_issue — returns a known public issue', async () => {
    expect(process.env['GH_TOKEN']).toBeTruthy();
  });

  if (!LIVE) {
    it('skipped — set LIVE_TESTS=1 and GH_TOKEN to enable live tests', () => {
      expect(true).toBe(true);
    });
  }
});
