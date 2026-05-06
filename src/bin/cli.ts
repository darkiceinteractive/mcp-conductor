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
import { exportToClaude, exportForClient, listExportableClients } from '../cli/commands/export-servers.js';
import type { MCPClientId } from '../cli/commands/export-servers.js';
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
  .description('Interactive wizard: detect all MCP client configs, migrate servers, verify health')
  .option('--legacy', 'Use the legacy single-Claude wizard instead of the multi-client wizard')
  .action(async (opts: { legacy?: boolean }) => {
    try {
      await runSetupWizard({ legacy: opts.legacy });
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
// export — generate rollback JSON or per-client config file
// ----------------------------------------------------------------
program
  .command('export')
  .description(
    'Export conductor config for a specific MCP client, or print legacy rollback JSON.\n' +
    '  --client <id>  Write <id>-config.<ext> in the current directory.\n' +
    '                 Valid IDs: ' + ['claude-desktop', 'claude-code', 'codex', 'gemini-cli',
      'cursor', 'cline', 'zed', 'continue', 'opencode', 'kimi-code'].join(', '),
  )
  .option('--client <id>', 'Client ID to export for (writes a config file to cwd)')
  .option('--format <format>', 'Legacy text format: claude-desktop | claude-code | raw (ignored when --client is set)', 'claude-desktop')
  .option('--output <path>', 'Override the output file path (only with --client)')
  .action((opts: { client?: string; format?: string; output?: string }) => {
    try {
      if (opts.client) {
        // MC4: per-client file export
        const validClients = listExportableClients();
        if (!validClients.includes(opts.client as MCPClientId)) {
          console.error(pc.red(`Unknown client "${opts.client}". Valid clients: ${validClients.join(', ')}`));
          process.exit(1);
        }
        const result = exportForClient({
          clientId: opts.client as MCPClientId,
          outputPath: opts.output,
        });
        console.log(pc.green(`Exported conductor config for ${result.clientId} → ${result.outputPath}`));
        console.log(pc.dim(`Drop this file into the appropriate location for your client.`));
      } else {
        // Legacy: print JSON to stdout
        const result = exportToClaude({
          format: (opts.format as 'claude-desktop' | 'claude-code' | 'raw') ?? 'claude-desktop',
        });
        console.log(result.json);
      }
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
