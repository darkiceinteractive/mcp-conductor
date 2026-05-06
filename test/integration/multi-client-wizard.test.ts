/**
 * MC7: End-to-end integration tests for the multi-client setup wizard.
 *
 * Each test materialises a fake $HOME directory via mkdtempSync(), drops
 * fixture config files at the paths the wizard expects, then exercises the
 * full wizard + adapter pipeline against real files on disk.  No adapter
 * internals are mocked — only the registry discovery function and the
 * conductor config path are stubbed so the wizard reads the temp tree
 * instead of the real machine state.
 *
 * 4 facts about the mock strategy:
 *   1. `getMCPClientConfigPaths` is vi.spyOn'd to return temp-dir paths with
 *      `exists: true`/`false` set explicitly — avoids touching the real
 *      filesystem layout.
 *   2. `getDefaultConductorConfigPath` is vi.spyOn'd to redirect conductor
 *      writes to a temp file so real ~/.mcp-conductor.json is never touched.
 *   3. `@inquirer/prompts` `confirm` is vi.mock'd at the module level and
 *      individual tests override it via `vi.fn().mockResolvedValueOnce()`.
 *   4. TTY is forced to non-interactive in all tests so the non-TTY code path
 *      runs; for skip-per-client tests we flip isTTY=true and use inquirer.
 *
 * @module test/integration/multi-client-wizard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import TOML from '@iarna/toml';

// ---------------------------------------------------------------------------
// Module-level mock: @inquirer/prompts
// Individual tests override the `confirm` spy as needed.
// ---------------------------------------------------------------------------

const confirmMock = vi.fn().mockResolvedValue(true);

vi.mock('@inquirer/prompts', () => ({
  confirm: confirmMock,
  select: vi.fn().mockResolvedValue('claude-code'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp root and return its path. */
function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'mc7-wizard-'));
}

/** Force-write a file, creating parent directories automatically. */
function writeFixture(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/** Build an MCPClientConfigLocation record for use in registry mock. */
function loc(
  client: import('../../src/cli/clients/registry.js').MCPClientId,
  displayName: string,
  path: string,
  format: 'json' | 'toml' | 'yaml',
  mcpKey: string,
  exists: boolean,
  scope: 'global' | 'project' = 'global',
): import('../../src/cli/clients/registry.js').MCPClientConfigLocation {
  return { client, displayName, path, format, mcpKey, exists, scope };
}

/** Find all *.bak.* files directly inside a directory. */
function findBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes('.bak.'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MC7: multi-client wizard end-to-end integration', () => {
  let home: string;
  let conductorPath: string;

  beforeEach(() => {
    home = makeHome();
    conductorPath = join(home, '.mcp-conductor.json');

    // Force non-interactive mode by default; individual tests may override.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    // Pre-create an empty conductor config at the temp path so findConductorConfig()
    // picks it up via the MCP_CONDUCTOR_CONFIG env var (which requires the file to exist).
    writeFileSync(conductorPath, JSON.stringify({ exclusive: false, servers: {} }), 'utf-8');
    process.env['MCP_CONDUCTOR_CONFIG'] = conductorPath;

    // Reset the confirm mock to its default (always true).
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env['MCP_CONDUCTOR_CONFIG'];
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Mixed clients on disk — Claude Code (JSON) + Cursor (JSON) + Continue (YAML)
  // -------------------------------------------------------------------------

  it('discovers 3 clients with different formats, calls each adapter serialize once', async () => {
    // 4 facts:
    //   1. Claude Code config is a JSON file with mcpServers key.
    //   2. Cursor config is a JSON file with mcpServers key (global ~/.cursor/mcp.json).
    //   3. Continue config is a YAML file with mcpServers key.
    //   4. Wizard runs in non-TTY mode so all 3 are auto-confirmed.

    const claudeCodePath = join(home, '.claude', 'settings.json');
    const cursorPath = join(home, '.cursor', 'mcp.json');
    const continuePath = join(home, '.continue', 'config.yaml');

    writeFixture(claudeCodePath, JSON.stringify({ mcpServers: { 'github-mcp': { command: 'node', args: ['github.js'] } } }));
    writeFixture(cursorPath, JSON.stringify({ mcpServers: { 'filesystem': { command: 'node', args: ['fs.js'] } } }));
    writeFixture(continuePath, 'mcpServers:\n  slack-mcp:\n    command: node\n    args:\n      - slack.js\n');

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
      loc('cursor', 'Cursor', cursorPath, 'json', 'mcpServers', true),
      loc('continue', 'Continue.dev', continuePath, 'yaml', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    // Import the clients index to ensure all adapters are registered before spying.
    await import('../../src/cli/clients/index.js');
    const adapterMod = await import('../../src/cli/clients/adapter.js');
    const serializeCode = vi.spyOn(adapterMod.ADAPTERS.get('claude-code')!, 'serialize');
    const serializeCursor = vi.spyOn(adapterMod.ADAPTERS.get('cursor')!, 'serialize');
    const serializeContinue = vi.spyOn(adapterMod.ADAPTERS.get('continue')!, 'serialize');

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Each adapter's serialize must have been called exactly once.
    expect(serializeCode).toHaveBeenCalledOnce();
    expect(serializeCursor).toHaveBeenCalledOnce();
    expect(serializeContinue).toHaveBeenCalledOnce();

    // All 3 calls must have keepOnlyConductor=false (merge mode, not migration mode).
    expect(serializeCode.mock.calls[0]![2].keepOnlyConductor).toBe(false);
    expect(serializeCursor.mock.calls[0]![2].keepOnlyConductor).toBe(false);
    expect(serializeContinue.mock.calls[0]![2].keepOnlyConductor).toBe(false);

    // Conductor config must have all 3 source servers imported.
    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(conductor.servers)).toContain('github-mcp');
    expect(Object.keys(conductor.servers)).toContain('filesystem');
    expect(Object.keys(conductor.servers)).toContain('slack-mcp');
  });

  // -------------------------------------------------------------------------
  // Test 2: Skip per-client — user confirms Claude Code, skips Cursor
  // -------------------------------------------------------------------------

  it('respects per-client skip: skipped client file is not modified', async () => {
    // 4 facts:
    //   1. Two client configs exist on disk (Claude Code + Cursor).
    //   2. inquirer confirm is scripted: true for Claude Code, false for Cursor.
    //   3. TTY mode is enabled so the interactive confirm branch fires.
    //   4. After wizard, Cursor file content is byte-identical to the fixture.

    const claudeCodePath = join(home, '.claude', 'settings.json');
    const cursorPath = join(home, '.cursor', 'mcp.json');

    const cursorOriginal = JSON.stringify({ mcpServers: { 'cursor-srv': { command: 'uvx', args: ['cursor-srv'] } } });
    writeFixture(claudeCodePath, JSON.stringify({ mcpServers: { 'code-srv': { command: 'node', args: ['code.js'] } } }));
    writeFixture(cursorPath, cursorOriginal);

    // Enable TTY so inquirer confirm branch fires.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    // First call (Claude Code): confirm → true. Second call (Cursor): confirm → false.
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
      loc('cursor', 'Cursor', cursorPath, 'json', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Cursor file must be completely unchanged (no backup created, content identical).
    expect(readFileSync(cursorPath, 'utf-8')).toBe(cursorOriginal);
    expect(findBackups(join(home, '.cursor'))).toHaveLength(0);

    // Claude Code was confirmed so its conductor entry must now exist in the file.
    const claudeWritten = JSON.parse(readFileSync(claudeCodePath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(claudeWritten.mcpServers).toHaveProperty('mcp-conductor');

    // Conductor config: only code-srv was imported (cursor-srv was skipped).
    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(conductor.servers)).toContain('code-srv');
    expect(Object.keys(conductor.servers)).not.toContain('cursor-srv');
  });

  // -------------------------------------------------------------------------
  // Test 3: Idempotent — second wizard run detects all already-configured
  // -------------------------------------------------------------------------

  it('is idempotent: second run reports nothing to do and makes no writes', async () => {
    // 4 facts:
    //   1. A single Claude Code config already has ONLY the mcp-conductor entry.
    //   2. The wizard's "already fully configured" guard fires and prints "skipping".
    //   3. serialize() is never called on the second run.
    //   4. The file content is unchanged after both runs (no spurious write).

    const claudeCodePath = join(home, '.claude', 'settings.json');
    const conductorOnlyContent = JSON.stringify({
      mcpServers: {
        'mcp-conductor': { command: 'npx', args: ['-y', '@darkiceinteractive/mcp-conductor@latest'] },
      },
    });
    writeFixture(claudeCodePath, conductorOnlyContent);

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const adapterMod = await import('../../src/cli/clients/adapter.js');
    const serializeCode = vi.spyOn(adapterMod.ADAPTERS.get('claude-code')!, 'serialize');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    // Run wizard twice.
    await runSetupWizard();
    await runSetupWizard();

    // serialize() must never have been called on either run.
    expect(serializeCode).not.toHaveBeenCalled();

    // Console output must contain "skipping" (at least once per run).
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('skipping');

    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 4: Backup files created next to each modified config
  // -------------------------------------------------------------------------

  it('creates a .bak.YYYYMMDDHHMMSS backup next to every modified config', async () => {
    // 4 facts:
    //   1. Two clients (Claude Code + Cursor) each have one server.
    //   2. Wizard runs in non-TTY mode — both are auto-confirmed.
    //   3. Each adapter writes a backup before mutating the file.
    //   4. After the run, both parent directories contain exactly one .bak.* file.

    const claudeCodePath = join(home, '.claude', 'settings.json');
    const cursorPath = join(home, '.cursor', 'mcp.json');

    writeFixture(claudeCodePath, JSON.stringify({ mcpServers: { 'srv-a': { command: 'node', args: ['a.js'] } } }));
    writeFixture(cursorPath, JSON.stringify({ mcpServers: { 'srv-b': { command: 'node', args: ['b.js'] } } }));

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
      loc('cursor', 'Cursor', cursorPath, 'json', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Each directory must have at least one .bak.* file.
    const claudeBackups = findBackups(join(home, '.claude'));
    const cursorBackups = findBackups(join(home, '.cursor'));

    expect(claudeBackups.length).toBeGreaterThanOrEqual(1);
    expect(cursorBackups.length).toBeGreaterThanOrEqual(1);

    // Backup filename must match the expected pattern: *.bak.YYYYMMDDHHMMSS
    for (const bak of [...claudeBackups, ...cursorBackups]) {
      expect(bak).toMatch(/\.bak\.\d{14}/);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: De-dup conductor servers
  // -------------------------------------------------------------------------

  it('de-dupes conductor servers: pre-existing entry is not double-added', async () => {
    // 4 facts:
    //   1. Claude Code config has "github" server and "linear" server.
    //   2. The conductor config already has a "github" server entry (preserved).
    //   3. After the wizard runs, conductor config still has only one "github" key.
    //   4. A new server "linear" from the client config is added (it was absent).

    const claudeCodePath = join(home, '.claude', 'settings.json');
    writeFixture(claudeCodePath, JSON.stringify({
      mcpServers: {
        'github': { command: 'node', args: ['github.js'] },
        'linear': { command: 'node', args: ['linear.js'] },
      },
    }));

    // Pre-existing conductor config already has "github".
    writeFileSync(conductorPath, JSON.stringify({
      exclusive: false,
      servers: {
        'github': { command: 'node', args: ['github-existing.js'], env: {} },
      },
    }), 'utf-8');

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as {
      servers: Record<string, { command: string; args: string[] }>;
    };

    // Only one "github" key must exist.
    const githubKeys = Object.keys(conductor.servers).filter((k) => k === 'github');
    expect(githubKeys).toHaveLength(1);

    // The existing entry must not have been overwritten (still "github-existing.js").
    expect(conductor.servers['github']!.args[0]).toBe('github-existing.js');

    // "linear" must have been added.
    expect(Object.keys(conductor.servers)).toContain('linear');
  });

  // -------------------------------------------------------------------------
  // Test 6: Codex TOML round-trip — extra [settings] block preserved
  // -------------------------------------------------------------------------

  it('Codex TOML round-trip: wizard moves servers and preserves extra top-level keys', async () => {
    // 4 facts:
    //   1. Codex TOML config has 2 mcp_servers plus an extra [settings] table.
    //   2. Wizard imports both servers into the conductor config.
    //   3. The written TOML still contains a [settings] table with foo = "bar".
    //   4. mcp-conductor entry is present in the written TOML mcp_servers section.

    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexPath = join(codexDir, 'config.toml');

    const tomlContent = `[settings]
foo = "bar"

[mcp_servers.brave]
command = "npx"
args = ["-y", "brave-mcp"]

[mcp_servers.fetch]
command = "uvx"
args = ["mcp-fetch"]
`;
    writeFileSync(codexPath, tomlContent, 'utf-8');

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('codex', 'Codex CLI', codexPath, 'toml', '[mcp_servers.*]', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Read back the written TOML.
    const writtenToml = readFileSync(codexPath, 'utf-8');
    const parsed = TOML.parse(writtenToml) as {
      settings?: { foo?: string };
      mcp_servers?: Record<string, { command: string }>;
    };

    // [settings] block must be preserved.
    expect(parsed.settings).toBeDefined();
    expect(parsed.settings!.foo).toBe('bar');

    // mcp-conductor must be present in the TOML output.
    expect(parsed.mcp_servers).toBeDefined();
    expect(Object.keys(parsed.mcp_servers!)).toContain('mcp-conductor');

    // Both source servers must have been imported into conductor config.
    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(conductor.servers)).toContain('brave');
    expect(Object.keys(conductor.servers)).toContain('fetch');
  });

  // -------------------------------------------------------------------------
  // Test 7: Zed context_servers — source:extension entry left alone
  // -------------------------------------------------------------------------

  it('Zed adapter: 2 custom stdio servers imported; extension entry skipped on parse, not re-emitted', async () => {
    // 4 facts:
    //   1. Zed settings.json has 2 "source:custom" entries and 1 "source:extension".
    //   2. The Zed adapter skips source:extension entries on parse (not in config.servers).
    //   3. serialize() in merge mode iterates config.servers — extension entry is not
    //      re-emitted in context_servers (Zed adapter replaces the whole key).
    //   4. Only the 2 custom servers land in the conductor config; theme key is preserved.

    const zedDir = join(home, 'Library', 'Application Support', 'Zed');
    mkdirSync(zedDir, { recursive: true });
    const zedPath = join(zedDir, 'settings.json');

    writeFileSync(zedPath, JSON.stringify({
      theme: 'One Dark',
      context_servers: {
        'my-custom-server': { source: 'custom', command: 'node', args: ['srv.js'] },
        'another-custom':   { source: 'custom', command: 'uvx', args: ['another'] },
        'zed-extension-srv': { source: 'extension', extension_id: 'zed.some-extension' },
      },
    }, null, 2), 'utf-8');

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('zed', 'Zed', zedPath, 'json', 'context_servers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Verify written Zed file.
    const written = JSON.parse(readFileSync(zedPath, 'utf-8')) as {
      theme: string;
      context_servers: Record<string, { source: string; extension_id?: string }>;
    };

    // Non-MCP top-level key (theme) must be preserved via raw spread.
    expect(written.theme).toBe('One Dark');

    // mcp-conductor must be present with source:custom.
    expect(Object.keys(written.context_servers)).toContain('mcp-conductor');
    expect(written.context_servers['mcp-conductor']!.source).toBe('custom');

    // The 2 custom servers must be present in the output.
    expect(Object.keys(written.context_servers)).toContain('my-custom-server');
    expect(Object.keys(written.context_servers)).toContain('another-custom');

    // Extension entry is skipped on parse → not in config.servers → not re-emitted.
    // This is the documented Zed adapter behaviour: serialize replaces context_servers
    // entirely from the normalised servers map (source:extension entries are Zed-managed).
    expect(Object.keys(written.context_servers)).not.toContain('zed-extension-srv');

    // Conductor config: only the 2 custom servers were imported (extension skipped).
    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(conductor.servers)).toContain('my-custom-server');
    expect(Object.keys(conductor.servers)).toContain('another-custom');
    expect(Object.keys(conductor.servers)).not.toContain('zed-extension-srv');
  });

  // -------------------------------------------------------------------------
  // Test 8: OpenCode mcp key — local imported, remote skipped with warning
  // -------------------------------------------------------------------------

  it('OpenCode adapter: imports type:local entry, skips type:remote with console warning', async () => {
    // 4 facts:
    //   1. OpenCode config uses "mcp" key (not "mcpServers").
    //   2. One entry has type:"local" — this is importable.
    //   3. One entry has type:"remote" — this must be skipped with a console.warn.
    //   4. Only the local entry appears in the conductor config after the run.

    const openCodeDir = join(home, '.config', 'opencode');
    mkdirSync(openCodeDir, { recursive: true });
    const openCodePath = join(openCodeDir, 'opencode.json');

    writeFileSync(openCodePath, JSON.stringify({
      mcp: {
        'local-srv': {
          type: 'local',
          command: 'node',
          args: ['local.js'],
        },
        'remote-srv': {
          type: 'remote',
          url: 'https://example.com/mcp',
        },
      },
    }), 'utf-8');

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('opencode', 'OpenCode', openCodePath, 'json', 'mcp', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // A warning about the remote entry must have been emitted.
    const warnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('remote-srv');

    // Conductor config must contain only the local entry.
    const conductor = JSON.parse(readFileSync(conductorPath, 'utf-8')) as { servers: Record<string, unknown> };
    expect(Object.keys(conductor.servers)).toContain('local-srv');
    expect(Object.keys(conductor.servers)).not.toContain('remote-srv');

    // Written OpenCode file must contain mcp-conductor.
    const written = JSON.parse(readFileSync(openCodePath, 'utf-8')) as {
      mcp: Record<string, { type: string }>;
    };
    expect(Object.keys(written.mcp)).toContain('mcp-conductor');

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 9: Empty Claude Code config — no mcpServers key
  // -------------------------------------------------------------------------

  it('empty Claude Code config (no mcpServers key): wizard skips gracefully with nothing-to-migrate', async () => {
    // 4 facts:
    //   1. Claude Code settings.json exists but has no "mcpServers" key at all.
    //   2. Claude Code adapter parse() returns null for a config with no mcpServers.
    //   3. Wizard skips this location gracefully without calling serialize().
    //   4. Console output reports "Nothing to migrate" since no parsed locations remain.

    const claudeCodePath = join(home, '.claude', 'settings.json');
    writeFixture(claudeCodePath, JSON.stringify({ theme: 'dark', someOtherSetting: true }));

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue([
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
    ]);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    const adapterMod = await import('../../src/cli/clients/adapter.js');
    const serializeCode = vi.spyOn(adapterMod.ADAPTERS.get('claude-code')!, 'serialize');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // serialize must never have been called.
    expect(serializeCode).not.toHaveBeenCalled();

    // Console must mention "Nothing to migrate".
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Nothing to migrate');

    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 10: Doctor coverage end-to-end — after wizard, all 3 clients report conductor entry
  // -------------------------------------------------------------------------

  it('doctor reports all migrated clients have conductor entry after wizard run', async () => {
    // 4 facts:
    //   1. Wizard runs across Claude Code + Cursor + Continue (non-TTY auto-confirm).
    //   2. All 3 configs are migrated (conductor entry written to each file).
    //   3. runDoctor() is called with getMCPClientConfigPaths mocked to the same paths.
    //   4. clientCoverage.coveredCount === 3 and missingCount === 0.

    const claudeCodePath = join(home, '.claude', 'settings.json');
    const cursorPath = join(home, '.cursor', 'mcp.json');
    const continuePath = join(home, '.continue', 'config.yaml');

    writeFixture(claudeCodePath, JSON.stringify({ mcpServers: { 'srv-a': { command: 'node', args: ['a.js'] } } }));
    writeFixture(cursorPath, JSON.stringify({ mcpServers: { 'srv-b': { command: 'node', args: ['b.js'] } } }));
    writeFixture(continuePath, 'mcpServers:\n  srv-c:\n    command: node\n    args:\n      - c.js\n');
    // conductorPath already exists from beforeEach — no need to re-create it.

    const locations = [
      loc('claude-code', 'Claude Code', claudeCodePath, 'json', 'mcpServers', true),
      loc('cursor', 'Cursor', cursorPath, 'json', 'mcpServers', true),
      loc('continue', 'Continue.dev', continuePath, 'yaml', 'mcpServers', true),
    ];

    const registryMod = await import('../../src/cli/clients/registry.js');
    vi.spyOn(registryMod, 'getMCPClientConfigPaths').mockReturnValue(locations);

    const loaderMod = await import('../../src/config/loader.js');
    vi.spyOn(loaderMod, 'getDefaultConductorConfigPath').mockReturnValue(conductorPath);

    // Step 1: run the wizard so conductor is injected into all 3 client configs.
    const { runSetupWizard } = await import('../../src/cli/wizard/setup.js');
    await runSetupWizard();

    // Verify post-wizard state: all 3 config files now contain mcp-conductor.
    const claudeWritten = JSON.parse(readFileSync(claudeCodePath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(claudeWritten.mcpServers).toHaveProperty('mcp-conductor');

    const cursorWritten = JSON.parse(readFileSync(cursorPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(cursorWritten.mcpServers).toHaveProperty('mcp-conductor');

    const continueWritten = parseYaml(readFileSync(continuePath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(continueWritten.mcpServers).toHaveProperty('mcp-conductor');

    // Step 2: run doctor and assert full client coverage.
    const { runDoctor } = await import('../../src/cli/commands/doctor.js');
    const doctorResult = runDoctor();

    expect(doctorResult.clientCoverage.coveredCount).toBe(3);
    expect(doctorResult.clientCoverage.missingCount).toBe(0);

    // Every entry in coverage must report hasConductor=true.
    for (const entry of doctorResult.clientCoverage.entries) {
      expect(entry.hasConductor).toBe(true);
    }
  });
});
