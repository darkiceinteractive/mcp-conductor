/**
 * MCPClientAdapter implementation for Claude Desktop.
 *
 * Claude Desktop stores its MCP server list in a JSON file under:
 *   - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Linux:   ~/.config/claude/claude_desktop_config.json
 *   - Windows: %APPDATA%\Claude\claude_desktop_config.json
 *
 * The schema is identical to the canonical Anthropic MCP format:
 *   { mcpServers: { "<name>": { command, args?, env? } } }
 *
 * This adapter auto-registers in the ADAPTERS singleton at module load time
 * so consumers only need to import this file as a side-effect.
 *
 * @module cli/clients/claude-desktop
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeJsonParse } from '../../utils/index.js';
import { writeBackup } from '../commands/import-servers.js';
import { ADAPTERS } from './index.js';
import type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';

// ---------------------------------------------------------------------------
// Internal shape of claude_desktop_config.json
// ---------------------------------------------------------------------------

interface RawDesktopEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RawDesktopConfig {
  mcpServers?: Record<string, RawDesktopEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * MCPClientAdapter for Claude Desktop.
 *
 * Reads and writes `claude_desktop_config.json` in the canonical Anthropic
 * `{ command, args, env }` format under the `mcpServers` key.  All non-MCP
 * top-level keys in the config file are preserved verbatim on every write.
 */
export const CLAUDE_DESKTOP_ADAPTER: MCPClientAdapter = {
  client: 'claude-desktop',

  /**
   * Parse `claude_desktop_config.json` at `path` into normalised form.
   *
   * Returns `null` when:
   * - the file does not exist
   * - the file is not valid JSON
   * - the file has no `mcpServers` key (or the key is empty)
   *
   * The original parsed object is stored in `raw` for round-trip writes.
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) {
      return null;
    }

    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }

    const raw = safeJsonParse<RawDesktopConfig>(content, {});

    const mcpServers = raw.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object') {
      return null;
    }

    const servers: Record<string, NormalisedServerEntry> = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (typeof entry.command !== 'string') {
        // Skip malformed entries rather than crashing.
        continue;
      }
      servers[name] = {
        command: entry.command,
        ...(Array.isArray(entry.args) && { args: entry.args }),
        ...(entry.env && typeof entry.env === 'object' && { env: entry.env }),
      };
    }

    return { servers, raw };
  },

  /**
   * Write a (possibly modified) config back to `path`.
   *
   * Steps:
   * 1. If the file exists, write a `.bak.YYYYMMDDHHMMSS` backup first.
   * 2. Determine the server map to persist:
   *    - `keepOnlyConductor: true` → only `{ "mcp-conductor": conductorEntry }`
   *    - otherwise → merge `config.servers` with `conductorEntry` under
   *      `"mcp-conductor"` (conductorEntry always wins for that key).
   * 3. Overlay the resulting `mcpServers` onto `config.raw`, preserving every
   *    other top-level key unchanged.
   * 4. Write the resulting JSON with 2-space indentation and a trailing newline.
   *
   * Creates parent directories if they do not yet exist (first-time install).
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    const { keepOnlyConductor, conductorEntry } = options;

    // Write a backup before touching the original (only when it already exists).
    if (existsSync(path)) {
      writeBackup(path);
    }

    // Build the mcpServers map to persist.
    const mcpServers: Record<string, NormalisedServerEntry> = keepOnlyConductor
      ? { 'mcp-conductor': conductorEntry }
      : { ...config.servers, 'mcp-conductor': conductorEntry };

    // Merge into the raw object so non-MCP keys are preserved.
    const raw =
      typeof config.raw === 'object' && config.raw !== null
        ? (config.raw as Record<string, unknown>)
        : {};
    const output: Record<string, unknown> = { ...raw, mcpServers };

    // Ensure parent directories exist (first-time write on a fresh install).
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  },
};

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

// Register at module load time so any side-effect importer of this file gets
// the adapter into the ADAPTERS map without needing an explicit call.
ADAPTERS.set('claude-desktop', CLAUDE_DESKTOP_ADAPTER);
