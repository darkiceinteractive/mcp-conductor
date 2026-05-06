/**
 * export-servers command: generate mcpServers JSON pointing at mcp-conductor stdio.
 *
 * MC4: exportForClient() uses the per-client adapter to write the correct
 * format/key/shape for any of the 10 known clients.  The legacy exportToClaude()
 * is preserved for backwards compatibility and defaults to claude-desktop.
 *
 * @module cli/commands/export-servers
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConductorConfig, getDefaultConductorConfigPath } from '../../config/index.js';
import { ADAPTERS } from '../clients/index.js';
import type { MCPClientId, NormalisedClientConfig, NormalisedServerEntry } from '../clients/index.js';

// Re-export MCPClientId so CLI consumers can import from here.
export type { MCPClientId };

export interface ExportOptions {
  /** Output format: 'claude-desktop' | 'claude-code' | 'raw' */
  format?: 'claude-desktop' | 'claude-code' | 'raw';
  /** Path to conductor binary (defaults to npx @darkiceinteractive/mcp-conductor) */
  conductorPath?: string;
}

export interface ExportResult {
  json: string;
  format: string;
  serverCount: number;
}

// ---------------------------------------------------------------------------
// MC4: Per-client export
// ---------------------------------------------------------------------------

export interface ExportForClientOptions {
  /**
   * One of the 10 known MCPClientId values.  Defaults to 'claude-desktop'.
   */
  clientId?: MCPClientId;
  /**
   * Directory to write the exported config file into.
   * Defaults to `process.cwd()`.
   */
  outputDir?: string;
  /**
   * When provided, the exported file is written to this exact path instead of
   * the auto-derived `<outputDir>/<client>-config.<ext>`.
   */
  outputPath?: string;
}

export interface ExportForClientResult {
  /** The path the file was written to. */
  outputPath: string;
  /** The clientId that was exported for. */
  clientId: MCPClientId;
  /** Number of servers referenced in conductor config (informational). */
  serverCount: number;
}

/**
 * The conductor entry written into every exported client config.
 */
const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'npx',
  args: ['-y', '@darkiceinteractive/mcp-conductor@latest'],
};

/**
 * Derive the output filename for a given client.
 *
 * Extension mapping (mirrors adapter format declarations in registry.ts):
 * - codex    → .toml
 * - continue → .yaml
 * - all others (JSON) → .json
 */
export function deriveExportFilename(clientId: MCPClientId): string {
  if (clientId === 'codex') return `${clientId}-config.toml`;
  if (clientId === 'continue') return `${clientId}-config.yaml`;
  return `${clientId}-config.json`;
}

/**
 * Export the conductor entry in the native config format for the specified
 * client.  Writes to `<outputDir>/<clientId>-config.<ext>` by default, or to
 * `outputPath` when explicitly provided.
 *
 * The user can then drop the resulting file into the appropriate location for
 * their client.  Only the `mcp-conductor` entry is written (`keepOnlyConductor: true`).
 *
 * Backwards compat: omitting `clientId` defaults to `claude-desktop`.
 */
export function exportForClient(options: ExportForClientOptions = {}): ExportForClientResult {
  const clientId: MCPClientId = options.clientId ?? 'claude-desktop';
  const outputDir = options.outputDir ?? process.cwd();

  const filename = deriveExportFilename(clientId);
  const resolvedOutputPath = options.outputPath ?? join(outputDir, filename);

  const adapter = ADAPTERS.get(clientId);
  if (!adapter) {
    throw new Error(`No adapter registered for client "${clientId}". Cannot export.`);
  }

  // Count servers in conductor config (informational only).
  const conductorConfigPath = getDefaultConductorConfigPath();
  const hasConfig = existsSync(conductorConfigPath);
  const conductorConfig = hasConfig ? loadConductorConfig() : null;
  const serverCount = conductorConfig ? Object.keys(conductorConfig.servers).length : 0;

  // Build a minimal NormalisedClientConfig.  keepOnlyConductor=true means the
  // adapter ignores `servers` and writes only the conductor entry.
  const emptyConfig: NormalisedClientConfig = { servers: {}, raw: {} };

  // Ensure parent directory exists before the adapter writes.
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });

  // Seed the file as an empty document so adapters that guard with existsSync
  // do not attempt to back up a stale production config at the destination.
  // Only seed when the destination does not already exist.
  if (!existsSync(resolvedOutputPath)) {
    writeFileSync(resolvedOutputPath, clientId === 'codex' ? '' : '{}', 'utf-8');
  }

  adapter.serialize(resolvedOutputPath, emptyConfig, {
    keepOnlyConductor: true,
    conductorEntry: CONDUCTOR_ENTRY,
  });

  return { outputPath: resolvedOutputPath, clientId, serverCount };
}

/**
 * Return all client IDs that have a registered adapter (in insertion order).
 * Used by the CLI to show valid `--client` choices.
 */
export function listExportableClients(): MCPClientId[] {
  return [...ADAPTERS.keys()];
}

// ---------------------------------------------------------------------------
// Legacy: exportToClaude (claude-desktop / claude-code / raw text formats)
// ---------------------------------------------------------------------------

/**
 * Generate a mcpServers block that points Claude back at mcp-conductor stdio.
 * This is the rollback path: if someone wants to undo the import, they paste
 * this JSON back into their Claude config.
 *
 * @deprecated Prefer `exportForClient({ clientId: 'claude-desktop' })` for new code.
 *   This function is kept for backwards compatibility; all existing callers
 *   (`bin/cli.ts`, `mcp-server.ts`, `lifecycle-tools.test.ts`) continue to work.
 */
export function exportToClaude(options: ExportOptions = {}): ExportResult {
  const conductorPath = getDefaultConductorConfigPath();
  const hasConfig = existsSync(conductorPath);
  const config = hasConfig ? loadConductorConfig() : null;
  const serverCount = config ? Object.keys(config.servers).length : 0;

  const format = options.format ?? 'claude-desktop';
  const command = options.conductorPath ?? 'npx';
  const args = options.conductorPath
    ? []
    : ['-y', '@darkiceinteractive/mcp-conductor'];

  const mcpServersBlock = {
    mcpServers: {
      'mcp-conductor': {
        command,
        args,
      },
    },
  };

  let json: string;
  if (format === 'claude-code') {
    // Claude Code uses a flat mcpServers object in settings.json
    json = JSON.stringify({ mcpServers: mcpServersBlock.mcpServers }, null, 2);
  } else if (format === 'raw') {
    // Just the inner mcpServers value
    json = JSON.stringify(mcpServersBlock.mcpServers, null, 2);
  } else {
    // claude-desktop format: full wrapper object
    json = JSON.stringify(mcpServersBlock, null, 2);
  }

  return { json, format, serverCount };
}
