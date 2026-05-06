/**
 * MCPClientAdapter implementation for Google Gemini CLI.
 *
 * Gemini CLI stores MCP server definitions in:
 *   - Global:  ~/.gemini/settings.json
 *   - Project: .gemini/settings.json  (relative to cwd)
 *
 * Config schema (synthetic example):
 * ```json
 * {
 *   "mcpServers": {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["dist/server.js"],
 *       "env": { "KEY": "value" },
 *       "timeout": 30000,
 *       "includeTools": ["tool_a"],
 *       "excludeTools": ["tool_b"]
 *     }
 *   }
 * }
 * ```
 *
 * Extra per-server fields (`timeout`, `includeTools`, `excludeTools`, and any
 * future additions) are preserved verbatim in `config.raw` and round-tripped
 * back to disk during serialize() when `keepOnlyConductor` is false.
 *
 * All non-`mcpServers` top-level keys (e.g. model settings, theme) are also
 * preserved unchanged.
 *
 * @module cli/clients/gemini-cli
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';
import { ADAPTERS } from './adapter.js';
import { createBackup } from '../../utils/backup.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Raw per-server shape as Gemini CLI writes it. */
interface RawGeminiServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Gemini-specific extras — preserved verbatim on round-trips.
  timeout?: number;
  includeTools?: string[];
  excludeTools?: string[];
  // Any other future fields Gemini CLI might add.
  [key: string]: unknown;
}

/** The full raw Gemini settings.json shape. */
interface RawGeminiConfig {
  mcpServers?: Record<string, RawGeminiServer>;
  // All other top-level keys (model, theme, etc.) are preserved as-is.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw Gemini server entry into the conductor's normalised shape.
 *
 * Only `command`, `args`, and `env` are promoted to the normalised entry; all
 * other fields remain in `raw` and are reinjected verbatim during serialize().
 */
function normaliseEntry(raw: RawGeminiServer): NormalisedServerEntry {
  const entry: NormalisedServerEntry = { command: raw.command };
  if (raw.args !== undefined) entry.args = raw.args;
  if (raw.env !== undefined) entry.env = raw.env;
  return entry;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const GEMINI_CLI_ADAPTER_IMPL: MCPClientAdapter = {
  client: 'gemini-cli',

  /**
   * Parse a Gemini CLI settings.json file into the normalised shape.
   *
   * Returns `null` when the file does not exist, cannot be parsed as JSON, or
   * contains no `mcpServers` key.
   */
  parse(path: string): NormalisedClientConfig | null {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // File does not exist or is not readable.
      return null;
    }

    let raw: RawGeminiConfig;
    try {
      raw = JSON.parse(text) as RawGeminiConfig;
    } catch {
      // Malformed JSON — skip gracefully.
      return null;
    }

    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') {
      return null;
    }

    const servers: Record<string, NormalisedServerEntry> = {};
    for (const [name, serverRaw] of Object.entries(raw.mcpServers)) {
      if (!serverRaw || typeof serverRaw.command !== 'string') continue;
      servers[name] = normaliseEntry(serverRaw);
    }

    return { servers, raw };
  },

  /**
   * Write a (potentially modified) config back to disk.
   *
   * Before writing, a `.bak.YYYYMMDDHHMMSS` copy of the existing file is
   * created via `createBackup()`.  If the file did not previously exist no
   * backup is attempted.
   *
   * When `keepOnlyConductor` is true, only the `mcp-conductor` entry is
   * written to `mcpServers`; all other server definitions are dropped.
   *
   * When `keepOnlyConductor` is false, all servers from `config.servers` are
   * written back, and per-server extra fields (`timeout`, `includeTools`,
   * `excludeTools`, …) from `config.raw` are preserved verbatim.
   */
  serialize(
    path: string,
    config: NormalisedClientConfig,
    options: SerializeOptions,
  ): void {
    const raw = config.raw as RawGeminiConfig;

    // Back up the existing file before mutation (if it already exists).
    try {
      createBackup(path);
    } catch {
      // File did not previously exist — no backup needed, proceed with write.
    }

    let mcpServers: Record<string, unknown>;

    if (options.keepOnlyConductor) {
      // Migration flow: strip all other servers, keep only conductor.
      mcpServers = {
        'mcp-conductor': { ...options.conductorEntry },
      };
    } else {
      // Full round-trip: rebuild mcpServers from the normalised map while
      // preserving extra per-server fields that were in the original config.
      const rawServers = raw.mcpServers ?? {};
      mcpServers = {};

      for (const [name, entry] of Object.entries(config.servers)) {
        const originalRaw: Record<string, unknown> = (rawServers[name] as Record<string, unknown>) ?? {};
        // Start with original raw (preserves timeout, includeTools, etc.),
        // then overlay the normalised fields so they are always up to date.
        mcpServers[name] = {
          ...originalRaw,
          command: entry.command,
          ...(entry.args !== undefined ? { args: entry.args } : {}),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
        };
      }

      // Ensure the conductor entry is always present and up to date.
      const existingConductorRaw: Record<string, unknown> =
        (rawServers['mcp-conductor'] as Record<string, unknown>) ?? {};
      mcpServers['mcp-conductor'] = {
        ...existingConductorRaw,
        command: options.conductorEntry.command,
        ...(options.conductorEntry.args !== undefined
          ? { args: options.conductorEntry.args }
          : {}),
        ...(options.conductorEntry.env !== undefined
          ? { env: options.conductorEntry.env }
          : {}),
      };
    }

    // Build the output object: preserve all non-mcpServers top-level keys.
    const output: Record<string, unknown> = { ...raw, mcpServers };

    writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf8');
  },
};

// ---------------------------------------------------------------------------
// Export + auto-registration
// ---------------------------------------------------------------------------

/**
 * The Gemini CLI adapter singleton.
 *
 * Importing this module automatically registers the adapter in `ADAPTERS` so
 * the wizard and doctor commands can discover it without explicitly referencing
 * this module.
 */
export const GEMINI_CLI_ADAPTER = GEMINI_CLI_ADAPTER_IMPL;

// Self-register at module load time.
ADAPTERS.set('gemini-cli', GEMINI_CLI_ADAPTER_IMPL);
