/**
 * MCPClientAdapter for the OpenAI Codex CLI.
 *
 * Codex stores MCP server definitions in TOML format at:
 *   Global:  ~/.codex/config.toml
 *   Project: .codex/config.toml
 *
 * Schema:
 *   [mcp_servers.<name>]
 *   command = "node"
 *   args    = ["server.js"]
 *
 *   [mcp_servers.<name>.env_vars]
 *   KEY = "plain-string-value"          # plain env var → normalised env.KEY
 *
 *   [mcp_servers.<name>.env_vars.KEY]   # remote-source form → dropped with warning
 *   name   = "KEY"
 *   source = "remote"
 *
 * Key divergence from the normalised shape:
 *   - Codex uses `env_vars`, not `env`.
 *   - `env_vars` values can be plain strings OR `{name, source}` objects.
 *     Plain strings  → normalised `env` map.
 *     source="remote" → dropped; warning logged (we don't proxy remote exec).
 *
 * @module cli/clients/codex
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import TOML from '@iarna/toml';
import { writeBackup } from '../../utils/backup.js';
import { ADAPTERS } from './adapter.js';
import type { MCPClientAdapter, NormalisedClientConfig, SerializeOptions } from './adapter.js';

// ---------------------------------------------------------------------------
// Internal types for the raw Codex TOML shape
// ---------------------------------------------------------------------------

/** One env_vars value — either a plain string or a remote-source descriptor object. */
type RawEnvVarsEntry = string | { name?: string; source?: string } | unknown;

interface RawCodexServer {
  command?: string;
  args?: string[];
  env_vars?: Record<string, RawEnvVarsEntry>;
  [key: string]: unknown;
}

interface RawCodexConfig {
  mcp_servers?: Record<string, RawCodexServer>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a Codex `env_vars` map into the normalised `env` map.
 *
 * - Plain string values → `{ KEY: value }`
 * - `{ source: "remote" }` objects → dropped with a console warning.
 * - Any other unexpected shape → dropped silently.
 */
function normaliseEnvVars(
  envVars: Record<string, RawEnvVarsEntry>,
  serverName: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string') {
      env[key] = value;
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'source' in value &&
      (value as Record<string, unknown>)['source'] === 'remote'
    ) {
      // Remote-source env vars require Codex's own remote execution pipeline.
      // mcp-conductor does not proxy remote exec — drop and warn.
      console.warn(
        `[codex-adapter] server "${serverName}": env_vars.${key} has source="remote" ` +
          `— skipped (remote-exec env vars are not supported by mcp-conductor).`,
      );
    }
    // Other unexpected shapes are silently dropped.
  }

  return env;
}

/**
 * Translate the normalised `env` map back to Codex `env_vars` plain-string form.
 */
function denormaliseEnv(env: Record<string, string> | undefined): Record<string, string> {
  return env ?? {};
}

// ---------------------------------------------------------------------------
// CODEX_ADAPTER singleton
// ---------------------------------------------------------------------------

export const CODEX_ADAPTER: MCPClientAdapter = {
  client: 'codex',

  /**
   * Parse `~/.codex/config.toml` (or a project-local equivalent) into the
   * normalised shape.
   *
   * Returns `null` when:
   * - The file does not exist.
   * - The file cannot be parsed as valid TOML.
   * - The file contains no `[mcp_servers]` table (or it is empty).
   */
  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) return null;

    let raw: RawCodexConfig;
    try {
      const content = readFileSync(path, 'utf-8');
      raw = TOML.parse(content) as RawCodexConfig;
    } catch {
      return null;
    }

    const mcpServers = raw.mcp_servers;
    if (
      !mcpServers ||
      typeof mcpServers !== 'object' ||
      Object.keys(mcpServers).length === 0
    ) {
      return null;
    }

    const servers: NormalisedClientConfig['servers'] = {};

    for (const [name, server] of Object.entries(mcpServers)) {
      if (!server || typeof server !== 'object') continue;

      const command = server.command;
      if (typeof command !== 'string' || command.trim() === '') continue;

      const args = Array.isArray(server.args)
        ? server.args.filter((a): a is string => typeof a === 'string')
        : undefined;

      const rawEnvVars = server.env_vars;
      const env =
        rawEnvVars && typeof rawEnvVars === 'object'
          ? normaliseEnvVars(rawEnvVars, name)
          : undefined;

      servers[name] = {
        command,
        ...(args !== undefined && { args }),
        ...(env !== undefined && Object.keys(env).length > 0 && { env }),
      };
    }

    return { servers, raw };
  },

  /**
   * Write the normalised config back to `path` as TOML.
   *
   * 1. Determines which servers to include (all vs. conductor-only).
   * 2. Ensures `conductorEntry` is present under `"mcp-conductor"`.
   * 3. Preserves all non-`mcp_servers` top-level keys from `config.raw`.
   * 4. Creates a `.bak.YYYYMMDDHHMMSS` backup if the file already exists.
   * 5. Serialises to TOML and writes via `writeFileSync`.
   */
  serialize(
    path: string,
    config: NormalisedClientConfig,
    options: SerializeOptions,
  ): void {
    const { keepOnlyConductor, conductorEntry } = options;

    // Preserve non-mcp_servers top-level keys from the original raw config.
    const rawRoot = (
      config.raw && typeof config.raw === 'object' ? config.raw : {}
    ) as Record<string, unknown>;

    // Build the mcp_servers table.
    const mcpServers: Record<string, RawCodexServer> = {};

    if (!keepOnlyConductor) {
      for (const [name, entry] of Object.entries(config.servers)) {
        mcpServers[name] = {
          command: entry.command,
          ...(entry.args !== undefined && { args: entry.args }),
          ...(entry.env && Object.keys(entry.env).length > 0
            ? { env_vars: denormaliseEnv(entry.env) }
            : {}),
        };
      }
    }

    // Always ensure mcp-conductor is present (add or overwrite).
    mcpServers['mcp-conductor'] = {
      command: conductorEntry.command,
      ...(conductorEntry.args !== undefined && { args: conductorEntry.args }),
      ...(conductorEntry.env && Object.keys(conductorEntry.env).length > 0
        ? { env_vars: denormaliseEnv(conductorEntry.env) }
        : {}),
    };

    // Compose final TOML object: preserve other top-level keys, then mcp_servers.
    const tomlObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawRoot)) {
      if (k !== 'mcp_servers') {
        tomlObj[k] = v;
      }
    }
    tomlObj['mcp_servers'] = mcpServers;

    // Backup existing file before any write.
    if (existsSync(path)) {
      writeBackup(path);
    }

    // Ensure the parent directory exists (project-local .codex/ may not exist yet).
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, TOML.stringify(tomlObj as TOML.JsonMap), 'utf-8');
  },
};

// ---------------------------------------------------------------------------
// Auto-register in the ADAPTERS map at module load time.
// ---------------------------------------------------------------------------
ADAPTERS.set('codex', CODEX_ADAPTER);
