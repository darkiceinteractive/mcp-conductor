/**
 * MCP client adapter for Zed editor.
 *
 * Zed stores context server (MCP) configuration under the `context_servers`
 * key inside its main settings file.  Each entry uses a source-typed shape:
 *
 *   "context_servers": {
 *     "my-server": {
 *       "source": "custom",   // only this source is user-controllable
 *       "command": "node",
 *       "args": ["server.js"],
 *       "env": {}
 *     }
 *   }
 *
 * Entries whose `source` is not `"custom"` (e.g. `"extension"`) are managed
 * by Zed itself and are skipped on parse (with a warning) and never written
 * back on serialise.
 *
 * Config file locations (resolved by the registry):
 *   macOS  : ~/Library/Application Support/Zed/settings.json
 *   Linux  : ~/.config/zed/settings.json
 *   Windows: %LOCALAPPDATA%\Zed\settings.json
 *
 * Format note: Zed's settings.json is standard JSON.  If the file cannot be
 * parsed (e.g. it contains comments / JSON5 syntax), `parse()` returns `null`
 * and logs the error so the caller can skip gracefully rather than crashing.
 *
 * @module cli/clients/zed
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger } from '../../utils/logger.js';
import { backupFile } from '../../utils/backup.js';
import type { MCPClientAdapter, NormalisedClientConfig, SerializeOptions } from './adapter.js';

// ---------------------------------------------------------------------------
// Internal shape for a raw Zed context_servers entry
// ---------------------------------------------------------------------------

interface ZedServerEntry {
  source: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const ZED_ADAPTER_IMPL: MCPClientAdapter = {
  client: 'zed',

  parse(path: string): NormalisedClientConfig | null {
    let raw: unknown;

    // --- Read & parse ---
    try {
      const text = readFileSync(path, 'utf8');
      raw = JSON.parse(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File does not exist — caller will skip gracefully.
        return null;
      }
      // File exists but is not parseable (JSON5 / comments / corruption).
      logger.warn('zed adapter: failed to parse config file', {
        path,
        error: String(err),
        hint: 'Zed settings.json must be valid JSON. If it contains comments or JSON5 syntax, remove them and retry.',
      });
      return null;
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      logger.warn('zed adapter: config root is not a JSON object', { path });
      return null;
    }

    const root = raw as Record<string, unknown>;
    const contextServers = root['context_servers'];

    // --- No MCP section — return empty servers map so callers can still write ---
    if (contextServers === undefined) {
      return { servers: {}, raw };
    }

    if (
      typeof contextServers !== 'object' ||
      contextServers === null ||
      Array.isArray(contextServers)
    ) {
      logger.warn('zed adapter: context_servers is not an object', { path });
      return { servers: {}, raw };
    }

    const csMap = contextServers as Record<string, unknown>;
    const servers: NormalisedClientConfig['servers'] = {};

    for (const [name, entry] of Object.entries(csMap)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        logger.warn('zed adapter: skipping malformed context_servers entry', { name, path });
        continue;
      }

      const e = entry as ZedServerEntry;

      // Skip non-custom sources (e.g. "extension" — Zed-managed, not editable by users).
      if (e['source'] !== 'custom') {
        logger.warn('zed adapter: skipping non-custom source entry', {
          name,
          source: e['source'] ?? '(missing)',
          path,
        });
        continue;
      }

      if (typeof e['command'] !== 'string' || e['command'].length === 0) {
        logger.warn('zed adapter: skipping entry with missing or empty command', { name, path });
        continue;
      }

      servers[name] = {
        command: e['command'],
        ...(Array.isArray(e['args']) && e['args'].length > 0
          ? { args: e['args'] as string[] }
          : {}),
        ...(e['env'] != null && typeof e['env'] === 'object'
          ? { env: e['env'] as Record<string, string> }
          : {}),
      };
    }

    return { servers, raw };
  },

  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    const { conductorEntry, keepOnlyConductor } = options;

    // --- Backup before any mutation ---
    backupFile(path);

    // --- Build the conductor entry in Zed's native shape ---
    const conductorShape: ZedServerEntry = {
      source: 'custom',
      command: conductorEntry.command,
      ...(conductorEntry.args && conductorEntry.args.length > 0
        ? { args: conductorEntry.args }
        : {}),
      ...(conductorEntry.env && Object.keys(conductorEntry.env).length > 0
        ? { env: conductorEntry.env }
        : {}),
    };

    // --- Build the context_servers map to write ---
    let contextServers: Record<string, ZedServerEntry>;

    if (keepOnlyConductor) {
      // Migration mode: drop everything except the conductor entry.
      contextServers = { 'mcp-conductor': conductorShape };
    } else {
      // Round-trip mode: re-serialise all normalised servers with source injected.
      contextServers = {};
      for (const [name, entry] of Object.entries(config.servers)) {
        contextServers[name] = {
          source: 'custom',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
          ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
        };
      }
      // Upsert the conductor entry (create or overwrite).
      contextServers['mcp-conductor'] = conductorShape;
    }

    // --- Merge into the raw document, preserving all other top-level keys ---
    // (theme, font_size, vim_mode, language_settings, etc.)
    const rawRoot =
      typeof config.raw === 'object' && config.raw !== null && !Array.isArray(config.raw)
        ? { ...(config.raw as Record<string, unknown>) }
        : {};

    const output: Record<string, unknown> = {
      ...rawRoot,
      context_servers: contextServers,
    };

    // --- Ensure parent directory exists and write ---
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf8');

    logger.debug('zed adapter: wrote config', {
      path,
      serverCount: Object.keys(contextServers).length,
    });
  },
};

/**
 * The singleton Zed MCP client adapter.
 *
 * Registered in `src/cli/clients/index.ts`:
 *
 *   import { ZED_ADAPTER } from './zed.js';
 *   ADAPTERS.set('zed', ZED_ADAPTER);
 */
export const ZED_ADAPTER: MCPClientAdapter = ZED_ADAPTER_IMPL;
