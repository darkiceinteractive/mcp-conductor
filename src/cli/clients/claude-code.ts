/**
 * MCPClientAdapter implementation for Claude Code.
 *
 * Claude Code stores MCP servers under the canonical Anthropic `mcpServers` key
 * in a JSON settings file, so parse() reads the key directly without any field
 * translation, and serialize() writes it back in the same shape.
 *
 * The adapter registers itself in `ADAPTERS` at module load time; callers only
 * need to `import './claude-code.js'` (done in `index.ts`) to enable it.
 *
 * @module cli/clients/claude-code
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import type { MCPClientAdapter, NormalisedClientConfig, SerializeOptions } from './adapter.js';
import { ADAPTERS } from './adapter.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a `.bak.YYYYMMDDHHMMSS` path alongside `filePath` and copy the
 * original file to it.
 *
 * Matches the same strategy as `writeBackup` in
 * `src/cli/commands/import-servers.ts`:
 * - Derive a 14-digit UTC timestamp from ISO string.
 * - Guard against sub-second collisions with a 4-char hex salt.
 *
 * @returns The path of the backup file written.
 */
function writeBackup(filePath: string): string {
  // toISOString() → "2026-05-05T11:23:45.678Z"; strip non-digits, take first 14.
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let backupPath = `${filePath}.bak.${ts}`;

  // Sub-second collision guard.
  if (existsSync(backupPath)) {
    const salt = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    backupPath = `${backupPath}.${salt}`;
  }

  copyFileSync(filePath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * The shape expected inside a Claude Code settings JSON file.
 * Only `mcpServers` is structured; everything else is opaque pass-through data.
 */
interface ClaudeCodeConfigShape {
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
  [key: string]: unknown;
}

export const CLAUDE_CODE_ADAPTER: MCPClientAdapter = {
  client: 'claude-code',

  /**
   * Parse the Claude Code settings file at `path`.
   *
   * Returns `null` when the file does not exist, is not valid JSON, or contains
   * no `mcpServers` entries — allowing callers to skip gracefully.
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) {
      return null;
    }

    let raw: ClaudeCodeConfigShape;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeCodeConfigShape;
    } catch {
      return null;
    }

    const mcpServers = raw.mcpServers;
    if (
      !mcpServers ||
      typeof mcpServers !== 'object' ||
      Object.keys(mcpServers).length === 0
    ) {
      return null;
    }

    // Claude Code uses the canonical Anthropic shape — no field translation needed.
    const servers: NormalisedClientConfig['servers'] = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (entry && typeof entry.command === 'string') {
        servers[name] = {
          command: entry.command,
          ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: entry.env } : {}),
        };
      }
    }

    return { servers, raw };
  },

  /**
   * Write the (potentially modified) config back to disk at `path`.
   *
   * Steps:
   * 1. Write a `.bak.YYYYMMDDHHMMSS` backup if the file already exists.
   * 2. Start from `config.raw` so non-MCP keys (e.g. `apiKeyHelper`) are kept.
   * 3. If `keepOnlyConductor` is set, replace `mcpServers` with just the
   *    conductor entry; otherwise write the full `config.servers` map and
   *    ensure `"mcp-conductor"` is present and up-to-date.
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    if (existsSync(path)) {
      writeBackup(path);
    }

    // Clone raw to avoid mutating the caller's in-memory config.
    const output = { ...(config.raw as Record<string, unknown>) };

    let mcpServers: Record<string, unknown>;

    if (options.keepOnlyConductor) {
      mcpServers = { 'mcp-conductor': options.conductorEntry };
    } else {
      // Spread existing servers then overlay the conductor entry.
      mcpServers = { ...(config.servers as Record<string, unknown>) };
      mcpServers['mcp-conductor'] = options.conductorEntry;
    }

    output['mcpServers'] = mcpServers;

    writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  },
};

// Side-effect registration: runs when this module is first imported.
ADAPTERS.set('claude-code', CLAUDE_CODE_ADAPTER);
