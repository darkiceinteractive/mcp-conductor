/**
 * Unit tests for the MC3 multi-client setup wizard.
 *
 * Tests the non-interactive path (isTTY=false) and mock the registry +
 * adapters to avoid any real filesystem / TTY interaction.
 *
 * Verifies:
 * 1. Wizard completes without throwing when no existing client configs are found
 * 2. Locations where exists=false are skipped silently
 * 3. Adapter.parse() returning null is skipped gracefully
 * 4. Clients already fully configured (conductor-only) are reported as "skipping"
 * 5. Adapter.serialize() called with keepOnlyConductor=false on non-TTY auto-confirm
 * 6. De-duplication: existing conductor servers are not re-added
 * 7. Clients without a registered adapter are skipped gracefully
 * 8. Adapter.parse() throwing does not crash the wizard
 * 9. runSetupWizard({ legacy: true }) delegates to runLegacySetupWizard()
 * 10. runLegacySetupWizard() exits gracefully when no Claude configs found
 * 11. Multiple clients processed independently
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock @inquirer/prompts — never open a real TTY in tests
// ---------------------------------------------------------------------------

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('claude-desktop'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'wizard-mc3-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSetupWizard (MC3 multi-client, non-TTY)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
    // Force non-interactive path in every test
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('completes without throwing when no existing client configs are found', async () => {
    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
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

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await expect(runSetupWizard()).resolves.toBeUndefined();
  });

  it('skips locations where adapter.parse() returns null', async () => {
    const configPath = join(tmp, 'empty-config.json');
    writeFileSync(configPath, '{}', 'utf-8');

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const adapterMod = await import('../../../src/cli/clients/adapter.js');
    vi.spyOn(adapterMod.ADAPTERS.get('claude-desktop')!, 'parse').mockReturnValue(null);

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await expect(runSetupWizard()).resolves.toBeUndefined();
  });

  it('reports "skipping" when client already has conductor entry and no other servers', async () => {
    const configPath = join(tmp, 'conductor-only.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'mcp-conductor': { command: 'npx', args: ['-y', '@darkiceinteractive/mcp-conductor@latest'] } } }),
      'utf-8',
    );

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await runSetupWizard();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('skipping');
  });

  it('calls adapter.serialize() with keepOnlyConductor=false on non-TTY auto-confirm', async () => {
    const configPath = join(tmp, 'with-servers.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'my-server': { command: 'node', args: ['index.js'] } } }),
      'utf-8',
    );

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const adapterMod = await import('../../../src/cli/clients/adapter.js');
    const serializeSpy = vi.spyOn(adapterMod.ADAPTERS.get('claude-desktop')!, 'serialize');

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await runSetupWizard();

    expect(serializeSpy).toHaveBeenCalledOnce();
    const callOpts = serializeSpy.mock.calls[0]![2];
    expect(callOpts.keepOnlyConductor).toBe(false);
    expect(callOpts.conductorEntry.command).toBe('npx');
    expect(callOpts.conductorEntry.args).toContain('-y');
  });

  it('de-duplicates: existing conductor servers are not re-added to ~/.mcp-conductor.json', async () => {
    const configPath = join(tmp, 'duplicate.json');
    const conductorPath = join(tmp, 'conductor.json');

    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'already-there': { command: 'node', args: ['s.js'] }, 'new-server': { command: 'uvx', args: ['mcp'] } } }),
      'utf-8',
    );
    writeFileSync(
      conductorPath,
      JSON.stringify({ exclusive: false, servers: { 'already-there': { command: 'node', args: ['s.js'], env: {} } } }),
      'utf-8',
    );

    const loaderMod = await import('../../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await runSetupWizard();

    const written = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(written.servers)).toContain('already-there');
    expect(Object.keys(written.servers)).toContain('new-server');
    // Confirm no duplication
    expect(Object.keys(written.servers).filter((k) => k === 'already-there')).toHaveLength(1);
  });

  it('skips clients without a registered adapter gracefully', async () => {
    const configPath = join(tmp, 'unknown-client.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { s: { command: 'x' } } }), 'utf-8');

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'unknown-future-client' as never, displayName: 'Future Client', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await expect(runSetupWizard()).resolves.toBeUndefined();
  });

  it('handles adapter.parse() throwing without crashing the wizard', async () => {
    const configPath = join(tmp, 'throws.json');
    writeFileSync(configPath, '{}', 'utf-8');

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: configPath, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const adapterMod = await import('../../../src/cli/clients/adapter.js');
    vi.spyOn(adapterMod.ADAPTERS.get('claude-desktop')!, 'parse').mockImplementation(() => {
      throw new Error('parse explosion');
    });

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await expect(runSetupWizard()).resolves.toBeUndefined();
  });

  it('runSetupWizard({ legacy: true }) uses the legacy single-Claude flow (no multi-client header)', async () => {
    // The legacy path prints "legacy mode" in its header; the multi-client path does not.
    // We mock findClaudeConfigsWithServers to return empty so the legacy wizard exits fast.
    const importMod = await import('../../../src/cli/commands/import-servers.js');
    vi.spyOn(importMod, 'findClaudeConfigsWithServers').mockReturnValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await runSetupWizard({ legacy: true });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Legacy header contains "legacy mode"
    expect(output).toContain('legacy mode');
    // Multi-client header must NOT appear
    expect(output).not.toContain('scans all known MCP client configs');
  });

  it('runLegacySetupWizard() exits gracefully when no Claude configs are found', async () => {
    const importMod = await import('../../../src/cli/commands/import-servers.js');
    vi.spyOn(importMod, 'findClaudeConfigsWithServers').mockReturnValue([]);

    const { runLegacySetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await expect(runLegacySetupWizard()).resolves.toBeUndefined();
  });

  it('processes multiple clients independently — both get serialize() called', async () => {
    const pathA = join(tmp, 'client-a.json');
    const pathB = join(tmp, 'client-b.json');
    writeFileSync(pathA, JSON.stringify({ mcpServers: { 'srv-a': { command: 'node', args: [] } } }), 'utf-8');
    writeFileSync(pathB, JSON.stringify({ mcpServers: { 'srv-b': { command: 'uvx', args: [] } } }), 'utf-8');

    const registryMod = await import('../../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      { client: 'claude-desktop', displayName: 'Claude Desktop', path: pathA, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
      { client: 'claude-code',    displayName: 'Claude Code',    path: pathB, format: 'json', mcpKey: 'mcpServers', exists: true, scope: 'global' },
    ]);

    const adapterMod = await import('../../../src/cli/clients/adapter.js');
    const serializeDesktop = vi.spyOn(adapterMod.ADAPTERS.get('claude-desktop')!, 'serialize');
    const serializeCode    = vi.spyOn(adapterMod.ADAPTERS.get('claude-code')!, 'serialize');

    const { runSetupWizard } = await import('../../../src/cli/wizard/setup.js');
    await runSetupWizard();

    expect(serializeDesktop).toHaveBeenCalledOnce();
    expect(serializeCode).toHaveBeenCalledOnce();
  });
});
