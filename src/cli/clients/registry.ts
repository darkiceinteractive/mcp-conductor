/**
 * Multi-client MCP configuration discovery registry.
 *
 * Provides typed location records for every known MCP-capable client on the
 * current machine.  The list covers macOS, Linux, and Windows search paths
 * from the v3.1.1 verified client table.
 *
 * @module cli/clients/registry
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MCPClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'gemini-cli'
  | 'cursor'
  | 'cline'
  | 'zed'
  | 'continue'
  | 'opencode'
  | 'kimi-code';

export type ConfigFormat = 'json' | 'toml' | 'yaml';

export interface MCPClientConfigLocation {
  /** Stable identifier for the client. */
  client: MCPClientId;
  /** Human-readable label shown in UI / logs. */
  displayName: string;
  /** Absolute path to the config file (may or may not exist). */
  path: string;
  /** Serialisation format of the config file. */
  format: ConfigFormat;
  /**
   * Key (or key path) inside the config that holds the server map.
   * - JSON clients: `"mcpServers"` | `"mcp"` | `"context_servers"`
   * - TOML clients: `"[mcp_servers.*]"` (section prefix)
   */
  mcpKey: string;
  /** Whether the file exists on disk at discovery time. */
  exists: boolean;
  /** Whether this is a user-global config or a project-local config. */
  scope: 'global' | 'project';
}

export interface GetMCPClientConfigPathsOptions {
  /**
   * When `true`, also include project-local config locations resolved from
   * `process.cwd()`.  Defaults to `false`.
   */
  includeProject?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a location record, resolving `exists` at call time.
 */
function loc(
  client: MCPClientId,
  displayName: string,
  path: string,
  format: ConfigFormat,
  mcpKey: string,
  scope: 'global' | 'project' = 'global',
): MCPClientConfigLocation {
  return { client, displayName, path, format, mcpKey, exists: existsSync(path), scope };
}

// ---------------------------------------------------------------------------
// Discovery function
// ---------------------------------------------------------------------------

/**
 * Discover every MCP client config location on this machine.
 *
 * Returns all known locations regardless of whether the file currently exists;
 * callers should filter on `exists` when they only want present files.
 *
 * Platform coverage:
 * - macOS  (darwin)
 * - Linux  (via XDG / home-relative paths)
 * - Windows  (via APPDATA / LOCALAPPDATA)
 */
export function getMCPClientConfigPaths(
  opts: GetMCPClientConfigPathsOptions = {},
): MCPClientConfigLocation[] {
  const home = homedir();
  const platform = process.platform;
  const appData = process.env['APPDATA'] ?? '';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';

  const results: MCPClientConfigLocation[] = [];

  // -------------------------------------------------------------------------
  // Claude Code
  // -------------------------------------------------------------------------
  // macOS / Linux global
  results.push(loc('claude-code', 'Claude Code', join(home, '.claude', 'settings.json'), 'json', 'mcpServers'));
  results.push(loc('claude-code', 'Claude Code', join(home, '.claude.json'), 'json', 'mcpServers'));

  // macOS application support
  if (isMac) {
    results.push(loc('claude-code', 'Claude Code', join(home, 'Library', 'Application Support', 'Claude Code', 'claude_code_config.json'), 'json', 'mcpServers'));
    results.push(loc('claude-code', 'Claude Code', join(home, 'Library', 'Application Support', 'Claude', 'claude_code_config.json'), 'json', 'mcpServers'));
  }

  // Linux XDG
  if (!isWin) {
    results.push(loc('claude-code', 'Claude Code', join(home, '.config', 'Claude Code', 'claude_code_config.json'), 'json', 'mcpServers'));
  }

  // Windows
  if (isWin && appData) {
    results.push(loc('claude-code', 'Claude Code', join(appData, 'Claude Code', 'claude_code_config.json'), 'json', 'mcpServers'));
  }

  // -------------------------------------------------------------------------
  // Claude Desktop
  // -------------------------------------------------------------------------
  if (isMac) {
    results.push(loc('claude-desktop', 'Claude Desktop', join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'json', 'mcpServers'));
  }

  // Linux
  if (!isWin) {
    results.push(loc('claude-desktop', 'Claude Desktop', join(home, '.config', 'claude', 'claude_desktop_config.json'), 'json', 'mcpServers'));
  }

  // Windows
  if (isWin && appData) {
    results.push(loc('claude-desktop', 'Claude Desktop', join(appData, 'Claude', 'claude_desktop_config.json'), 'json', 'mcpServers'));
  }

  // -------------------------------------------------------------------------
  // OpenAI Codex CLI
  // -------------------------------------------------------------------------
  // ~/.codex/config.toml  (all platforms — Codex uses TOML, not JSON)
  results.push(loc('codex', 'Codex CLI', join(home, '.codex', 'config.toml'), 'toml', '[mcp_servers.*]'));

  // -------------------------------------------------------------------------
  // Gemini CLI
  // -------------------------------------------------------------------------
  // ~/.gemini/settings.json  (all platforms)
  results.push(loc('gemini-cli', 'Gemini CLI', join(home, '.gemini', 'settings.json'), 'json', 'mcpServers'));

  // -------------------------------------------------------------------------
  // Cursor
  // -------------------------------------------------------------------------
  if (isMac) {
    results.push(loc('cursor', 'Cursor', join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'), 'json', 'mcp'));
  }
  if (!isWin && !isMac) {
    results.push(loc('cursor', 'Cursor', join(home, '.config', 'Cursor', 'User', 'settings.json'), 'json', 'mcp'));
  }
  if (isWin && appData) {
    results.push(loc('cursor', 'Cursor', join(appData, 'Cursor', 'User', 'settings.json'), 'json', 'mcp'));
  }
  // Global cursor MCP config
  results.push(loc('cursor', 'Cursor', join(home, '.cursor', 'mcp.json'), 'json', 'mcpServers'));

  // -------------------------------------------------------------------------
  // Cline (VS Code extension)
  // -------------------------------------------------------------------------
  // Cline stores its MCP config in the VS Code globalStorage area
  if (isMac) {
    results.push(loc('cline', 'Cline', join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'json', 'mcpServers'));
  }
  if (!isWin && !isMac) {
    results.push(loc('cline', 'Cline', join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'json', 'mcpServers'));
  }
  if (isWin && appData) {
    results.push(loc('cline', 'Cline', join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'json', 'mcpServers'));
  }

  // -------------------------------------------------------------------------
  // Zed
  // -------------------------------------------------------------------------
  if (isMac) {
    results.push(loc('zed', 'Zed', join(home, 'Library', 'Application Support', 'Zed', 'settings.json'), 'json', 'context_servers'));
  }
  if (!isWin && !isMac) {
    results.push(loc('zed', 'Zed', join(home, '.config', 'zed', 'settings.json'), 'json', 'context_servers'));
  }
  if (isWin && localAppData) {
    results.push(loc('zed', 'Zed', join(localAppData, 'Zed', 'settings.json'), 'json', 'context_servers'));
  }

  // -------------------------------------------------------------------------
  // Continue.dev (VS Code / JetBrains extension)
  // -------------------------------------------------------------------------
  results.push(loc('continue', 'Continue.dev', join(home, '.continue', 'config.yaml'), 'yaml', 'mcpServers'));

  // -------------------------------------------------------------------------
  // OpenCode (uses 'mcp' key not 'mcpServers'; file is opencode.json)
  // -------------------------------------------------------------------------
  results.push(loc('opencode', 'OpenCode', join(home, '.config', 'opencode', 'opencode.json'), 'json', 'mcp'));
  if (isWin && appData) {
    results.push(loc('opencode', 'OpenCode', join(appData, 'opencode', 'opencode.json'), 'json', 'mcp'));
  }

  // -------------------------------------------------------------------------
  // Kimi Code (Moonshot AI)
  // -------------------------------------------------------------------------
  if (isMac) {
    results.push(loc('kimi-code', 'Kimi Code', join(home, 'Library', 'Application Support', 'Kimi Code', 'mcp_settings.json'), 'json', 'mcpServers'));
  }
  if (!isWin && !isMac) {
    results.push(loc('kimi-code', 'Kimi Code', join(home, '.config', 'kimi-code', 'mcp_settings.json'), 'json', 'mcpServers'));
  }
  if (isWin && appData) {
    results.push(loc('kimi-code', 'Kimi Code', join(appData, 'Kimi Code', 'mcp_settings.json'), 'json', 'mcpServers'));
  }

  // -------------------------------------------------------------------------
  // Project-local paths (opt-in)
  // -------------------------------------------------------------------------
  if (opts.includeProject) {
    const cwd = process.cwd();

    // Claude Code project-local
    results.push(loc('claude-code', 'Claude Code', join(cwd, '.claude', 'settings.json'), 'json', 'mcpServers', 'project'));
    results.push(loc('claude-code', 'Claude Code', join(cwd, 'claude_code_config.json'), 'json', 'mcpServers', 'project'));
    results.push(loc('claude-code', 'Claude Code', join(cwd, '.mcp.json'), 'json', 'mcpServers', 'project'));

    // Claude Desktop project-local
    results.push(loc('claude-desktop', 'Claude Desktop', join(cwd, 'claude_desktop_config.json'), 'json', 'mcpServers', 'project'));

    // Continue.dev project-local
    results.push(loc('continue', 'Continue.dev', join(cwd, '.continue', 'config.json'), 'json', 'mcpServers', 'project'));

    // OpenCode project-local
    results.push(loc('opencode', 'OpenCode', join(cwd, 'opencode.json'), 'json', 'mcp', 'project'));

    // Codex project-local
    results.push(loc('codex', 'Codex CLI', join(cwd, '.codex', 'config.toml'), 'toml', '[mcp_servers.*]', 'project'));
  }

  return results;
}
