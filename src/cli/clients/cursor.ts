/**
 * Cursor MCP client adapter.
 *
 * Cursor stores MCP server definitions in `~/.cursor/mcp.json` (global) and
 * `.cursor/mcp.json` (project-local).  Both files use a flat JSON object with
 * an `mcpServers` key whose value is an Anthropic-compatible server map
 * `{ [serverName]: { command, args?, env? } }`.
 *
 * This adapter handles:
 * - Parsing `mcpServers` into the normalised shape.
 * - Round-trip serialisation that preserves any extra top-level keys.
 * - `.bak.YYYYMMDDHHMMSS` backups before every write.
 * - `keepOnlyConductor` mode for the "migrate to conductor" setup flow.
 *
 * @module cli/clients/cursor
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MCPClientAdapter, NormalisedClientConfig, SerializeOptions } from './adapter.js';
import { ADAPTERS } from './adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CursorServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface CursorConfig {
  mcpServers?: Record<string, CursorServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Backup helper (mirrors the pattern in import-servers.ts)
// ---------------------------------------------------------------------------

/**
 * Write a timestamped `.bak.YYYYMMDDHHMMSS` copy of the file beside it.
 * If a file with the same timestamp already exists a 4-char hex salt is
 * appended to avoid silent overwrites on sub-second repeat calls.
 *
 * @returns The path of the backup file that was written.
 */
function writeBackup(filePath: string): string {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let backupPath = `${filePath}.bak.${ts}`;
  if (existsSync(backupPath)) {
    const salt = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0');
    backupPath = `${backupPath}.${salt}`;
  }
  copyFileSync(filePath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const CURSOR_ADAPTER: MCPClientAdapter = {
  client: 'cursor',

  parse(path: string): NormalisedClientConfig | null {
    if (!existsSync(path)) return null;

    let raw: CursorConfig;
    try {
      const text = readFileSync(path, 'utf-8');
      raw = JSON.parse(text) as CursorConfig;
    } catch {
      return null;
    }

    const mcpServers = raw.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Object.keys(mcpServers).length === 0) {
      return null;
    }

    const servers: NormalisedClientConfig['servers'] = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (!entry || typeof entry.command !== 'string') continue;
      servers[name] = {
        command: entry.command,
        ...(Array.isArray(entry.args) && { args: entry.args }),
        ...(entry.env && typeof entry.env === 'object' && { env: entry.env }),
      };
    }

    return { servers, raw };
  },

  serialize(path: string, config: NormalisedClientConfig, options: SerializeOptions): void {
    // Back up the existing file before any write.
    if (existsSync(path)) {
      writeBackup(path);
    }

    // Start from the original parsed object so non-MCP keys are preserved.
    const base =
      config.raw && typeof config.raw === 'object'
        ? { ...(config.raw as CursorConfig) }
        : ({} as CursorConfig);

    // Determine which servers to write.
    const serversToWrite = options.keepOnlyConductor
      ? { 'mcp-conductor': options.conductorEntry }
      : { ...config.servers, 'mcp-conductor': options.conductorEntry };

    // Convert to the Cursor-native shape.
    const mcpServers: Record<string, CursorServerEntry> = {};
    for (const [name, entry] of Object.entries(serversToWrite)) {
      mcpServers[name] = {
        command: entry.command,
        ...(Array.isArray(entry.args) && { args: entry.args }),
        ...(entry.env && typeof entry.env === 'object' && { env: entry.env }),
      };
    }

    const output: CursorConfig = { ...base, mcpServers };

    // Ensure the parent directory exists (e.g. ~/.cursor/ may not yet exist).
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

ADAPTERS.set('cursor', CURSOR_ADAPTER);

export { CURSOR_ADAPTER };
