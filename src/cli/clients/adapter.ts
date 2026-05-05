/**
 * Per-client adapter interface for reading and writing MCP configuration files.
 *
 * Each MCP client stores server definitions in its own format and schema.
 * Adapters normalise those into a common shape so the rest of the codebase can
 * work with any client without caring about per-client quirks.
 *
 * Wave 2 agents implement concrete adapters and register them in `index.ts`.
 *
 * @module cli/clients/adapter
 */

import type { MCPClientId } from './registry.js';

// Re-export MCPClientId so consumers can import both from the same module.
export type { MCPClientId };

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

/**
 * A single MCP server entry in normalised form.
 *
 * All fields mirror the lowest-common-denominator shape used by Claude Desktop
 * and Claude Code so existing conductor logic can consume it unchanged.
 */
export interface NormalisedServerEntry {
  /** Executable or interpreter path (e.g. `"node"`, `"uvx"`, `"deno"`). */
  command: string;
  /** Positional arguments to the command. */
  args?: string[];
  /** Environment variable overrides for the server process. */
  env?: Record<string, string>;
}

/**
 * The full config file contents in normalised form.
 */
export interface NormalisedClientConfig {
  /** Map of server name → server definition. */
  servers: Record<string, NormalisedServerEntry>;
  /**
   * The original parsed object from the config file.
   *
   * Preserved so adapters can do round-trip writes without losing fields the
   * normalisation doesn't cover (e.g. client-specific metadata, non-MCP keys).
   */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /**
   * When `true`, all server entries except the mcp-conductor entry are removed
   * before writing.  Used during the "migrate to conductor" setup flow.
   */
  keepOnlyConductor?: boolean;
  /**
   * The conductor server entry that must always be present in the written
   * config.  Required so the serialiser can add or update it.
   */
  conductorEntry: NormalisedServerEntry;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * A per-client adapter translates between a client's native config format and
 * the conductor's normalised representation.
 *
 * Concrete implementations are registered in `src/cli/clients/index.ts` and
 * selected at runtime by matching the `MCPClientConfigLocation.client` field.
 */
export interface MCPClientAdapter {
  /**
   * Stable identifier matching `MCPClientId`.
   * Used as the key in the `ADAPTERS` map.
   */
  readonly client: MCPClientId;

  /**
   * Parse the client's config file at `path` into the normalised shape.
   *
   * Returns `null` when the file does not exist, cannot be parsed, or contains
   * no MCP server definitions — allowing callers to skip gracefully.
   *
   * @param path - Absolute path to the client config file.
   */
  parse(path: string): NormalisedClientConfig | null;

  /**
   * Write a (potentially modified) config back to disk at `path`.
   *
   * The adapter must:
   * 1. Merge `config.servers` (or a filtered subset if `keepOnlyConductor` is
   *    set) into `config.raw` under the client's native key.
   * 2. Ensure `conductorEntry` is present under the `"mcp-conductor"` key.
   * 3. Preserve all non-MCP keys from `config.raw` so nothing is lost.
   *
   * @param path    - Absolute path to the client config file.
   * @param config  - Normalised config (including original `raw`).
   * @param options - Serialisation options.
   */
  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void;
}
