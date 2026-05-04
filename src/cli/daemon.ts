/**
 * Daemon CLI subcommands for MCP Conductor.
 *
 * Designed as a self-contained module so Agent I (X2 lifecycle CLI) can
 * import and register these commands without taking a dependency on the full
 * daemon implementation at the top level.
 *
 * Usage (in the host CLI program):
 *
 * ```typescript
 * import { Command } from 'commander';
 * import { registerDaemonCommands } from './cli/daemon.js';
 *
 * const program = new Command();
 * registerDaemonCommands(program);
 * program.parse();
 * ```
 *
 * Available subcommands:
 *   daemon start   — Start the daemon in the background
 *   daemon stop    — Stop a running daemon
 *   daemon status  — Print daemon health and stats
 *   daemon logs    — Tail the daemon log file
 *
 * @module cli/daemon
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { DaemonClient } from '../daemon/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONDUCTOR_DIR = join(homedir(), '.mcp-conductor');
const PID_FILE = join(CONDUCTOR_DIR, 'daemon.pid');
const LOG_FILE = join(CONDUCTOR_DIR, 'daemon.log');
const SOCKET_PATH = join(CONDUCTOR_DIR, 'daemon.sock');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(): void {
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function daemonStart(options: { port?: string; background?: boolean }): Promise<void> {
  ensureDir();

  const pid = readPid();
  if (pid !== null && isRunning(pid)) {
    console.log(`Daemon is already running (PID ${pid})`);
    return;
  }

  const tcpPort = options.port ? parseInt(options.port, 10) : undefined;

  // Build the daemon entry script args.
  const args: string[] = ['--daemon-server'];
  if (tcpPort) args.push('--tcp-port', String(tcpPort));

  // Spawn the daemon process detached.
  const out = require('node:fs').openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [process.argv[1]!, ...args], {
    detached: true,
    stdio: ['ignore', out, out],
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid), 'utf-8');

  // Brief wait for the socket to appear.
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(SOCKET_PATH)) { ready = true; break; }
  }

  if (ready) {
    console.log(`Daemon started (PID ${child.pid})`);
  } else {
    console.warn(`Daemon spawned (PID ${child.pid}) but socket not yet visible. Check logs: ${LOG_FILE}`);
  }
}

async function daemonStop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log('No PID file found — daemon may not be running.');
    return;
  }

  if (!isRunning(pid)) {
    console.log(`Daemon PID ${pid} is not running.`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    // Wait up to 5 s for the process to exit.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!isRunning(pid)) break;
    }
    if (!isRunning(pid)) {
      console.log(`Daemon (PID ${pid}) stopped.`);
    } else {
      console.warn(`Daemon (PID ${pid}) did not exit in 5 s. Sending SIGKILL.`);
      process.kill(pid, 'SIGKILL');
    }
  } catch (err) {
    console.error(`Failed to stop daemon: ${String(err)}`);
  }
}

async function daemonStatus(): Promise<void> {
  const pid = readPid();

  if (pid === null || !isRunning(pid)) {
    console.log('Daemon: STOPPED');
    return;
  }

  console.log(`Daemon: RUNNING (PID ${pid})`);

  // Try connecting to get live stats.
  try {
    const client = new DaemonClient({ connectTimeoutMs: 2000 });
    await client.connect();
    const stats = await client.stats();
    console.log('Stats:', JSON.stringify(stats, null, 2));
    await client.disconnect();
  } catch (err) {
    console.log(`(Could not fetch live stats: ${String(err)})`);
  }
}

async function daemonLogs(options: { lines?: string; follow?: boolean }): Promise<void> {
  if (!existsSync(LOG_FILE)) {
    console.log('No log file found at', LOG_FILE);
    return;
  }

  const n = parseInt(options.lines ?? '50', 10);

  if (options.follow) {
    // Simple tail -f implementation using a ReadStream.
    const stat = statSync(LOG_FILE);
    const stream = createReadStream(LOG_FILE, {
      start: Math.max(0, stat.size - 8192),
      encoding: 'utf-8',
    });
    stream.pipe(process.stdout);
    stream.on('end', () => {
      // Keep watching by polling — Node.js fs.watch is enough for a dev tool.
      let lastSize = stat.size;
      const interval = setInterval(() => {
        try {
          const newStat = statSync(LOG_FILE);
          if (newStat.size > lastSize) {
            const tail = createReadStream(LOG_FILE, {
              start: lastSize,
              encoding: 'utf-8',
            });
            tail.pipe(process.stdout);
            lastSize = newStat.size;
          }
        } catch { clearInterval(interval); }
      }, 500);
      process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
    });
  } else {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const tail = lines.slice(-n).join('\n');
    console.log(tail);
  }
}

// ---------------------------------------------------------------------------
// Registration function (Agent I integration point)
// ---------------------------------------------------------------------------

/**
 * Register all daemon subcommands onto a Commander `program` instance.
 *
 * @example
 * ```typescript
 * import { Command } from 'commander';
 * import { registerDaemonCommands } from './cli/daemon.js';
 * const program = new Command('mcp-conductor-cli');
 * registerDaemonCommands(program);
 * program.parse();
 * ```
 */
export function registerDaemonCommands(program: {
  command: (name: string) => DaemonCommandBuilder;
}): void {
  const daemon = (program.command('daemon') as unknown as { description: (d: string) => DaemonCommandBuilder }).description(
    'Manage the MCP Conductor daemon process',
  );

  // daemon start
  (daemon as unknown as { command: (n: string) => DaemonCommandBuilder }).command('start')
    .description('Start the daemon in the background')
    .option('--port <port>', 'TCP port for Tailscale clients')
    .action(async (...args: unknown[]) => {
      await daemonStart(args[0] as { port?: string });
    });

  // daemon stop
  (daemon as unknown as { command: (n: string) => DaemonCommandBuilder }).command('stop')
    .description('Stop the running daemon')
    .action(async () => {
      await daemonStop();
    });

  // daemon status
  (daemon as unknown as { command: (n: string) => DaemonCommandBuilder }).command('status')
    .description('Show daemon health and statistics')
    .action(async () => {
      await daemonStatus();
    });

  // daemon logs
  (daemon as unknown as { command: (n: string) => DaemonCommandBuilder }).command('logs')
    .description('Show daemon log output')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .action(async (...args: unknown[]) => {
      await daemonLogs(args[0] as { lines?: string; follow?: boolean });
    });
}

// ---------------------------------------------------------------------------
// Minimal Commander-compatible type stubs
// ---------------------------------------------------------------------------

/** Minimal interface matching Commander's Command for type safety without the dep. */
interface DaemonCommandBuilder {
  description: (d: string) => DaemonCommandBuilder;
  option: (flags: string, description?: string, defaultValue?: string) => DaemonCommandBuilder;
  action: (fn: (...args: unknown[]) => void | Promise<void>) => DaemonCommandBuilder;
  command: (name: string) => DaemonCommandBuilder;
}

// ---------------------------------------------------------------------------
// Exported individual action functions (for programmatic use and testing)
// ---------------------------------------------------------------------------

export { daemonStart, daemonStop, daemonStatus, daemonLogs };
