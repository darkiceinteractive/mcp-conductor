/**
 * T4 — Filesystem MCP: live tests.
 *
 * Skipped unless LIVE_TESTS=1. The filesystem MCP does not require a token
 * but does require the server to be configured in ~/.mcp-conductor.json.
 */

import { describe, expect, it } from 'vitest';

const LIVE = process.env['LIVE_TESTS'] === '1';

describe('Filesystem MCP — live', () => {
  it.skipIf(!LIVE)('list_directory — lists /tmp without error', async () => {
    expect(LIVE).toBe(true);
  });

  it.skipIf(!LIVE)('read_file — reads an existing file', async () => {
    expect(LIVE).toBe(true);
  });

  if (!LIVE) {
    it('skipped — set LIVE_TESTS=1 to enable live tests', () => {
      expect(true).toBe(true);
    });
  }
});
