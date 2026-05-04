/**
 * B5: import_servers env scrub tests.
 *
 * Verifies that formatImportResults never surfaces env values in its output,
 * and that inline --token=VALUE style flags are redacted in command/args.
 */

import { describe, it, expect } from 'vitest';
import { formatImportResults } from '../../src/cli/commands/import-servers.js';
import type { ImportResult } from '../../src/cli/commands/import-servers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    imported: [],
    skipped: [],
    sourcePath: '/home/user/.claude/settings.json',
    conductorPath: '/home/user/.mcp-conductor.json',
    backupPaths: [],
    removedFromSource: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B5: env scrub tests
// ---------------------------------------------------------------------------

describe('B5: formatImportResults env scrub', () => {
  it('env values are not present in the summary output', () => {
    const result = makeResult({
      imported: [
        {
          name: 'brave-search',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-brave-search'],
          env: { BRAVE_API_KEY: 'secret-value' },
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('secret-value');
    expect(summary).toContain('BRAVE_API_KEY');
  });

  it('env key names are present in the output', () => {
    const result = makeResult({
      imported: [
        {
          name: 'github-mcp',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret123',
            GITHUB_ORG: 'myorg',
          },
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('ghp_secret123');
    expect(summary).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(summary).toContain('GITHUB_ORG');
  });

  it('multiple env keys are all shown but values never appear', () => {
    const result = makeResult({
      imported: [
        {
          name: 'multi-env-server',
          command: 'node',
          args: ['server.js'],
          env: {
            API_KEY: 'key-value-secret',
            DB_PASSWORD: 'db-pass-secret',
            AUTH_TOKEN: 'token-secret',
          },
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('key-value-secret');
    expect(summary).not.toContain('db-pass-secret');
    expect(summary).not.toContain('token-secret');
    expect(summary).toContain('API_KEY');
    expect(summary).toContain('DB_PASSWORD');
    expect(summary).toContain('AUTH_TOKEN');
  });

  it('server with no env shows no env section', () => {
    const result = makeResult({
      imported: [
        {
          name: 'no-env-server',
          command: 'npx',
          args: ['-y', 'some-server'],
          env: {},
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).toContain('no-env-server');
    expect(summary).not.toContain('env:');
  });

  it('dry-run output also scrubs env values', () => {
    const result = makeResult({
      imported: [
        {
          name: 'brave-search',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-brave-search'],
          env: { BRAVE_API_KEY: 'would-leak-this' },
        },
      ],
    });

    const summary = formatImportResults([result], true);

    expect(summary).not.toContain('would-leak-this');
    expect(summary).toContain('BRAVE_API_KEY');
    expect(summary).toContain('Would import');
  });
});

// ---------------------------------------------------------------------------
// B5: inline token flag redaction tests
// ---------------------------------------------------------------------------

describe('B5: formatImportResults inline token flag redaction', () => {
  it('--token=VALUE in args is redacted', () => {
    const result = makeResult({
      imported: [
        {
          name: 'some-server',
          command: 'npx',
          args: ['-y', 'some-server', '--token=mysecrettoken123'],
          env: {},
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('mysecrettoken123');
    expect(summary).toContain('--token=***');
  });

  it('--api-key=VALUE in args is redacted', () => {
    const result = makeResult({
      imported: [
        {
          name: 'api-server',
          command: 'node',
          args: ['index.js', '--api-key=abc-def-ghij'],
          env: {},
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('abc-def-ghij');
    expect(summary).toContain('--api-key=***');
  });

  it('--secret=VALUE in command is redacted', () => {
    const result = makeResult({
      imported: [
        {
          name: 'secret-server',
          command: 'server --secret=topsecret99',
          args: [],
          env: {},
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).not.toContain('topsecret99');
    expect(summary).toContain('--secret=***');
  });

  it('non-sensitive args are not redacted', () => {
    const result = makeResult({
      imported: [
        {
          name: 'normal-server',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs'],
          env: {},
        },
      ],
    });

    const summary = formatImportResults([result], false);

    expect(summary).toContain('@modelcontextprotocol/server-filesystem');
    expect(summary).toContain('/home/user/docs');
  });
});
