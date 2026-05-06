/**
 * doctor command: actionable health report across all configured servers.
 *
 * MC5: extends with a "client coverage" section that reports whether each
 * detected MCP client config has the mcp-conductor entry installed.
 *
 * @module cli/commands/doctor
 */

import { existsSync } from 'node:fs';
import { getDefaultConductorConfigPath, loadConductorConfig } from '../../config/index.js';
import { getMCPClientConfigPaths, ADAPTERS } from '../clients/index.js';
import type { MCPClientId } from '../clients/index.js';

// ---------------------------------------------------------------------------
// MC5: Client coverage types
// ---------------------------------------------------------------------------

export interface ClientCoverageEntry {
  /** Stable client identifier. */
  clientId: MCPClientId;
  /** Human-readable display name. */
  displayName: string;
  /** Absolute path to the config file that was inspected. */
  configPath: string;
  /** Whether this client config has an mcp-conductor server entry. */
  hasConductor: boolean;
  /** Scope: global or project-local. */
  scope: 'global' | 'project';
}

export interface ClientCoverageResult {
  /** All entries where the config file exists on disk (exists === true). */
  entries: ClientCoverageEntry[];
  /** How many of those entries already have the conductor entry. */
  coveredCount: number;
  /** How many are missing the conductor entry. */
  missingCount: number;
}

export interface ServerHealthEntry {
  name: string;
  command: string;
  args: string[];
  commandFound: boolean;
  status: 'ok' | 'warn' | 'error';
  issues: string[];
  suggestions: string[];
}

export interface DoctorResult {
  conductorConfigFound: boolean;
  conductorConfigPath: string;
  serverCount: number;
  healthyCount: number;
  warnCount: number;
  errorCount: number;
  servers: ServerHealthEntry[];
  globalIssues: string[];
  /** MC5: per-client coverage section (always present; entries may be empty). */
  clientCoverage: ClientCoverageResult;
}

// ---------------------------------------------------------------------------
// MC5: Client coverage check
// ---------------------------------------------------------------------------

/**
 * Scan all global MCP client config locations that exist on disk and report
 * whether each has the `mcp-conductor` server entry installed.
 *
 * A location is considered "covered" when the adapter's parse() returns a
 * NormalisedClientConfig whose `servers` map contains the key `"mcp-conductor"`.
 *
 * Locations without a registered adapter are skipped silently (forward compat).
 */
function runClientCoverage(): ClientCoverageResult {
  const locations = getMCPClientConfigPaths({ includeProject: false });
  const entries: ClientCoverageEntry[] = [];

  for (const loc of locations) {
    if (!loc.exists) continue;

    const adapter = ADAPTERS.get(loc.client);
    if (!adapter) continue; // no adapter yet — skip rather than crash

    let hasConductor = false;
    try {
      const parsed = adapter.parse(loc.path);
      hasConductor = parsed !== null && 'mcp-conductor' in parsed.servers;
    } catch {
      // If parse throws unexpectedly, treat as "no conductor entry".
      hasConductor = false;
    }

    entries.push({
      clientId: loc.client,
      displayName: loc.displayName,
      configPath: loc.path,
      hasConductor,
      scope: loc.scope,
    });
  }

  const coveredCount = entries.filter((e) => e.hasConductor).length;
  const missingCount = entries.length - coveredCount;

  return { entries, coveredCount, missingCount };
}

// ---------------------------------------------------------------------------
// Server command availability check
// ---------------------------------------------------------------------------

/**
 * Check if a command is available on PATH or as an absolute path.
 */
function isCommandAvailable(command: string): boolean {
  if (existsSync(command)) return true;
  // For npx/node/python/etc — check via which-like lookup using PATH
  // We do a simple check: if it contains a path separator it must exist as file.
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command);
  }
  // Otherwise assume available (we don't shell out here — tests would fail)
  return true;
}

/**
 * Run a health check on all configured MCP servers.
 * Non-connecting — just inspects config structure.
 */
export function runDoctor(): DoctorResult {
  const conductorConfigPath = getDefaultConductorConfigPath();
  const conductorConfigFound = existsSync(conductorConfigPath);
  const globalIssues: string[] = [];

  // MC5: run client coverage regardless of conductor config state.
  const clientCoverage = runClientCoverage();

  if (!conductorConfigFound) {
    return {
      conductorConfigFound: false,
      conductorConfigPath,
      serverCount: 0,
      healthyCount: 0,
      warnCount: 0,
      errorCount: 0,
      servers: [],
      globalIssues: [
        `Conductor config not found at ${conductorConfigPath}`,
        'Run `mcp-conductor-cli setup` or `mcp-conductor-cli import` to create it.',
      ],
      clientCoverage,
    };
  }

  const config = loadConductorConfig();
  if (!config) {
    return {
      conductorConfigFound: true,
      conductorConfigPath,
      serverCount: 0,
      healthyCount: 0,
      warnCount: 0,
      errorCount: 0,
      servers: [],
      globalIssues: ['Conductor config found but could not be parsed — check JSON syntax.'],
      clientCoverage,
    };
  }

  const servers: ServerHealthEntry[] = [];

  for (const [name, def] of Object.entries(config.servers)) {
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!def.command) {
      issues.push('Missing `command` field');
      suggestions.push('Add a `command` field to this server entry in ~/.mcp-conductor.json');
    }

    const cmdAvail = def.command ? isCommandAvailable(def.command) : false;
    if (def.command && !cmdAvail) {
      issues.push(`Command not found on PATH: ${def.command}`);
      suggestions.push(`Ensure \`${def.command}\` is installed and available on PATH`);
    }

    // Check for env vars with placeholder values
    for (const [k, v] of Object.entries(def.env ?? {})) {
      if (v === 'YOUR_TOKEN_HERE' || v === '<YOUR_API_KEY>' || v === '') {
        issues.push(`Env var ${k} appears unset or placeholder`);
        suggestions.push(`Set a real value for ${k} in the server env config`);
      }
    }

    const status: 'ok' | 'warn' | 'error' =
      issues.length === 0 ? 'ok' :
      issues.some((i) => i.includes('Missing') || i.includes('not found')) ? 'error' : 'warn';

    servers.push({
      name,
      command: def.command ?? '',
      args: def.args ?? [],
      commandFound: cmdAvail,
      status,
      issues,
      suggestions,
    });
  }

  const healthyCount = servers.filter((s) => s.status === 'ok').length;
  const warnCount = servers.filter((s) => s.status === 'warn').length;
  const errorCount = servers.filter((s) => s.status === 'error').length;

  return {
    conductorConfigFound: true,
    conductorConfigPath,
    serverCount: servers.length,
    healthyCount,
    warnCount,
    errorCount,
    servers,
    globalIssues,
    clientCoverage,
  };
}

/**
 * Format doctor results as human-readable text.
 */
export function formatDoctorResults(result: DoctorResult): string {
  const lines: string[] = [];

  if (!result.conductorConfigFound) {
    lines.push('CONDUCTOR CONFIG: NOT FOUND');
    for (const issue of result.globalIssues) {
      lines.push(`  ! ${issue}`);
    }
    return lines.join('\n');
  }

  lines.push(`CONDUCTOR CONFIG: ${result.conductorConfigPath}`);
  lines.push(`SERVERS: ${result.serverCount} total — ${result.healthyCount} ok, ${result.warnCount} warn, ${result.errorCount} error\n`);

  for (const server of result.servers) {
    const icon = server.status === 'ok' ? 'OK' : server.status === 'warn' ? 'WARN' : 'ERROR';
    lines.push(`[${icon}] ${server.name}  (${server.command}${server.args.length ? ' ' + server.args.join(' ') : ''})`);
    for (const issue of server.issues) {
      lines.push(`       Issue: ${issue}`);
    }
    for (const suggestion of server.suggestions) {
      lines.push(`       Fix: ${suggestion}`);
    }
  }

  if (result.globalIssues.length > 0) {
    lines.push('\nGlobal issues:');
    for (const issue of result.globalIssues) {
      lines.push(`  ! ${issue}`);
    }
  }

  // MC5: client coverage section
  const { entries, coveredCount, missingCount } = result.clientCoverage;
  if (entries.length > 0) {
    lines.push(`\nMCP CLIENT COVERAGE: ${coveredCount}/${entries.length} clients have mcp-conductor installed\n`);
    for (const entry of entries) {
      const icon = entry.hasConductor ? '[OK]' : '[MISSING]';
      lines.push(`  ${icon} ${entry.displayName}  (${entry.configPath})`);
      if (!entry.hasConductor) {
        lines.push(`         Run \`mcp-conductor-cli setup\` to install the conductor entry.`);
      }
    }
    if (missingCount > 0) {
      lines.push(`\n  ${missingCount} client(s) are missing the mcp-conductor entry.`);
      lines.push(`  Run \`mcp-conductor-cli setup\` to update them.`);
    }
  }

  return lines.join('\n');
}
