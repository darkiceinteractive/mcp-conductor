/**
 * Helpers for running each AI CLI non-interactively with mcp-conductor injected.
 *
 * Uses Node's built-in child_process.spawn — no execa dependency.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(
  join(__dirname, '..', '..', '..', '..', 'dist', 'index.js')
);

const CONDUCTOR_CONFIG_PATH = '/Users/mattcrombie/.mcp-conductor.json';

/** MCP config block injected into Claude via --mcp-config */
const CLAUDE_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'mcp-conductor': {
      command: 'node',
      args: [CONDUCTOR_DIST],
      env: { MCP_CONDUCTOR_CONFIG: CONDUCTOR_CONFIG_PATH },
    },
  },
});

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function runProcess(
  command: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    env?: Record<string, string>;
    cwd?: string;
  } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const { timeoutMs = 120_000, env, cwd } = opts;

    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      cwd,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000);
    }, timeoutMs);

    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? -1 : (code ?? -1),
        durationMs: Date.now() - t0,
      });
    });

    proc.once('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: -1,
        durationMs: Date.now() - t0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Run claude non-interactively with mcp-conductor injected via --mcp-config.
 * Uses --bare to get clean output, --strict-mcp-config to ensure conductor is used.
 */
export async function runClaude(
  prompt: string,
  opts: { timeoutMs?: number } = {}
): Promise<CliResult> {
  return runProcess(
    'claude',
    [
      '--bare',
      '-p', prompt,
      '--mcp-config', CLAUDE_MCP_CONFIG,
      '--strict-mcp-config',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ],
    { timeoutMs: opts.timeoutMs ?? 120_000 }
  );
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Run gemini non-interactively. MCP config must be pre-injected into
 * ~/.gemini/settings.json by client-config-manager before calling this.
 */
export async function runGemini(
  prompt: string,
  opts: { timeoutMs?: number } = {}
): Promise<CliResult> {
  return runProcess(
    'gemini',
    ['-p', prompt, '--yolo'],
    { timeoutMs: opts.timeoutMs ?? 120_000 }
  );
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

/**
 * Run kimi non-interactively. MCP config must be pre-injected into
 * ~/.kimi/mcp.json by client-config-manager before calling this.
 */
export async function runKimi(
  prompt: string,
  opts: { timeoutMs?: number } = {}
): Promise<CliResult> {
  return runProcess(
    'kimi',
    ['--print', '--prompt', prompt, '--yolo'],
    { timeoutMs: opts.timeoutMs ?? 120_000 }
  );
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/**
 * Run opencode non-interactively. MCP config must be pre-injected into
 * ~/.config/opencode/opencode.jsonc by client-config-manager before calling this.
 */
export async function runOpenCode(
  prompt: string,
  opts: { timeoutMs?: number } = {}
): Promise<CliResult> {
  return runProcess(
    'opencode',
    ['run', '--format', 'json', prompt],
    { timeoutMs: opts.timeoutMs ?? 120_000 }
  );
}
