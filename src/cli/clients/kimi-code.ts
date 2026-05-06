/**
 * MCPClientAdapter for Kimi Code (Moonshot AI).
 *
 * Kimi Code stores MCP server definitions in a JSON file whose location varies
 * by platform (see registry.ts).  The config uses the Anthropic-compatible
 * `mcpServers` shape, so entries are either stdio (`{command, args, env}`) or
 * HTTP (`{url, headers}`).
 *
 * HTTP entries cannot be proxied through conductor's stdio process.  They are
 * skipped during normalisation and flagged with a logged warning so the caller
 * can surface actionable guidance to the user.
 *
 * The CLI also accepts `--mcp-config-file <path>` so users may point it at an
 * arbitrary Anthropic-format config (e.g. a symlink to a Claude config).  This
 * adapter works with any path that carries an `mcpServers` top-level key.
 *
 * 4-fact preamble:
 *   1. Config format: JSON with top-level `mcpServers` key.
 *   2. Stdio shape: `{ command, args?, env? }` — Anthropic-compatible.
 *   3. HTTP shape: `{ url, headers? }` — skipped with warning; carried in `raw`.
 *   4. Backup: `.bak.YYYYMMDDHHMMSS` written before every serialize() call.
 *
 * @module cli/clients/kimi-code
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';
import type { MCPClientId } from './registry.js';

// ---------------------------------------------------------------------------
// Internal types (raw Kimi Code JSON shapes)
// ---------------------------------------------------------------------------

interface KimiStdioEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface KimiHttpEntry {
  url: string;
  headers?: Record<string, string>;
}

type KimiServerEntry = KimiStdioEntry | KimiHttpEntry;

interface KimiConfig {
  mcpServers?: Record<string, KimiServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isHttpEntry(entry: KimiServerEntry): entry is KimiHttpEntry {
  return typeof (entry as KimiHttpEntry).url === 'string';
}

function isStdioEntry(entry: KimiServerEntry): entry is KimiStdioEntry {
  return typeof (entry as KimiStdioEntry).command === 'string';
}

// ---------------------------------------------------------------------------
// Backup helper (mirrors writeBackup in import-servers.ts)
//
// Writes a `.bak.YYYYMMDDHHMMSS` file next to the original.  A random 4-char
// hex suffix guards against sub-second collisions on repeat calls.
// ---------------------------------------------------------------------------

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

/**
 * MCPClientAdapter for Kimi Code.
 *
 * Exported as a named constant (singleton object literal) — stateless, so no
 * class instance overhead is needed.
 */
export const KIMI_CODE_ADAPTER: MCPClientAdapter = {
  client: 'kimi-code' as MCPClientId,

  /**
   * Parse the Kimi Code config at `path`.
   *
   * - Returns `null` when the file does not exist, cannot be read, or contains
   *   no `mcpServers` key.
   * - HTTP entries are warned about and excluded from `servers` but their raw
   *   data remains accessible via `config.raw` for diagnostics.
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) {
      logger.debug('kimi-code: config file not found', { path });
      return null;
    }

    let raw: KimiConfig;
    try {
      const text = readFileSync(path, 'utf-8');
      raw = JSON.parse(text) as KimiConfig;
    } catch (err) {
      logger.warn('kimi-code: failed to parse config file', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!raw.mcpServers || Object.keys(raw.mcpServers).length === 0) {
      logger.debug('kimi-code: config contains no mcpServers', { path });
      return null;
    }

    const servers: Record<string, NormalisedServerEntry> = {};

    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      if (isHttpEntry(entry)) {
        // HTTP entries cannot be proxied via conductor's stdio transport.
        logger.warn(
          'kimi-code: skipping HTTP entry — conductor cannot proxy HTTP MCP servers via stdio; ' +
          'remove or migrate this entry to a stdio server',
          { server: name, url: entry.url },
        );
        // Entry stays in `raw` so serialize() preserves it for the user.
        continue;
      }

      if (isStdioEntry(entry)) {
        servers[name] = {
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env ?? {},
        };
        continue;
      }

      // Unknown shape — skip silently with a debug note.
      logger.debug('kimi-code: unrecognised server entry shape, skipping', { server: name });
    }

    return { servers, raw };
  },

  /**
   * Write the (possibly modified) config back to disk.
   *
   * Algorithm:
   * 1. Write a `.bak.YYYYMMDDHHMMSS` backup if the file currently exists.
   * 2. Start from `config.raw` to preserve all non-MCP top-level keys.
   * 3. If `keepOnlyConductor` is set, replace `mcpServers` with only the
   *    conductor entry — all other server entries (including HTTP ones) are
   *    dropped.
   * 4. Otherwise merge the normalised servers back in.  HTTP entries that were
   *    in the original raw remain intact because they live in `raw.mcpServers`
   *    and are not deleted during normalisation.
   * 5. Upsert `options.conductorEntry` under the `"mcp-conductor"` key.
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    // Step 1: backup existing file before any mutation.
    if (existsSync(path)) {
      const backupPath = writeBackup(path);
      logger.debug('kimi-code: backup written', { backup: backupPath });
    }

    // Step 2: clone raw to avoid mutating the caller's object.
    const output: KimiConfig = { ...(config.raw as KimiConfig) };

    if (options.keepOnlyConductor) {
      // Step 3: replace mcpServers entirely — only the conductor entry survives.
      output['mcpServers'] = {
        'mcp-conductor': buildStdioEntry(options.conductorEntry),
      };
    } else {
      // Step 4: merge normalised servers into the existing raw mcpServers map.
      // Raw already contains HTTP entries; we overwrite/add stdio entries from
      // config.servers and then upsert the conductor entry.
      const merged: Record<string, KimiServerEntry> = {
        ...((config.raw as KimiConfig).mcpServers ?? {}),
      };

      for (const [name, entry] of Object.entries(config.servers)) {
        merged[name] = buildStdioEntry(entry);
      }

      // Step 5: upsert conductor entry.
      merged['mcp-conductor'] = buildStdioEntry(options.conductorEntry);

      output['mcpServers'] = merged;
    }

    writeFileSync(path, JSON.stringify(output, null, 2), 'utf-8');
    logger.debug('kimi-code: config written', { path });
  },
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build a KimiStdioEntry from a NormalisedServerEntry, omitting optional
 * fields when they are empty so the written JSON stays clean.
 */
function buildStdioEntry(entry: NormalisedServerEntry): KimiStdioEntry {
  const result: KimiStdioEntry = { command: entry.command };
  if (entry.args !== undefined && entry.args.length > 0) {
    result.args = entry.args;
  }
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
    result.env = entry.env;
  }
  return result;
}
