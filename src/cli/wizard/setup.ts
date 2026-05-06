/**
 * Interactive setup wizard using @inquirer/prompts.
 *
 * MC3: multi-client discovery mode (default).
 *   1. Discover all MCP client config locations via getMCPClientConfigPaths().
 *   2. For each existing config, parse it via the registered adapter.
 *   3. Present a per-client summary diff and ask for confirmation.
 *   4. On confirm: migrate that client's servers into ~/.mcp-conductor.json
 *      and write the conductor entry back into the client config.
 *
 * Legacy (single-Claude) mode is preserved under runLegacySetupWizard() and
 * is reachable via `runSetupWizard({ legacy: true })` (or the CLI --legacy flag).
 *
 * @module cli/wizard/setup
 */

import pc from 'picocolors';
import { getMCPClientConfigPaths, ADAPTERS } from '../clients/index.js';
import type { MCPClientConfigLocation, NormalisedServerEntry } from '../clients/index.js';
import {
  loadConductorConfig,
  saveConductorConfig,
  getDefaultConductorConfigPath,
} from '../../config/index.js';
import type { ConductorConfig } from '../../config/index.js';
import { findClaudeConfigsWithServers, importServers, formatImportResults } from '../commands/import-servers.js';
import { runDoctor, formatDoctorResults } from '../commands/doctor.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * The conductor entry written into every client config during setup.
 */
const CONDUCTOR_ENTRY: NormalisedServerEntry = {
  command: 'npx',
  args: ['-y', '@darkiceinteractive/mcp-conductor@latest'],
};

// ---------------------------------------------------------------------------
// MC3: Multi-client wizard helpers
// ---------------------------------------------------------------------------

/**
 * Migrate servers from a parsed client config into ~/.mcp-conductor.json.
 * De-duplicates by name (existing conductor entries are not overwritten).
 * The `mcp-conductor` entry itself is never imported as a server.
 *
 * Returns the names of newly added servers.
 */
function mergeIntoConductor(
  servers: Record<string, NormalisedServerEntry>,
): string[] {
  const conductorPath = getDefaultConductorConfigPath();
  const conductorConfig: ConductorConfig = loadConductorConfig() ?? { exclusive: false, servers: {} };

  const added: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (name === 'mcp-conductor') continue; // never import conductor itself
    if (conductorConfig.servers[name]) continue; // already present — skip
    conductorConfig.servers[name] = {
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ?? {},
    };
    added.push(name);
  }

  if (added.length > 0) {
    saveConductorConfig(conductorConfig, conductorPath);
  }

  return added;
}

// ---------------------------------------------------------------------------
// MC3: Multi-client wizard
// ---------------------------------------------------------------------------

/**
 * Run the multi-client setup wizard.
 *
 * Discovers all MCP client configs that exist on disk, presents a per-client
 * diff, and migrates on per-client confirmation.  Each client is independent —
 * the user can opt-out per client.
 */
async function runMultiClientSetupWizard(): Promise<void> {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  console.log(pc.bold(pc.cyan('\nMCP Conductor — Setup Wizard\n')));
  console.log('This wizard scans all known MCP client configs on your machine,');
  console.log('migrates their servers into ~/.mcp-conductor.json, and installs');
  console.log('the conductor entry back into each client.\n');

  // Step 1: discover all client config locations.
  const locations = getMCPClientConfigPaths({ includeProject: true });
  const existingLocations = locations.filter((loc) => loc.exists);

  if (existingLocations.length === 0) {
    console.log(pc.yellow('No MCP client config files found on this machine.'));
    console.log('Add servers manually with: mcp-conductor-cli add <name> <command> [args...]');
    return;
  }

  // Step 2: parse each existing location via its adapter.
  interface ParsedLocation {
    loc: MCPClientConfigLocation;
    serverNames: string[];
    hasConductor: boolean;
  }

  const parsedLocations: ParsedLocation[] = [];

  for (const loc of existingLocations) {
    const adapter = ADAPTERS.get(loc.client);
    if (!adapter) continue; // no adapter registered — skip gracefully

    try {
      const parsed = adapter.parse(loc.path);
      if (!parsed) continue; // no MCP servers in this file

      const serverNames = Object.keys(parsed.servers).filter((n) => n !== 'mcp-conductor');
      const hasConductor = 'mcp-conductor' in parsed.servers;

      if (serverNames.length === 0 && hasConductor) {
        // Already fully configured — nothing to do for this client.
        console.log(pc.dim(`  ${loc.displayName}: already has conductor entry — skipping.`));
        continue;
      }

      parsedLocations.push({ loc, serverNames, hasConductor });
    } catch {
      // Parse errors are non-fatal — skip the location.
      continue;
    }
  }

  if (parsedLocations.length === 0) {
    console.log(pc.green('\nAll detected client configs already have the conductor entry installed.'));
    console.log(pc.dim('Nothing to migrate.\n'));
    return;
  }

  // Step 3 & 4: per-client confirm + migrate.
  const updatedClients: string[] = [];
  const allMovedServers: string[] = [];
  const hadBackups: boolean[] = [];

  for (const { loc, serverNames } of parsedLocations) {
    console.log(pc.bold(`\n${loc.displayName}`) + pc.dim(` (${loc.path})`));

    if (serverNames.length > 0) {
      console.log(`  ${serverNames.length} server(s) found → move into conductor + install conductor entry:`);
      for (const name of serverNames) {
        console.log(pc.dim(`    • ${name}`));
      }
    } else {
      console.log(`  0 non-conductor servers — will just install the conductor entry.`);
    }

    let doMigrate = true;

    if (isTTY) {
      const { confirm } = await import('@inquirer/prompts');
      doMigrate = await confirm({
        message: `Migrate ${loc.displayName}?`,
        default: true,
      });
    } else {
      console.log(pc.dim('  (Non-interactive — proceeding automatically)\n'));
    }

    if (!doMigrate) {
      console.log(pc.dim(`  Skipped ${loc.displayName}.`));
      continue;
    }

    // Re-parse to get the full NormalisedClientConfig for the adapter write.
    const adapter = ADAPTERS.get(loc.client)!;
    const parsed = adapter.parse(loc.path);
    if (!parsed) continue; // should not happen since we parsed above

    // Merge non-conductor servers into ~/.mcp-conductor.json.
    const added = mergeIntoConductor(parsed.servers);

    // Write conductor entry back into the client config.
    try {
      adapter.serialize(loc.path, parsed, {
        keepOnlyConductor: false,
        conductorEntry: CONDUCTOR_ENTRY,
      });
      updatedClients.push(`${loc.displayName} (${loc.path})`);
      allMovedServers.push(...added);
      hadBackups.push(true);
      const movedMsg = added.length > 0 ? `${added.length} server(s) moved.` : 'Conductor entry installed.';
      console.log(pc.green(`  [OK] ${loc.displayName} updated. ${movedMsg}`));
    } catch (err) {
      console.log(pc.red(`  [FAIL] Failed to update ${loc.displayName}: ${String(err)}`));
    }
  }

  // Step 5: final summary.
  console.log(pc.bold(pc.green('\nSetup complete!\n')));
  if (updatedClients.length > 0) {
    console.log(`Clients updated (${updatedClients.length}):`);
    for (const c of updatedClients) {
      console.log(`  • ${c}`);
    }
  }
  if (allMovedServers.length > 0) {
    console.log(`\nServers moved into conductor (${allMovedServers.length}):`);
    for (const s of allMovedServers) {
      console.log(`  • ${s}`);
    }
  }
  if (hadBackups.length > 0) {
    console.log(pc.dim(`\nBackup files created alongside each updated config (*.bak.YYYYMMDDHHMMSS).`));
  }

  console.log('\nNext steps:');
  console.log('  1. Restart your MCP client(s) to pick up the new conductor config.');
  console.log('  2. Use  mcp-conductor-cli list  to verify all servers are visible.');
  console.log('  3. Use  mcp-conductor-cli doctor  to check for any issues.\n');
}

// ---------------------------------------------------------------------------
// Legacy: single-Claude wizard (pre-MC3 behaviour)
// ---------------------------------------------------------------------------

/**
 * Legacy setup wizard: operates only on Claude config files (the pre-MC3
 * behaviour).  Reachable via `runSetupWizard({ legacy: true })` or the CLI
 * `mcp-conductor-cli setup --legacy` flag.
 */
export async function runLegacySetupWizard(): Promise<void> {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  console.log(pc.bold(pc.cyan('\nMCP Conductor — Setup Wizard (legacy mode)\n')));
  console.log('This wizard will help you move your MCP servers into Conductor.');
  console.log('Conductor proxies all your servers through a single MCP endpoint.\n');

  // Step 1: discover Claude configs
  const sources = findClaudeConfigsWithServers();

  if (sources.length === 0) {
    console.log(pc.yellow('No MCP client config files with MCP servers found.'));
    console.log('Add servers manually with: mcp-conductor-cli add <name> <command> [args...]');
    return;
  }

  console.log(pc.green(`Found ${sources.length} config file(s) with MCP servers:\n`));
  for (const src of sources) {
    console.log(pc.dim(`  ${src.path}`));
    for (const name of Object.keys(src.servers)) {
      console.log(`    • ${name}`);
    }
  }
  console.log('');

  let doImport = true;
  let removeOriginals = false;

  if (isTTY) {
    // Dynamic import to avoid loading inquirer in non-TTY environments
    const { confirm } = await import('@inquirer/prompts');

    doImport = await confirm({
      message: 'Import these servers into ~/.mcp-conductor.json?',
      default: true,
    });

    if (doImport) {
      removeOriginals = await confirm({
        message: 'Remove imported servers from source configs after import?',
        default: false,
      });
    }
  } else {
    console.log(pc.dim('(Non-interactive mode — proceeding with import, keeping originals)\n'));
  }

  if (!doImport) {
    console.log(pc.dim('Import skipped.'));
    return;
  }

  // Step 2: perform import
  const results = importServers({ yes: true, removeOriginals });
  console.log(formatImportResults(results));

  // Step 3: run doctor to confirm health
  console.log(pc.bold('\nRunning health check...\n'));
  const doctorResult = runDoctor();
  console.log(formatDoctorResults(doctorResult));

  // Step 4: next steps
  console.log(pc.bold(pc.green('\nSetup complete!\n')));
  console.log('Next steps:');
  console.log('  1. Restart your MCP client(s) to pick up the new mcp-conductor config.');
  console.log('  2. Use  mcp-conductor-cli list  to verify all servers are visible.');
  console.log('  3. Use  mcp-conductor-cli doctor  to check for any issues.\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface SetupWizardOptions {
  /**
   * When `true`, run the legacy single-client wizard instead of the new
   * multi-client wizard.  Activated via `mcp-conductor-cli setup --legacy`.
   */
  legacy?: boolean;
}

/**
 * Run the full interactive setup wizard.
 *
 * By default (MC3) scans all known MCP clients and migrates each independently.
 * Pass `{ legacy: true }` to use the pre-MC3 single-Claude flow.
 *
 * Falls back to non-interactive mode if TTY is not available (CI).
 */
export async function runSetupWizard(options: SetupWizardOptions = {}): Promise<void> {
  if (options.legacy) {
    return runLegacySetupWizard();
  }
  return runMultiClientSetupWizard();
}
