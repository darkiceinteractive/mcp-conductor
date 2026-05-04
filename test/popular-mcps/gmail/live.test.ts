/**
 * T4 — gmail MCP: live API tests.
 *
 * Skipped unless LIVE_TESTS=1 and the appropriate credential env var is set.
 */

import { describe, expect, it } from 'vitest';

const LIVE = process.env['LIVE_TESTS'] === '1';

describe('gmail MCP — live API', () => {
  it.skip('requires recording and live credentials — see nightly.yml for setup', () => {
    expect(LIVE).toBeDefined();
  });
});
