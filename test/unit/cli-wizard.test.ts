/**
 * Unit tests for the CLI wizard module.
 * Tests non-interactive path (isTTY=false) to avoid inquirer in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';

describe('runSetupWizard (non-interactive)', () => {
  it('imports without throwing when Claude configs exist', async () => {
    // Create a temp Claude config with mcpServers
    const dir = join(tmpdir(), `wizard-test-${nanoid(8)}`);
    mkdirSync(dir, { recursive: true });
    const claudePath = join(dir, 'settings.json');
    writeFileSync(claudePath, JSON.stringify({ mcpServers: { testserver: { command: 'node', args: ['index.js'] } } }), 'utf-8');

    // Point config paths env to our temp file
    // We test the import-servers layer (used by wizard) directly to avoid TTY mocking
    const { importServers } = await import('../../src/cli/commands/import-servers.js');
    const results = importServers({ configPaths: [claudePath], yes: true, dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.imported[0]!.name).toBe('testserver');
  });

  it('handles missing Claude configs gracefully', async () => {
    const { findClaudeConfigsWithServers } = await import('../../src/cli/commands/import-servers.js');
    const sources = findClaudeConfigsWithServers(['/nonexistent/path.json']);
    expect(sources).toHaveLength(0);
  });
});
