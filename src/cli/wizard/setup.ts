/**
 * Interactive setup wizard using @inquirer/prompts.
 * Guides the user through discovering Claude configs, importing servers,
 * and optionally cleaning up source configs.
 * @module cli/wizard/setup
 */

import pc from 'picocolors';
import { findClaudeConfigsWithServers, importServers, formatImportResults } from '../commands/import-servers.js';
import { runDoctor, formatDoctorResults } from '../commands/doctor.js';

/**
 * Run the full interactive setup wizard.
 * Falls back to non-interactive mode if TTY is not available (CI).
 */
export async function runSetupWizard(): Promise<void> {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  console.log(pc.bold(pc.cyan('\nMCP Conductor — Setup Wizard\n')));
  console.log('This wizard will help you move your MCP servers into Conductor.');
  console.log('Conductor proxies all your servers through a single MCP endpoint.\n');

  // Step 1: discover Claude configs
  const sources = findClaudeConfigsWithServers();

  if (sources.length === 0) {
    console.log(pc.yellow('No Claude config files with MCP servers found.'));
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
  console.log('  1. Restart Claude to pick up the new mcp-conductor config.');
  console.log('  2. Use  mcp-conductor-cli list  to verify all servers are visible.');
  console.log('  3. Use  mcp-conductor-cli doctor  to check for any issues.\n');
}
