/**
 * Unit tests for MC5 doctor client coverage section.
 *
 * Verifies that runDoctor() correctly populates clientCoverage when:
 * 1. No client configs exist on disk (entries is empty, counts are zero)
 * 2. One config file has the mcp-conductor entry (coveredCount=1)
 * 3. One config exists but lacks the mcp-conductor entry (missingCount=1)
 * 4. Mixed scenario: one covered, one missing — counts are correct
 * 5. formatDoctorResults() includes the "MCP CLIENT COVERAGE" section with
 *    [OK]/[MISSING] markers and setup recommendation for missing entries
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor, formatDoctorResults } from '../../../src/cli/commands/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'doctor-coverage-test-'));
}

/** Write a minimal valid conductor config so runDoctor() does not bail early. */
function writeConductorConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      exclusive: false,
      servers: { 'test-server': { command: 'node', args: [], env: {} } },
    }),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDoctor() — clientCoverage (MC5)', () => {
  let tmp: string;

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('entries is empty when no client configs exist on disk', async () => {
    tmp = makeTmp();
    const conductorPath = join(tmp, 'conductor.json');
    writeConductorConfig(conductorPath);

    vi.spyOn(
      await import('../../../src/config/loader.js'),
      'getDefaultConductorConfigPath',
    ).mockReturnValue(conductorPath);

    vi.spyOn(
      await import('../../../src/cli/clients/registry.js'),
      'getMCPClientConfigPaths',
    ).mockReturnValue([
      {
        client: 'claude-desktop',
        displayName: 'Claude Desktop',
        path: join(tmp, 'nonexistent.json'),
        format: 'json',
        mcpKey: 'mcpServers',
        exists: false,
        scope: 'global',
      },
    ]);

    const result = runDoctor();
    expect(result.clientCoverage.entries).toHaveLength(0);
    expect(result.clientCoverage.coveredCount).toBe(0);
    expect(result.clientCoverage.missingCount).toBe(0);
  });

  it('coveredCount=1 when one config file has the mcp-conductor entry', async () => {
    tmp = makeTmp();
    const conductorPath = join(tmp, 'conductor.json');
    const clientConfigPath = join(tmp, 'claude_desktop_config.json');

    writeConductorConfig(conductorPath);
    writeFileSync(
      clientConfigPath,
      JSON.stringify({
        mcpServers: { 'mcp-conductor': { command: 'npx', args: ['-y', '@darkiceinteractive/mcp-conductor@latest'] } },
      }),
      'utf-8',
    );

    vi.spyOn(await import('../../../src/config/loader.js'), 'getDefaultConductorConfigPath')
      .mockReturnValue(conductorPath);
    vi.spyOn(await import('../../../src/cli/clients/registry.js'), 'getMCPClientConfigPaths')
      .mockReturnValue([
        { client: 'claude-desktop', displayName: 'Claude Desktop', path: clientConfigPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
      ]);

    const result = runDoctor();
    expect(result.clientCoverage.entries).toHaveLength(1);
    expect(result.clientCoverage.coveredCount).toBe(1);
    expect(result.clientCoverage.missingCount).toBe(0);
    expect(result.clientCoverage.entries[0]!.hasConductor).toBe(true);
    expect(result.clientCoverage.entries[0]!.clientId).toBe('claude-desktop');
  });

  it('missingCount=1 when one config exists but lacks the mcp-conductor entry', async () => {
    tmp = makeTmp();
    const conductorPath = join(tmp, 'conductor.json');
    const clientConfigPath = join(tmp, 'settings.json');

    writeConductorConfig(conductorPath);
    writeFileSync(
      clientConfigPath,
      JSON.stringify({ mcpServers: { 'other-server': { command: 'node', args: [] } } }),
      'utf-8',
    );

    vi.spyOn(await import('../../../src/config/loader.js'), 'getDefaultConductorConfigPath')
      .mockReturnValue(conductorPath);
    vi.spyOn(await import('../../../src/cli/clients/registry.js'), 'getMCPClientConfigPaths')
      .mockReturnValue([
        { client: 'claude-desktop', displayName: 'Claude Desktop', path: clientConfigPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
      ]);

    const result = runDoctor();
    expect(result.clientCoverage.missingCount).toBe(1);
    expect(result.clientCoverage.coveredCount).toBe(0);
    expect(result.clientCoverage.entries[0]!.hasConductor).toBe(false);
  });

  it('mixed scenario: one covered, one missing — counts correct', async () => {
    tmp = makeTmp();
    const conductorPath = join(tmp, 'conductor.json');
    const coveredPath = join(tmp, 'covered.json');
    const missingPath = join(tmp, 'missing.json');

    writeConductorConfig(conductorPath);
    writeFileSync(
      coveredPath,
      JSON.stringify({
        mcpServers: {
          'mcp-conductor': { command: 'npx', args: [] },
          'other': { command: 'node', args: [] },
        },
      }),
      'utf-8',
    );
    writeFileSync(
      missingPath,
      JSON.stringify({ mcpServers: { 'some-server': { command: 'node', args: [] } } }),
      'utf-8',
    );

    vi.spyOn(await import('../../../src/config/loader.js'), 'getDefaultConductorConfigPath')
      .mockReturnValue(conductorPath);
    vi.spyOn(await import('../../../src/cli/clients/registry.js'), 'getMCPClientConfigPaths')
      .mockReturnValue([
        { client: 'claude-desktop', displayName: 'Claude Desktop', path: coveredPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
        { client: 'claude-code',    displayName: 'Claude Code',    path: missingPath,  format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
      ]);

    const result = runDoctor();
    expect(result.clientCoverage.entries).toHaveLength(2);
    expect(result.clientCoverage.coveredCount).toBe(1);
    expect(result.clientCoverage.missingCount).toBe(1);
  });

  it('formatDoctorResults() includes "MCP CLIENT COVERAGE" section with [OK]/[MISSING] markers', async () => {
    tmp = makeTmp();
    const conductorPath = join(tmp, 'conductor.json');
    const missingPath = join(tmp, 'missing.json');

    writeConductorConfig(conductorPath);
    writeFileSync(
      missingPath,
      JSON.stringify({ mcpServers: { 'srv': { command: 'node', args: [] } } }),
      'utf-8',
    );

    vi.spyOn(await import('../../../src/config/loader.js'), 'getDefaultConductorConfigPath')
      .mockReturnValue(conductorPath);
    vi.spyOn(await import('../../../src/cli/clients/registry.js'), 'getMCPClientConfigPaths')
      .mockReturnValue([
        { client: 'claude-desktop', displayName: 'Claude Desktop', path: missingPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
      ]);

    const result = runDoctor();
    const formatted = formatDoctorResults(result);

    expect(formatted).toContain('MCP CLIENT COVERAGE');
    expect(formatted).toContain('[MISSING]');
    expect(formatted).toContain('setup');
    // Should NOT show [OK] for this entry since conductor is absent
    const okForCoveredOnly = formatted.split('\n')
      .filter((l) => l.includes('[OK]') && l.includes('Claude Desktop'));
    expect(okForCoveredOnly).toHaveLength(0);
  });
});
