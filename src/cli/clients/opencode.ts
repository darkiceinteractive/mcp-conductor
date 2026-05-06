/**
 * MCPClientAdapter implementation for OpenCode.
 *
 * Key divergences from the Claude-family adapters:
 *
 * 1. MCP key is `mcp` (NOT `mcpServers`).
 * 2. Every server entry carries a required `type` field — either `"local"` or
 *    `"remote"`.  Remote entries are not importable (skipped with a warning).
 * 3. An optional `enabled` boolean may be present; disabled entries are still
 *    importable but the flag is preserved in `raw` so round-trip writes retain it.
 *
 * Config file locations (verified against OpenCode v0.1.x):
 * - Global (macOS / Linux): `~/.config/opencode/opencode.json`
 * - Global (Windows):       `%APPDATA%\opencode\opencode.json`
 * - Project-local:          `./opencode.json`
 *
 * @module cli/clients/opencode
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { safeJsonParse } from '../../utils/index.js';
import type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';

// ---------------------------------------------------------------------------
// Raw OpenCode shape types
// ---------------------------------------------------------------------------

interface OpenCodeLocalEntry {
  type: 'local';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface OpenCodeRemoteEntry {
  type: 'remote';
  [key: string]: unknown;
}

type OpenCodeEntry = OpenCodeLocalEntry | OpenCodeRemoteEntry;

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Backup helper (mirrors writeBackup pattern from import-servers.ts)
// ---------------------------------------------------------------------------

/**
 * Write a `.bak.YYYYMMDDHHMMSS` backup alongside `filePath`.
 * A random 4-char hex suffix is appended on sub-second collision.
 */
function writeBackup(filePath: string): string {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let backupPath = `${filePath}.bak.${ts}`;

  if (existsSync(backupPath)) {
    const salt = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    backupPath = `${backupPath}.${salt}`;
  }

  copyFileSync(filePath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const OPENCODE_ADAPTER: MCPClientAdapter = {
  client: 'opencode',

  /**
   * Parse an OpenCode config file into the normalised shape.
   *
   * - Iterates `mcp.*` (note: key is `mcp`, not `mcpServers`).
   * - Skips `type: "remote"` entries with a console.warn (not importable).
   * - `type: "local"` entries are normalised to `{command, args, env}`.
   * - `enabled: false` is preserved in the underlying `raw` object so
   *   serialize() can round-trip it faithfully without touching NormalisedServerEntry.
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) return null;

    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }

    const raw = safeJsonParse<OpenCodeConfig>(content, {});
    const mcpMap = raw.mcp;

    if (!mcpMap || typeof mcpMap !== 'object') {
      return null;
    }

    const servers: Record<string, NormalisedServerEntry> = {};
    let localCount = 0;

    for (const [name, entry] of Object.entries(mcpMap)) {
      if (entry.type === 'remote') {
        console.warn(
          `[opencode adapter] Skipping "${name}": type "remote" entries cannot be imported (only "local" is supported).`,
        );
        continue;
      }

      if (entry.type === 'local') {
        localCount++;
        servers[name] = {
          command: entry.command,
          ...(entry.args !== undefined ? { args: entry.args } : {}),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
        };
        // enabled flag stays in raw — not copied into NormalisedServerEntry to
        // avoid changing the shared interface. serialize() reads it back from raw.
      }
    }

    // Return null when there were no local entries at all (nothing importable).
    if (localCount === 0) {
      return null;
    }

    return { servers, raw };
  },

  /**
   * Write a (potentially modified) OpenCode config back to disk.
   *
   * Rules:
   * 1. Always injects `type: "local"` on every serialised entry.
   * 2. Ensures `mcp-conductor` is present with `conductorEntry`.
   * 3. If `keepOnlyConductor` is true, replaces `mcp` with a single entry.
   * 4. Preserves all other top-level OpenCode keys from `config.raw`.
   * 5. Preserves `enabled: false` from the original raw entry on round-trip.
   * 6. Writes a `.bak.YYYYMMDDHHMMSS` backup before overwriting.
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    // Write backup first if file already exists.
    if (existsSync(path)) {
      writeBackup(path);
    }

    const existingRaw = (config.raw as OpenCodeConfig) ?? {};

    // Build the mcp map to write.
    let mcpToWrite: Record<string, OpenCodeLocalEntry>;

    if (options.keepOnlyConductor) {
      mcpToWrite = {
        'mcp-conductor': {
          type: 'local',
          command: options.conductorEntry.command,
          ...(options.conductorEntry.args !== undefined ? { args: options.conductorEntry.args } : {}),
          ...(options.conductorEntry.env !== undefined ? { env: options.conductorEntry.env } : {}),
        },
      };
    } else {
      mcpToWrite = {};

      // Carry through existing normalised servers, injecting type: "local".
      for (const [name, entry] of Object.entries(config.servers)) {
        // Retrieve the enabled flag from raw if present so it survives round-trip.
        const rawEntry = existingRaw.mcp?.[name] as OpenCodeLocalEntry | undefined;
        mcpToWrite[name] = {
          type: 'local',
          command: entry.command,
          ...(entry.args !== undefined ? { args: entry.args } : {}),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
          ...(rawEntry?.enabled === false ? { enabled: false } : {}),
        };
      }

      // Ensure conductor entry is present / updated.
      mcpToWrite['mcp-conductor'] = {
        type: 'local',
        command: options.conductorEntry.command,
        ...(options.conductorEntry.args !== undefined ? { args: options.conductorEntry.args } : {}),
        ...(options.conductorEntry.env !== undefined ? { env: options.conductorEntry.env } : {}),
      };
    }

    // Merge into a copy of raw, preserving all non-mcp top-level keys.
    const output: OpenCodeConfig = {
      ...existingRaw,
      mcp: mcpToWrite,
    };

    writeFileSync(path, JSON.stringify(output, null, 2), 'utf-8');
  },
};
