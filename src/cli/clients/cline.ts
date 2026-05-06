/**
 * MCPClientAdapter for Cline (VS Code extension by Saoud Rizwan).
 *
 * Cline stores MCP server definitions in VS Code's per-extension globalStorage
 * directory.  The path is stable as long as the extension ID remains
 * `saoudrizwan.claude-dev`.  If Cline ever changes its extension ID the path
 * returned by the registry becomes stale and the adapter will return `null`
 * from `parse()` (file not found) rather than throwing.
 *
 * Platform paths (registered in `src/cli/clients/registry.ts`):
 *   macOS   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 *   Linux   ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 *   Windows %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json
 *
 * Config shape:
 * ```json
 * {
 *   "mcpServers": {
 *     "<server-name>": {
 *       "command": "node",
 *       "args": ["path/to/server.js"],
 *       "env": { "KEY": "value" }
 *     }
 *   }
 * }
 * ```
 *
 * The format is Anthropic-compatible (same shape as Claude Desktop / Claude
 * Code), so normalisation is straightforward.
 *
 * @module cli/clients/cline
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MCPClientAdapter, NormalisedClientConfig, SerializeOptions } from './adapter.js';
import { writeBackup } from '../../utils/backup.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Raw shape of a single server entry as stored by Cline.
 * Mirrors the Anthropic MCP stdio server format.
 */
interface ClineServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Top-level shape of `cline_mcp_settings.json`.
 *
 * Cline may add other keys in future; we preserve them in `raw` and only
 * touch `mcpServers` during serialisation.
 */
interface ClineConfig {
  mcpServers?: Record<string, ClineServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const clineAdapter: MCPClientAdapter = {
  client: 'cline',

  /**
   * Parse `cline_mcp_settings.json` at `path` into the normalised shape.
   *
   * Returns `null` when:
   * - The file does not exist (Cline not installed or path stale after an
   *   extension-ID change).
   * - The file cannot be parsed as JSON.
   * - `mcpServers` is absent or empty.
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) {
      return null;
    }

    let raw: ClineConfig;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8')) as ClineConfig;
    } catch {
      return null;
    }

    const mcpServers = raw.mcpServers ?? {};
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }

    const servers: NormalisedClientConfig['servers'] = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      servers[name] = {
        command: entry.command,
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.env !== undefined ? { env: entry.env } : {}),
      };
    }

    return { servers, raw };
  },

  /**
   * Write a (potentially modified) config back to `path`.
   *
   * Steps:
   * 1. If the file exists, create a `.bak.YYYYMMDDHHMMSS` backup first.
   * 2. Build the server map: either only the conductor entry
   *    (`keepOnlyConductor: true`) or all servers from `config.servers` with
   *    the conductor entry merged in.
   * 3. Merge the new `mcpServers` map into `config.raw`, preserving any other
   *    top-level keys Cline may have written.
   * 4. Write pretty-printed JSON (2-space indent) to `path`, creating parent
   *    directories if they do not yet exist.
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    // Backup before any destructive operation.
    if (existsSync(path)) {
      writeBackup(path);
    }

    // Build the server map to write.
    const serversToWrite: Record<string, ClineServerEntry> = {};

    if (!options.keepOnlyConductor) {
      // Carry over every server from the normalised config.
      for (const [name, entry] of Object.entries(config.servers)) {
        serversToWrite[name] = {
          command: entry.command,
          ...(entry.args !== undefined ? { args: entry.args } : {}),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
        };
      }
    }

    // Always ensure the conductor entry is present.
    serversToWrite['mcp-conductor'] = {
      command: options.conductorEntry.command,
      ...(options.conductorEntry.args !== undefined ? { args: options.conductorEntry.args } : {}),
      ...(options.conductorEntry.env !== undefined ? { env: options.conductorEntry.env } : {}),
    };

    // Merge into the original raw object so non-MCP keys are preserved.
    const output: ClineConfig = {
      ...(config.raw as ClineConfig),
      mcpServers: serversToWrite,
    };

    // Ensure parent directory exists (first-time setup for users who have
    // never launched Cline on this machine).
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(output, null, 2), 'utf-8');
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Singleton adapter instance for the Cline VS Code extension.
 *
 * Registered in `ADAPTERS` by `src/cli/clients/index.ts` at module load time.
 */
export const CLINE_ADAPTER: MCPClientAdapter = clineAdapter;
