#!/usr/bin/env node
/**
 * MCP Conductor CLI — interactive wizard and server management commands.
 *
 * Entry point for the `mcp-conductor-cli` binary.
 * Subcommands:
 *   setup    — interactive wizard (imports from Claude configs)
 *   add      — add a server to conductor config
 *   list     — list configured servers
 *   test     — transient connect + list tools
 *   routing  — show/apply routing recommendations
 *   doctor   — health check all servers
 *   import   — non-interactive import from Claude configs
 *   export   — generate mcpServers JSON for Claude rollback
 *   daemon   — start|stop|status|logs (wired to Phase 6 module)
 *
 * @module bin/cli
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { runSetupWizard } from '../cli/wizard/setup.js';
import { importServers, formatImportResults } from '../cli/commands/import-servers.js';
import { exportToClaude } from '../cli/commands/export-servers.js';
import { testServer } from '../cli/commands/test-server.js';
import { getRoutingRecommendations } from '../cli/commands/routing.js';
import { runDoctor, formatDoctorResults } from '../cli/commands/doctor.js';
import {
  loadConductorConfig,
  saveConductorConfig,
  getDefaultConductorConfigPath,
} from '../config/index.js';
import { registerDaemonCommands } from '../cli/daemon.js';
import { VERSION } from '../version.js';

const program = new Command();

program
  .name('mcp-conductor-cli')
  .description('MCP Conductor — server lifecycle management CLI')
  .version(VERSION);

// ----------------------------------------------------------------
// setup — interactive wizard
// ----------------------------------------------------------------
program
  .command('setup')
  .description('Interactive wizard: detect Claude configs, import servers, verify health')
  .action(async () => {
    try {
      await runSetupWizard();
    } catch (err) {
      console.error(pc.red(`Setup failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// add — add a server
// ----------------------------------------------------------------
program
  .command('add <name> <command> [args...]')
  .description('Add an MCP server to the conductor config')
  .option('-e, --env <pairs...>', 'Environment variables as KEY=VALUE pairs')
  .action((name: string, command: string, args: string[], opts: { env?: string[] }) => {
    try {
      const env: Record<string, string> = {};
      for (const pair of opts.env ?? []) {
        const [k, ...rest] = pair.split('=');
        if (k) env[k] = rest.join('=');
      }

      let config = loadConductorConfig() ?? { exclusive: false, servers: {} };

      if (config.servers[name]) {
        console.error(pc.red(`Server '${name}' already exists. Remove it first with: mcp-conductor-cli remove ${name}`));
        process.exit(1);
      }

      config.servers[name] = { command, args, env };
      const result = saveConductorConfig(config, getDefaultConductorConfigPath());

      if (result.success) {
        console.log(pc.green(`Added server '${name}' — config saved to ${result.path}`));
      } else {
        console.error(pc.red(`Failed to save config: ${result.error}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(pc.red(`Add failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// list — list configured servers
// ----------------------------------------------------------------
program
  .command('list')
  .description('List all servers in the conductor config')
  .action(() => {
    try {
      const config = loadConductorConfig();
      if (!config) {
        console.log(pc.yellow('No conductor config found. Run `mcp-conductor-cli setup` first.'));
        return;
      }
      const names = Object.keys(config.servers);
      if (names.length === 0) {
        console.log(pc.dim('No servers configured.'));
        return;
      }
      console.log(pc.bold(`\nConfigured servers (${names.length}):\n`));
      for (const [name, def] of Object.entries(config.servers)) {
        console.log(`  ${pc.cyan(name)}`);
        console.log(`    command: ${def.command}${(def.args ?? []).length ? ' ' + def.args!.join(' ') : ''}`);
        if (Object.keys(def.env ?? {}).length > 0) {
          const envKeys = Object.keys(def.env!).join(', ');
          console.log(`    env: ${envKeys}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(pc.red(`List failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// test — transient connect + list tools
// ----------------------------------------------------------------
program
  .command('test <name>')
  .description('Transiently connect to a server, list its tools and measure latency')
  .option('--timeout <ms>', 'Connection timeout in milliseconds', '15000')
  .action(async (name: string, opts: { timeout?: string }) => {
    try {
      console.log(pc.dim(`Testing server '${name}'...`));
      const result = await testServer({
        name,
        timeoutMs: parseInt(opts.timeout ?? '15000', 10),
      });

      if (result.success) {
        console.log(pc.green(`\n[OK] ${result.serverName}`));
        console.log(`  Latency: ${result.latencyMs}ms`);
        console.log(`  Tools: ${result.toolCount}`);
        if (result.tools.length > 0) {
          for (const t of result.tools.slice(0, 20)) {
            console.log(`    • ${t.name}: ${t.description.slice(0, 80)}`);
          }
          if (result.tools.length > 20) {
            console.log(`    ... and ${result.tools.length - 20} more`);
          }
        }
      } else {
        console.log(pc.red(`\n[FAIL] ${result.serverName}`));
        console.log(`  Error: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(pc.red(`Test failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// routing — routing recommendations
// ----------------------------------------------------------------
program
  .command('routing [name]')
  .description('Show routing recommendations for a server (or all servers)')
  .option('--apply', 'Write routing hints to conductor config')
  .action((name: string | undefined, opts: { apply?: boolean }) => {
    try {
      const result = getRoutingRecommendations({ serverName: name, apply: opts.apply });
      if (result.recommendations.length === 0) {
        console.log(pc.yellow('No servers found to analyse.'));
        return;
      }
      console.log(pc.bold('\nRouting recommendations:\n'));
      for (const rec of result.recommendations) {
        const icon = rec.recommendation === 'passthrough' ? pc.green('passthrough') : pc.dim('execute_code');
        console.log(`  ${pc.cyan(rec.serverName)}: ${icon}`);
        console.log(`    Reason: ${rec.reason}`);
      }
      if (result.applied) {
        console.log(pc.green(`\nRouting hints written to ${result.configPath}`));
      } else {
        console.log(pc.dim('\nUse --apply to write hints to conductor config.'));
      }
    } catch (err) {
      console.error(pc.red(`Routing failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// doctor — health check
// ----------------------------------------------------------------
program
  .command('doctor')
  .description('Health check all configured MCP servers')
  .action(() => {
    try {
      const result = runDoctor();
      console.log('\n' + formatDoctorResults(result));
      if (result.errorCount > 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(pc.red(`Doctor failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// import — non-interactive import
// ----------------------------------------------------------------
program
  .command('import')
  .description('Import MCP servers from Claude config files (non-interactive)')
  .option('--remove-originals', 'Remove imported servers from source configs')
  .option('--dry-run', 'Show what would be imported without writing')
  .action((opts: { removeOriginals?: boolean; dryRun?: boolean }) => {
    try {
      const results = importServers({
        yes: true,
        removeOriginals: opts.removeOriginals,
        dryRun: opts.dryRun,
      });
      console.log(formatImportResults(results, opts.dryRun));
    } catch (err) {
      console.error(pc.red(`Import failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// export — generate rollback JSON
// ----------------------------------------------------------------
program
  .command('export')
  .description('Generate mcpServers JSON that points Claude back at mcp-conductor (rollback path)')
  .option('--format <format>', 'Output format: claude-desktop | claude-code | raw', 'claude-desktop')
  .action((opts: { format?: string }) => {
    try {
      const result = exportToClaude({
        format: (opts.format as 'claude-desktop' | 'claude-code' | 'raw') ?? 'claude-desktop',
      });
      console.log(result.json);
    } catch (err) {
      console.error(pc.red(`Export failed: ${String(err)}`));
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// daemon — Phase 6 subcommands (start|stop|status|logs)
// ----------------------------------------------------------------
registerDaemonCommands(program);

// ----------------------------------------------------------------
// parse
// ----------------------------------------------------------------
program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`Unexpected error: ${String(err)}`));
  process.exit(1);
});
