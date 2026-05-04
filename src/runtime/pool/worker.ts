/**
 * Individual Deno Worker Lifecycle
 *
 * Manages a single warm Deno worker subprocess. The worker runs a persistent
 * bootstrap script that:
 *   1. Accepts a list of preload helper scripts (Phase 5 plug-in point)
 *   2. Waits for job messages on stdin, executes the code, returns results on stdout
 *
 * Communication protocol (newline-delimited JSON over stdio):
 *   host → worker: { id, code, context }
 *   worker → host: { id, success, result?, error?, logs }
 *
 * @module runtime/pool/worker
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger, minimalChildEnv } from '../../utils/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerOptions {
  /** Directory containing generated .d.ts files from the registry */
  preloadTypesDir: string;
  /**
   * Additional helper scripts to preload (absolute paths or Deno URLs).
   * Phase 5 (Agent E) plugs compact/summarize/delta helpers in here.
   */
  preloadHelpers?: string[];
  /** Maximum old-space memory for the Deno process (MB) */
  maxMemoryMb?: number;
  /** Bridge URL the sandbox code uses for MCP calls */
  bridgeUrl?: string;
}

export interface WorkerJob {
  /** Unique job identifier for routing responses */
  id: string;
  /** TypeScript source code to execute */
  code: string;
  /** Execution context injected as global variables */
  context: Record<string, unknown>;
  /** Optional AbortSignal to cancel in-flight job */
  signal?: AbortSignal;
}

export interface WorkerResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: { message: string; stack?: string };
  logs: string[];
}

/**
 * B7: 'starting' is added so the pool can push a replacement worker into
 * `this.workers` synchronously before calling `replacement.start()`. While
 * the worker is in 'starting' state it is excluded from `_findIdle()`,
 * preventing jobs from being routed to a not-yet-ready process.
 */
export type WorkerState = 'starting' | 'idle' | 'busy' | 'recycling' | 'dead';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap script written to a temp file once per worker
// ─────────────────────────────────────────────────────────────────────────────

function buildBootstrapScript(opts: WorkerOptions): string {
  const preloads = (opts.preloadHelpers ?? [])
    .map((p) => `await import(${JSON.stringify(p)});`)
    .join('\n');

  return `
// MCP Conductor — Warm Worker Bootstrap
// This script runs persistently inside a Deno subprocess.
// It receives jobs on stdin and returns results on stdout.

// Preload Phase-5 helpers when available
${preloads}

const __bridgeUrl = ${JSON.stringify(opts.bridgeUrl ?? 'http://127.0.0.1:9847')};
const __logs: string[] = [];

// Override console.log to capture output
const __origLog = console.log;
console.log = (...args: unknown[]) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  __logs.push(msg);
  __origLog(...args);
};

// MCPServerClient — mirrors executor.ts sandbox runtime
class MCPServerClient {
  constructor(public readonly name: string) {}
  async call(tool: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(\`\${__bridgeUrl}/call\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: this.name, tool, params }),
    });
    const data = await response.json();
    if (data.error) throw new Error(\`Tool error (\${this.name}.\${tool}): \${data.error.message}\`);
    return data.result;
  }
}

const __mcpBase = {
  server(name: string) { return new MCPServerClient(name); },
  log(...args: unknown[]) { console.log(...args); },
};
const mcp = new Proxy(__mcpBase, {
  get(t, p) {
    if (p in t) return (t as Record<string|symbol, unknown>)[p];
    if (typeof p === 'string') return new MCPServerClient(p);
    return undefined;
  },
});

// Main job loop — read one JSON line per job
const decoder = new TextDecoder();
let buf = '';

async function processLine(line: string): Promise<void> {
  let job: { id: string; code: string; context: Record<string, unknown> };
  try {
    job = JSON.parse(line);
  } catch {
    return; // malformed, skip
  }

  __logs.length = 0; // reset per job

  let result: unknown;
  let error: { message: string; stack?: string } | undefined;
  let success = true;

  try {
    // Execute user code in an async wrapper with mcp in scope
    const __fn = new Function('mcp', '__ctx', \`return (async () => { \${job.code} })()\`);
    result = await __fn(mcp, job.context ?? {});
  } catch (err: unknown) {
    success = false;
    const e = err as Error;
    error = { message: e.message, stack: e.stack };
  }

  const response = JSON.stringify({ id: job.id, success, result, error, logs: [...__logs] });
  __origLog(response); // use original console.log to avoid capture loop
}

// Read stdin line by line
for await (const chunk of Deno.stdin.readable) {
  buf += decoder.decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) await processLine(line);
  }
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PooledWorker
// ─────────────────────────────────────────────────────────────────────────────

let workerSeq = 0;

export class PooledWorker {
  readonly id: string;
  // B7: Initial state is 'starting' (not 'idle') so that a freshly constructed
  // replacement pushed into the pool array is invisible to _findIdle() until
  // its start() promise resolves and transitions it to 'idle'.
  private state: WorkerState = 'starting';
  private proc: ChildProcess | null = null;
  private bootstrapFile: string | null = null;
  private lineBuffer = '';
  private pending: Map<string, {
    resolve: (r: WorkerResult) => void;
    reject: (e: Error) => void;
  }> = new Map();

  readonly createdAt = Date.now();
  jobsRun = 0;

  constructor(private readonly opts: WorkerOptions) {
    this.id = `worker-${++workerSeq}-${Date.now()}`;
  }

  get currentState(): WorkerState {
    return this.state;
  }

  get isIdle(): boolean {
    return this.state === 'idle';
  }

  /** Spawn the Deno subprocess. */
  async start(): Promise<void> {
    const script = buildBootstrapScript(this.opts);
    const tmpPath = join(tmpdir(), `mcp-worker-${this.id}.ts`);
    writeFileSync(tmpPath, script);
    this.bootstrapFile = tmpPath;

    const maxMemMb = this.opts.maxMemoryMb ?? 128;

    const proc = spawn('deno', [
      'run',
      '--allow-net',
      '--allow-read',
      '--no-prompt',
      `--v8-flags=--max-old-space-size=${maxMemMb}`,
      tmpPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: minimalChildEnv({
        DENO_DIR: process.env.DENO_DIR,
        NO_COLOR: '1',
      }),
    });

    this.proc = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, nl).trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        if (line) this._handleLine(line);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        logger.debug('Worker stderr', { workerId: this.id, text: text.slice(0, 500) });
      }
    });

    proc.on('close', (code) => {
      this._handleClose(code ?? -1);
    });

    proc.on('error', (err) => {
      logger.error('Worker spawn error', { workerId: this.id, err: err.message });
      this._rejectAll(err);
      this.state = 'dead';
    });

    // Brief pause to allow the Deno runtime to initialise before accepting jobs.
    // This ensures the warm-up cost is paid at pool startup, not at first job.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 50);
      if (t.unref) t.unref();
    });

    // B7: Transition from 'starting' to 'idle' only after the subprocess is
    // ready. The pool pushes the worker into this.workers while still in
    // 'starting' state; _findIdle() checks for 'idle' so no jobs are routed
    // here until this line executes.
    this.state = 'idle';
    logger.debug('Worker started', { workerId: this.id });
  }

  /**
   * Execute a job on this worker.
   * The worker must be idle before calling this.
   */
  execute(job: WorkerJob): Promise<WorkerResult> {
    if (this.state !== 'idle') {
      return Promise.reject(new Error(`Worker ${this.id} is not idle (state: ${this.state})`));
    }
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`Worker ${this.id} stdin is not writable`));
    }

    this.state = 'busy';
    this.jobsRun++;

    return new Promise<WorkerResult>((resolve, reject) => {
      // Honour AbortSignal cancellation
      const onAbort = () => {
        this.pending.delete(job.id);
        this.state = 'idle';
        reject(new Error('Job cancelled by AbortSignal'));
      };

      if (job.signal?.aborted) {
        this.state = 'idle';
        this.jobsRun--; // didn't actually run
        onAbort();
        return;
      }
      job.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(job.id, {
        resolve: (result) => {
          job.signal?.removeEventListener('abort', onAbort);
          this.state = 'idle';
          resolve(result);
        },
        reject: (err) => {
          job.signal?.removeEventListener('abort', onAbort);
          this.state = 'idle';
          reject(err);
        },
      });

      const message = JSON.stringify({ id: job.id, code: job.code, context: job.context });
      try {
        this.proc!.stdin!.write(message + '\n');
      } catch (writeErr) {
        this.pending.delete(job.id);
        this.state = 'idle';
        job.signal?.removeEventListener('abort', onAbort);
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
      }
    });
  }

  /**
   * Gracefully shut down the worker.
   * If `drainFirst` is true, waits for any in-flight job to complete.
   */
  async shutdown(drainFirst = true): Promise<void> {
    if (this.state === 'dead') return;

    if (drainFirst && this.state === 'busy') {
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (this.state !== 'busy') {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
    }

    this.state = 'recycling';
    this._terminate();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private _handleLine(line: string): void {
    let msg: WorkerResult;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn('Worker: unparseable response', { workerId: this.id, line: line.slice(0, 200) });
      return;
    }

    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      pending.resolve(msg);
    }
  }

  private _handleClose(code: number): void {
    this.state = 'dead';
    this._cleanup();
    this._rejectAll(new Error(`Worker ${this.id} exited with code ${code}`));
    logger.debug('Worker exited', { workerId: this.id, code });
  }

  private _rejectAll(err: Error): void {
    for (const [, handlers] of this.pending) {
      handlers.reject(err);
    }
    this.pending.clear();
  }

  private _terminate(): void {
    try {
      this.proc?.kill('SIGTERM');
      const t = setTimeout(() => {
        try { this.proc?.kill('SIGKILL'); } catch { /* already gone */ }
      }, 2000);
      if (t.unref) t.unref();
    } catch {
      // Already dead
    }
    this._cleanup();
  }

  private _cleanup(): void {
    if (this.bootstrapFile) {
      try { unlinkSync(this.bootstrapFile); } catch { /* ignore */ }
      this.bootstrapFile = null;
    }
  }
}
