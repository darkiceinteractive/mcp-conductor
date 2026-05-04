/**
 * export-servers command: generate mcpServers JSON pointing at mcp-conductor stdio.
 * @module cli/commands/export-servers
 */

import { existsSync } from 'node:fs';
import { loadConductorConfig, getDefaultConductorConfigPath } from '../../config/index.js';

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

/**
 * Generate a mcpServers block that points Claude back at mcp-conductor stdio.
 * This is the rollback path: if someone wants to undo the import, they paste
 * this JSON back into their Claude config.
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
