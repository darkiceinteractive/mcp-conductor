/**
 * import-servers command: read Claude config files, show diff, copy to ~/.mcp-conductor.json
 * @module cli/commands/import-servers
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeJsonParse } from '../../utils/index.js';
import {
  getClaudeConfigPaths,
  getDefaultConductorConfigPath,
  loadConductorConfig,
  saveConductorConfig,
} from '../../config/index.js';
import type { ClaudeConfig, ConductorConfig } from '../../config/index.js';

export interface ImportOptions {
  /** Paths to search for Claude config (defaults to standard paths) */
  configPaths?: string[];
  /** Skip interactive confirmation — import immediately */
  yes?: boolean;
  /** Remove imported servers from source configs after import */
  removeOriginals?: boolean;
  /** Dry-run: show diff but don't write anything */
  dryRun?: boolean;
}

export interface ServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ImportResult {
  imported: ServerEntry[];
  skipped: string[];
  sourcePath: string;
  conductorPath: string;
  backupPaths: string[];
  removedFromSource: boolean;
}

/**
 * Find all Claude config files that contain mcpServers.
 */
export function findClaudeConfigsWithServers(configPaths?: string[]): Array<{ path: string; servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }> {
  const paths = configPaths ?? getClaudeConfigPaths();
  const found: Array<{ path: string; servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }> = [];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8');
      const cfg = safeJsonParse<ClaudeConfig>(content, {});
      const servers = cfg.mcpServers ?? {};
      if (Object.keys(servers).length > 0) {
        found.push({ path: p, servers });
      }
    } catch {
      // skip unreadable
    }
  }

  return found;
}

/**
 * Write a .bak file alongside the original.
 */
export function writeBackup(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Strip named servers from a Claude config file.
 */
export function stripServersFromConfig(filePath: string, serverNames: string[]): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  const cfg = safeJsonParse<ClaudeConfig>(content, {});
  if (!cfg.mcpServers) return;
  for (const name of serverNames) {
    delete cfg.mcpServers[name];
  }
  writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Perform the import: merge servers from Claude configs into conductor config.
 * Non-interactive (no prompts) — callers handle confirmation.
 */
export function importServers(options: ImportOptions = {}): ImportResult[] {
  const sources = findClaudeConfigsWithServers(options.configPaths);
  const conductorPath = getDefaultConductorConfigPath();
  const results: ImportResult[] = [];

  for (const source of sources) {
    let conductorConfig: ConductorConfig = loadConductorConfig() ?? { exclusive: false, servers: {} };

    const imported: ServerEntry[] = [];
    const skipped: string[] = [];
    const backupPaths: string[] = [];

    for (const [name, def] of Object.entries(source.servers)) {
      if (conductorConfig.servers[name]) {
        skipped.push(name);
        continue;
      }
      conductorConfig.servers[name] = {
        command: def.command,
        args: def.args ?? [],
        env: def.env ?? {},
      };
      imported.push({ name, command: def.command, args: def.args, env: def.env });
    }

    if (!options.dryRun && imported.length > 0) {
      // Write .bak before touching source
      backupPaths.push(writeBackup(source.path));
      saveConductorConfig(conductorConfig, conductorPath);

      if (options.removeOriginals) {
        stripServersFromConfig(source.path, imported.map((s) => s.name));
      }
    }

    results.push({
      imported,
      skipped,
      sourcePath: source.path,
      conductorPath,
      backupPaths,
      removedFromSource: !options.dryRun && !!options.removeOriginals && imported.length > 0,
    });
  }

  return results;
}

/**
 * Format import results as human-readable text (for CLI output).
 */
export function formatImportResults(results: ImportResult[], dryRun = false): string {
  if (results.length === 0) {
    return 'No Claude config files with MCP servers found.';
  }

  const lines: string[] = [];
  let totalImported = 0;
  let totalSkipped = 0;

  for (const r of results) {
    lines.push(`\nSource: ${r.sourcePath}`);
    if (r.imported.length > 0) {
      lines.push(`  ${dryRun ? 'Would import' : 'Imported'} (${r.imported.length}):`);
      for (const s of r.imported) {
        lines.push(`    + ${s.name}  [${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}]`);
      }
    }
    if (r.skipped.length > 0) {
      lines.push(`  Skipped (already in conductor) (${r.skipped.length}):`);
      for (const s of r.skipped) {
        lines.push(`    ~ ${s}`);
      }
    }
    if (!dryRun && r.backupPaths.length > 0) {
      lines.push(`  Backup written: ${r.backupPaths.join(', ')}`);
    }
    if (!dryRun && r.removedFromSource) {
      lines.push(`  Removed ${r.imported.length} server(s) from source config.`);
    }
    totalImported += r.imported.length;
    totalSkipped += r.skipped.length;
  }

  lines.push(`\nTotal: ${totalImported} imported, ${totalSkipped} skipped.`);
  if (!dryRun && totalImported > 0) {
    lines.push(`Config written to: ${results[0]?.conductorPath ?? getDefaultConductorConfigPath()}`);
  }

  return lines.join('\n');
}
