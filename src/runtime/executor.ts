/**
 * Deno Sandbox Executor
 *
 * Executes user code in an isolated Deno subprocess with access to the MCP API.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger, generateExecutionId, TimeoutError, RuntimeError, SyntaxError, minimalChildEnv } from '../utils/index.js';
import type { SandboxConfig } from '../config/index.js';
import { LIFECYCLE_TIMEOUTS } from '../config/defaults.js';

export interface ExecutionResult {
  /** Unique execution ID for tracking and streaming */
  executionId: string;
  success: boolean;
  result?: unknown;
  error?: {
    type: 'syntax' | 'runtime' | 'timeout' | 'security';
    message: string;
    stack?: string;
    line?: number;
  };
  logs: string[];
  metrics: {
    executionTimeMs: number;
    toolCalls: number;
    dataProcessedBytes: number;
    resultSizeBytes: number;
  };
}

export interface ExecutionOptions {
  timeoutMs: number;
  bridgeUrl: string;
  servers: string[];
  /** Enable streaming mode for real-time progress updates */
  stream?: boolean;
  /**
   * AbortSignal tied to the caller's request. When the signal fires we
   * terminate the Deno process via the same SIGTERM→SIGKILL path used for
   * shutdown. Surfaces MCP cancellation from the client side.
   */
  signal?: AbortSignal;
  /**
   * Caller-provided execution id. Lets the MCP server preallocate the id
   * and subscribe to the matching ExecutionStream *before* Deno spawns, so
   * we never miss the first progress event.
   */
  executionId?: string;
}

/**
 * Generate the sandbox code template that wraps user code
 */
function generateSandboxCode(
  userCode: string,
  bridgeUrl: string,
  executionId: string,
  streamEnabled: boolean,
  timeoutMs: number
): string {
  return `
// MCP Executor Sandbox Runtime
// Execution ID: ${executionId}

const BRIDGE_URL = "${bridgeUrl}";
const EXECUTION_ID = "${executionId}";
const STREAM_ENABLED = ${streamEnabled};
const TIMEOUT_MS = ${timeoutMs};

// Metrics tracking
const __metrics = {
  toolCalls: 0,
  dataProcessedBytes: 0,
};

// Logs collection
const __logs: string[] = [];

// Rate limit tracking per server
const __rateLimits: Record<string, { detected: boolean; delayMs: number; lastError: number }> = {};

// X4 PII reverse map — accumulated from tool call responses within this execution.
// Tokens minted in a prior execute_code call are NOT present here (each call
// gets a fresh map). Never returned to Claude — used only by mcp.detokenize().
const __reverseMap: Record<string, string> = {};

// Helper to detect if response is a rate limit error
function __isRateLimitError(result: unknown): boolean {
  if (typeof result === 'string') {
    return result.toLowerCase().includes('rate limit');
  }
  if (result && typeof result === 'object') {
    const str = JSON.stringify(result).toLowerCase();
    return str.includes('rate limit') || str.includes('rate_limit') || str.includes('429');
  }
  return false;
}

// Sleep helper
const __sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Streaming helper - sends events to the bridge when streaming is enabled
async function __streamEvent(endpoint: string, data: Record<string, unknown>): Promise<void> {
  if (!STREAM_ENABLED) return;
  try {
    await fetch(\`\${BRIDGE_URL}\${endpoint}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId: EXECUTION_ID, ...data }),
    });
  } catch {
    // Silently ignore streaming errors to not affect execution
  }
}

// Override console.log to capture output and optionally stream
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  __logs.push(message);
  originalConsoleLog(...args);

  // Stream logs in real-time when enabled
  if (STREAM_ENABLED) {
    __streamEvent('/log', { message, level: 'info' });
  }
};

// MCPToolError shim — mirrors the server-side class so instanceof checks work
// in the sandbox without importing the server bundle.
class MCPToolError extends Error {
  readonly name = 'MCPToolError';
  constructor(
    readonly code: string,
    readonly server: string,
    readonly tool: string,
    readonly upstream: unknown
  ) {
    super(\`[\${server}.\${tool}] \${code}\`);
    Object.setPrototypeOf(this, MCPToolError.prototype);
  }
}

// MCP Server Client with streaming support
class MCPServerClient {
  constructor(public readonly name: string) {}

  async call(tool: string, params: Record<string, unknown> = {}): Promise<unknown> {
    __metrics.toolCalls++;
    const startTime = Date.now();

    // Report tool call start when streaming
    if (STREAM_ENABLED) {
      await __streamEvent('/tool-event', {
        server: this.name,
        tool,
        status: 'started',
      });
    }

    try {
      const response = await fetch(\`\${BRIDGE_URL}/call\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: this.name,
          tool,
          params,
        }),
      });

      const data = await response.json();
      const durationMs = Date.now() - startTime;

      if (data.metrics?.dataSize) {
        __metrics.dataProcessedBytes += data.metrics.dataSize;
      }

      // X4: accumulate PII reverse map tokens from this tool call into the
      // execution-scoped map so mcp.detokenize() can resolve them.
      if (data.reverseMap && typeof data.reverseMap === 'object') {
        Object.assign(__reverseMap, data.reverseMap);
      }

      if (data.error) {
        // Report tool call error when streaming
        if (STREAM_ENABLED) {
          await __streamEvent('/tool-event', {
            server: this.name,
            tool,
            status: 'error',
            durationMs,
            error: data.error.message,
          });
        }
        // Reconstruct MCPToolError if the bridge serialized structured fields
        if (data.error.type === 'mcp_tool_error' && data.error.code !== undefined) {
          throw new MCPToolError(data.error.code, data.error.server ?? this.name, data.error.tool ?? tool, data.error.message);
        }
        throw new Error(\`Tool error (\${this.name}.\${tool}): \${data.error.message}\`);
      }

      // Report tool call completion when streaming
      if (STREAM_ENABLED) {
        await __streamEvent('/tool-event', {
          server: this.name,
          tool,
          status: 'completed',
          durationMs,
        });
      }

      return data.result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Report tool call error when streaming
      if (STREAM_ENABLED) {
        await __streamEvent('/tool-event', {
          server: this.name,
          tool,
          status: 'error',
          durationMs,
          error: String(error),
        });
      }

      throw error;
    }
  }

  async tools(): Promise<Array<{ name: string; description: string }>> {
    const response = await fetch(\`\${BRIDGE_URL}/servers/\${this.name}/tools\`);
    const data = await response.json();
    return data.tools || [];
  }

  hasTool(name: string): boolean {
    // Synchronous check not available in sandbox, return true and let call() fail
    return true;
  }
}

// MCP Global API (internal - will be wrapped with Proxy)
const __mcpBase = {
  // List available servers
  servers(): string[] {
    // Will be populated from sync call if needed
    return [];
  },

  // Get a server client by name
  server(name: string): MCPServerClient {
    return new MCPServerClient(name);
  },

  // Search tools across all servers
  async searchTools(query: string): Promise<Array<{ server: string; tool: string; description: string }>> {
    const response = await fetch(\`\${BRIDGE_URL}/search?q=\${encodeURIComponent(query)}\`);
    const data = await response.json();
    return data.results || [];
  },

  // Synchronous search (from cached list)
  searchToolsSync(query: string): Array<{ server: string; tool: string; description: string }> {
    // Not available in sandbox without pre-cached data
    return [];
  },

  // Report progress - streams to bridge when enabled, always logs
  async progress(percent: number, message?: string): Promise<void> {
    const logMessage = \`[PROGRESS] \${percent}%\${message ? ': ' + message : ''}\`;
    __logs.push(logMessage);
    originalConsoleLog(logMessage);

    if (STREAM_ENABLED) {
      await __streamEvent('/progress', { percent, message });
    }
  },

  // Log helper with optional level
  log(...args: unknown[]): void {
    console.log(...args);
  },

  // Log with specific level (when streaming, this sends the level)
  async logLevel(level: 'info' | 'warn' | 'error' | 'debug', ...args: unknown[]): Promise<void> {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    __logs.push(\`[\${level.toUpperCase()}] \${message}\`);
    originalConsoleLog(\`[\${level.toUpperCase()}]\`, ...args);

    if (STREAM_ENABLED) {
      await __streamEvent('/log', { message, level });
    }
  },

  // Execution context
  context: {
    timeout_ms: TIMEOUT_MS,
    execution_id: EXECUTION_ID,
    stream_enabled: STREAM_ENABLED,
    loaded_servers: [] as string[],
  },

  /**
   * X4 PII detokenization — recover the original sensitive value for a token
   * minted by the hub's response tokenizer within this same execute_code call.
   *
   * Example:
   *   const email = mcp.detokenize('[EMAIL_1]'); // → 'x@y.com'
   *   await mcp.server('crm').call('lookup', { email });
   *
   * Returns undefined if the token was not minted in this call (e.g. it comes
   * from a prior execute_code call — tokens do not survive call boundaries).
   * Never call this on the final return value — Claude should see the token.
   */
  detokenize(token: string): string | undefined {
    return __reverseMap[token];
  },

  // Skills API placeholder for MVP
  skills: {
    list(): Array<{ name: string; category: string; description: string }> {
      return [];
    },
    load(name: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
      throw new Error(\`Skills not available in MVP: \${name}\`);
    },
    search(query: string): Array<{ name: string; description: string; relevance: number }> {
      return [];
    },
  },

  /**
   * Smart batch execution with automatic rate limit detection and handling.
   * Attempts parallel execution first, falls back to sequential with delays if rate limited.
   *
   * Two call shapes are supported:
   *   1. Descriptor form (rate-limit aware): \`mcp.batch([{ server, tool, params }, ...])\`
   *   2. Callback form (composable, bypasses rate-limit detection):
   *      \`mcp.batch([() => mcp.server('x').call('y', {}), ...])\`
   *
   * Mix-and-match in one call is not supported — pick a shape per call.
   *
   * @param calls Array of descriptors OR array of () => Promise<T>
   * @param options Optional { maxParallel, retryDelayMs }
   * @returns Array of results in same order as calls
   */
  async batch<T = unknown>(
    calls: Array<
      | { server: string; tool: string; params?: Record<string, unknown> }
      | (() => Promise<T>)
    >,
    options: { maxParallel?: number; retryDelayMs?: number; forceParallel?: boolean } = {}
  ): Promise<T[]> {
    // Detect callback form by inspecting the first element. The callback form
    // bypasses rate-limit detection because we don't know which servers are
    // being called — Promise.all is sufficient.
    if (calls.length > 0 && typeof calls[0] === 'function') {
      return Promise.all((calls as Array<() => Promise<T>>).map(fn => fn()));
    }

    // Descriptor form — preserves all existing behaviour (rate limits, retries).
    const descriptorCalls = calls as Array<{ server: string; tool: string; params?: Record<string, unknown> }>;
    const { maxParallel = descriptorCalls.length, retryDelayMs = 1100, forceParallel = false } = options;
    const results: T[] = new Array(descriptorCalls.length);

    // Clear rate limit cache if forcing parallel (e.g., after API upgrade)
    if (forceParallel) {
      for (const call of descriptorCalls) {
        delete __rateLimits[call.server];
      }
      mcp.log(\`🔄 Force parallel mode enabled - rate limit cache cleared\`);
    }

    // Check if any server has known rate limits
    const hasKnownRateLimit = !forceParallel && descriptorCalls.some(c => __rateLimits[c.server]?.detected);

    if (hasKnownRateLimit) {
      // Sequential with delays for rate-limited servers
      for (let i = 0; i < descriptorCalls.length; i++) {
        const { server, tool, params = {} } = descriptorCalls[i];
        const rateLimit = __rateLimits[server];
        if (rateLimit?.detected && i > 0) {
          await __sleep(rateLimit.delayMs);
        }
        const client = new MCPServerClient(server);
        results[i] = await client.call(tool, params) as T;
      }
      return results;
    }

    // Try parallel execution first
    const parallelResults = await Promise.all(
      descriptorCalls.map(async ({ server, tool, params = {} }) => {
        const client = new MCPServerClient(server);
        return client.call(tool, params);
      })
    );

    // Check for rate limit errors
    const rateLimitedIndices: number[] = [];
    for (let i = 0; i < parallelResults.length; i++) {
      if (__isRateLimitError(parallelResults[i])) {
        rateLimitedIndices.push(i);
        // Mark this server as rate limited
        __rateLimits[descriptorCalls[i].server] = {
          detected: true,
          delayMs: retryDelayMs,
          lastError: Date.now(),
        };
        mcp.log(\`⚠️  RATE LIMITED: \${descriptorCalls[i].server} - Free tier limit hit. Retrying with delays...\`);
        mcp.log(\`💡 TIP: Upgrade your API plan for parallel execution: https://brave.com/search/api/\`);
      } else {
        results[i] = parallelResults[i] as T;
      }
    }

    // Retry rate-limited calls sequentially
    if (rateLimitedIndices.length > 0) {
      for (const idx of rateLimitedIndices) {
        await __sleep(retryDelayMs);
        const { server, tool, params = {} } = descriptorCalls[idx];
        const client = new MCPServerClient(server);
        results[idx] = await client.call(tool, params) as T;
      }
    }

    return results;
  },

  /**
   * Convenience method for batched web searches via brave-search.
   * Automatically handles rate limiting and parses results.
   *
   * @param queries Array of search query strings
   * @param options { topN: number of results per query (default 3) }
   * @returns Object mapping queries to parsed results
   */
  async batchSearch(
    queries: string[],
    options: { topN?: number; forceParallel?: boolean } = {}
  ): Promise<Record<string, Array<{ title: string; url: string; description?: string }>>> {
    const { topN = 3, forceParallel = false } = options;

    // Parser for brave-search text response
    const parseResults = (text: unknown): Array<{ title: string; url: string; description?: string }> => {
      if (typeof text !== 'string' || text.startsWith('Error:')) return [];
      return text.split(/\\n\\nTitle:/).map((block: string, i: number) => {
        const b = i === 0 ? block : 'Title:' + block;
        const title = b.match(/Title:\\s*([^\\n]+)/)?.[1]?.trim();
        const url = b.match(/URL:\\s*([^\\n]+)/)?.[1]?.trim();
        const desc = b.match(/Description:\\s*([^\\n]+)/)?.[1]?.trim();
        return title && url ? { title, url, description: desc } : null;
      }).filter((r): r is { title: string; url: string; description?: string } => r !== null);
    };

    const calls = queries.map(query => ({
      server: 'brave-search',
      tool: 'brave_web_search',
      params: { query },
    }));

    const rawResults = await this.batch<string>(calls, { forceParallel });
    const result: Record<string, Array<{ title: string; url: string; description?: string }>> = {};

    for (let i = 0; i < queries.length; i++) {
      result[queries[i]] = parseResults(rawResults[i]).slice(0, topN);
    }

    return result;
  },
};

// Create Proxy to allow mcp.serverName syntax (e.g., mcp.github instead of mcp.server('github'))
const mcp = new Proxy(__mcpBase, {
  get(target, prop) {
    if (prop in target) {
      return (target as Record<string | symbol, unknown>)[prop];
    }
    // Treat as server name for attribute-style access
    if (typeof prop === 'string') {
      return new MCPServerClient(prop);
    }
    return undefined;
  },
});

// Main execution wrapper
async function __execute() {
  ${userCode}
}

// Run and output result
(async () => {
  try {
    // Report start when streaming
    if (STREAM_ENABLED) {
      await __streamEvent('/log', { message: 'Execution started', level: 'info' });
      await __streamEvent('/progress', { percent: 0, message: 'Starting execution' });
    }

    const result = await __execute();

    // Report completion when streaming
    if (STREAM_ENABLED) {
      await __streamEvent('/progress', { percent: 100, message: 'Execution complete' });
    }

    // Output structured result for parent process to parse
    // When streaming, logs have already been sent in real-time, so omit them to save tokens
    console.log('__RESULT_START__');
    console.log(JSON.stringify({
      success: true,
      result,
      logs: STREAM_ENABLED ? [] : __logs,
      metrics: __metrics,
    }));
    console.log('__RESULT_END__');
  } catch (error) {
    const err = error as Error;

    // Report error when streaming
    if (STREAM_ENABLED) {
      await __streamEvent('/log', { message: \`Error: \${err.message}\`, level: 'error' });
    }

    console.log('__RESULT_START__');
    console.log(JSON.stringify({
      success: false,
      error: {
        type: 'runtime',
        message: err.message,
        stack: err.stack,
      },
      logs: STREAM_ENABLED ? [] : __logs,
      metrics: __metrics,
    }));
    console.log('__RESULT_END__');
  }
})();
`;
}

/**
 * Deno Sandbox Executor
 */
export class DenoExecutor {
  private config: SandboxConfig;
  private tempDir: string;
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private maxConcurrentProcesses: number;
  private maxOutputBytes: number;
  private isShuttingDown = false;
  private denoAvailable: boolean | null = null;

  constructor(config: SandboxConfig) {
    this.config = config;
    this.maxConcurrentProcesses = config.maxConcurrentProcesses ?? 8;
    this.maxOutputBytes = config.maxOutputBytes ?? 10 * 1024 * 1024;
    this.tempDir = join(tmpdir(), 'mcp-executor');

    // Ensure temp directory exists
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }

    // Clean up stale temp files from previous crashes
    this.cleanupStaleTempFiles();
  }

  /**
   * Remove leftover temp files from previous executions that survived crashes.
   *
   * Only files older than `STALE_TEMP_FILE_TTL_MS` are removed. Deleting
   * every `exec_*.ts` unconditionally would race with peer executors running
   * in parallel (Vitest worker pool, or multiple conductor instances sharing
   * `/tmp/mcp-executor`) and yank a temp file out from under an in-flight
   * `deno run`.
   */
  private cleanupStaleTempFiles(): void {
    const STALE_TEMP_FILE_TTL_MS = 60_000;
    const now = Date.now();
    try {
      const files = readdirSync(this.tempDir)
        .filter(f => f.startsWith('exec_') && f.endsWith('.ts'));
      let removed = 0;
      for (const f of files) {
        const path = join(this.tempDir, f);
        try {
          const { mtimeMs } = statSync(path);
          if (now - mtimeMs > STALE_TEMP_FILE_TTL_MS) {
            unlinkSync(path);
            removed++;
          }
        } catch {
          // Ignore individual file stat/unlink failures
        }
      }
      if (removed > 0) {
        logger.debug(`Cleaned up ${removed} stale temp files`);
      }
    } catch {
      // Ignore errors reading temp directory
    }
  }

  /**
   * Check if Deno is available (cached after first successful check)
   */
  async checkDeno(): Promise<boolean> {
    if (this.denoAvailable !== null) return this.denoAvailable;

    return new Promise((resolve) => {
      const proc = spawn('deno', ['--version'], { stdio: 'pipe' });
      proc.on('close', (code) => {
        this.denoAvailable = code === 0;
        resolve(this.denoAvailable);
      });
      proc.on('error', () => {
        this.denoAvailable = false;
        resolve(false);
      });
    });
  }

  /**
   * Shutdown executor: kill all active Deno processes
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.activeProcesses.size === 0) return;

    logger.info(`Killing ${this.activeProcesses.size} active Deno processes`);

    const killPromises = Array.from(this.activeProcesses.entries()).map(
      ([_id, proc]) => {
        return new Promise<void>((resolve) => {
          const forceKillTimer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            resolve();
          }, LIFECYCLE_TIMEOUTS.PROCESS_FORCE_KILL_MS);
          forceKillTimer.unref();

          proc.on('close', () => {
            clearTimeout(forceKillTimer);
            resolve();
          });
          proc.on('error', () => {
            clearTimeout(forceKillTimer);
            resolve();
          });

          try {
            proc.kill('SIGTERM');
          } catch {
            clearTimeout(forceKillTimer);
            resolve();
          }
        });
      }
    );

    await Promise.allSettled(killPromises);
    this.activeProcesses.clear();
    logger.info('All Deno processes terminated');
  }

  /**
   * Get count of currently running processes
   */
  getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Execute code in the Deno sandbox
   */
  async execute(code: string, options: ExecutionOptions): Promise<ExecutionResult> {
    const executionId = options.executionId ?? generateExecutionId();
    const startTime = Date.now();
    const streamEnabled = options.stream ?? false;

    // Short-circuit if the caller already cancelled before we started.
    if (options.signal?.aborted) {
      return {
        executionId,
        success: false,
        error: { type: 'runtime', message: 'Execution cancelled before start' },
        logs: [],
        metrics: { executionTimeMs: 0, toolCalls: 0, dataProcessedBytes: 0, resultSizeBytes: 0 },
      };
    }

    logger.debug('Starting execution', { executionId, streamEnabled });

    // Validate Deno is available
    const hasDenoAvailable = await this.checkDeno();
    if (!hasDenoAvailable) {
      return {
        executionId,
        success: false,
        error: {
          type: 'runtime',
          message: 'Deno runtime not found. Please install Deno: https://deno.land/#installation',
        },
        logs: [],
        metrics: {
          executionTimeMs: Date.now() - startTime,
          toolCalls: 0,
          dataProcessedBytes: 0,
          resultSizeBytes: 0,
        },
      };
    }

    // Generate sandbox code with streaming support
    const sandboxCode = generateSandboxCode(
      code,
      options.bridgeUrl,
      executionId,
      streamEnabled,
      options.timeoutMs
    );

    // Write to temp file
    const tempFile = join(this.tempDir, `exec_${executionId}.ts`);
    writeFileSync(tempFile, sandboxCode);

    try {
      const result = await this.runDeno(
        tempFile,
        options.timeoutMs,
        executionId,
        options.bridgeUrl,
        options.signal,
      );
      return {
        ...result,
        executionId,
        metrics: {
          ...result.metrics,
          executionTimeMs: Date.now() - startTime,
          resultSizeBytes: result.result ? JSON.stringify(result.result).length : 0,
        },
      };
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get an execution ID without executing (for pre-creating streams)
   */
  generateExecutionId(): string {
    return generateExecutionId();
  }

  /**
   * Run Deno subprocess
   */
  private runDeno(
    filePath: string,
    timeoutMs: number,
    executionId: string,
    bridgeUrl: string,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      // Reject if shutting down
      if (this.isShuttingDown) {
        resolve({
          executionId,
          success: false,
          error: { type: 'runtime', message: 'Server is shutting down' },
          logs: [],
          metrics: { executionTimeMs: 0, toolCalls: 0, dataProcessedBytes: 0, resultSizeBytes: 0 },
        });
        return;
      }

      // Enforce concurrency limit
      if (this.activeProcesses.size >= this.maxConcurrentProcesses) {
        resolve({
          executionId,
          success: false,
          error: {
            type: 'runtime',
            message: `Maximum concurrent executions reached (${this.maxConcurrentProcesses}). Try again shortly.`,
          },
          logs: [],
          metrics: { executionTimeMs: 0, toolCalls: 0, dataProcessedBytes: 0, resultSizeBytes: 0 },
        });
        return;
      }

      // Extract port from bridge URL
      let bridgePort = 9847; // Default
      try {
        const url = new URL(bridgeUrl);
        bridgePort = parseInt(url.port, 10) || 9847;
      } catch {
        // Use default if URL parsing fails
      }

      // Build allowed hosts list - add port if not specified
      // Include both localhost and 127.0.0.1 as Deno treats them differently
      const baseHosts = this.config.allowedNetHosts;
      const expandedHosts: string[] = [];

      for (const h of baseHosts) {
        if (h.includes(':')) {
          expandedHosts.push(h);
        } else {
          // Add both hostname and 127.0.0.1 with the bridge port
          expandedHosts.push(`${h}:${bridgePort}`);
          if (h === 'localhost') {
            expandedHosts.push(`127.0.0.1:${bridgePort}`);
          }
        }
      }

      const allowedHosts = expandedHosts.join(',');

      const args = [
        'run',
        `--allow-net=${allowedHosts}`,
        '--no-prompt',
        `--v8-flags=--max-old-space-size=${this.config.maxMemoryMb}`,
        filePath,
      ];

      logger.debug('Spawning Deno', { executionId, args: args.join(' ') });

      let killed = false;

      const proc: ChildProcess = spawn('deno', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalChildEnv({
          DENO_DIR: process.env.DENO_DIR,
          NO_COLOR: '1',
        }),
      });

      // Track the process
      this.activeProcesses.set(executionId, proc);

      // Set timeout
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      // Honour MCP cancellation (RequestHandlerExtra.signal). We kill the
      // process and flag cancellation so the close handler returns the
      // dedicated error type instead of a timeout / runtime error.
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        killed = true;
        logger.info('Execution cancelled by client', { executionId });
        try {
          proc.kill('SIGTERM');
          // Escalate to SIGKILL if the process doesn't exit in the grace window.
          setTimeout(() => {
            if (this.activeProcesses.has(executionId)) {
              proc.kill('SIGKILL');
            }
          }, LIFECYCLE_TIMEOUTS.PROCESS_FORCE_KILL_MS).unref?.();
        } catch {
          // Process may already be gone.
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // Bounded stdout/stderr buffering
      const stdoutChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stdoutTruncated = false;
      const stderrChunks: Buffer[] = [];
      let stderrLen = 0;
      let stderrTruncated = false;

      proc.stdout?.on('data', (data: Buffer) => {
        if (stdoutTruncated) return;
        if (stdoutLen + data.length > this.maxOutputBytes) {
          stdoutChunks.push(data.subarray(0, this.maxOutputBytes - stdoutLen));
          stdoutLen = this.maxOutputBytes;
          stdoutTruncated = true;
          logger.warn('stdout truncated at max output limit', { executionId, maxOutputBytes: this.maxOutputBytes });
        } else {
          stdoutChunks.push(data);
          stdoutLen += data.length;
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        if (stderrTruncated) return;
        if (stderrLen + data.length > this.maxOutputBytes) {
          stderrChunks.push(data.subarray(0, this.maxOutputBytes - stderrLen));
          stderrLen = this.maxOutputBytes;
          stderrTruncated = true;
          logger.warn('stderr truncated at max output limit', { executionId, maxOutputBytes: this.maxOutputBytes });
        } else {
          stderrChunks.push(data);
          stderrLen += data.length;
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(executionId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (cancelled) {
          resolve({
            executionId,
            success: false,
            error: {
              type: 'runtime',
              message: 'Execution cancelled by client',
            },
            logs: [],
            metrics: {
              executionTimeMs: 0,
              toolCalls: 0,
              dataProcessedBytes: 0,
              resultSizeBytes: 0,
            },
          });
          return;
        }

        if (killed) {
          resolve({
            executionId,
            success: false,
            error: {
              type: 'timeout',
              message: `Execution timed out after ${timeoutMs}ms`,
            },
            logs: [],
            metrics: {
              executionTimeMs: timeoutMs,
              toolCalls: 0,
              dataProcessedBytes: 0,
              resultSizeBytes: 0,
            },
          });
          return;
        }

        // Parse structured result from stdout
        const resultMatch = stdout.match(/__RESULT_START__\n([\s\S]*?)\n__RESULT_END__/);

        if (resultMatch && resultMatch[1]) {
          try {
            const parsed = JSON.parse(resultMatch[1]);
            resolve({
              executionId,
              success: parsed.success,
              result: parsed.result,
              error: parsed.error,
              logs: parsed.logs || [],
              metrics: {
                executionTimeMs: 0, // Will be set by caller
                toolCalls: parsed.metrics?.toolCalls || 0,
                dataProcessedBytes: parsed.metrics?.dataProcessedBytes || 0,
                resultSizeBytes: 0, // Will be set by caller
              },
            });
            return;
          } catch (parseError) {
            logger.error('Failed to parse execution result', { executionId, parseError });
          }
        }

        // Handle execution errors
        if (code !== 0 || stderr) {
          // Check for syntax errors
          const syntaxMatch = stderr.match(/error: (.*?) at .*?:(\d+):\d+/);
          if (syntaxMatch) {
            resolve({
              executionId,
              success: false,
              error: {
                type: 'syntax',
                message: syntaxMatch[1] || 'Syntax error',
                line: parseInt(syntaxMatch[2] || '0', 10),
              },
              logs: [],
              metrics: {
                executionTimeMs: 0,
                toolCalls: 0,
                dataProcessedBytes: 0,
                resultSizeBytes: 0,
              },
            });
            return;
          }

          resolve({
            executionId,
            success: false,
            error: {
              type: 'runtime',
              message: stderr || `Process exited with code ${code}`,
              stack: stderr,
            },
            logs: [],
            metrics: {
              executionTimeMs: 0,
              toolCalls: 0,
              dataProcessedBytes: 0,
              resultSizeBytes: 0,
            },
          });
          return;
        }

        // No result found
        resolve({
          executionId,
          success: false,
          error: {
            type: 'runtime',
            message: 'No result returned from execution',
          },
          logs: [],
          metrics: {
            executionTimeMs: 0,
            toolCalls: 0,
            dataProcessedBytes: 0,
            resultSizeBytes: 0,
          },
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        this.activeProcesses.delete(executionId);
        // Symmetric with the close handler — without this the abort
        // listener stays attached to the AbortSignal until the SDK GCs
        // the request, leaking closure refs across repeated spawn
        // failures (EAGAIN/EMFILE/ENOENT).
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }

        // Reset deno check cache on spawn failure
        if (error.message.includes('ENOENT')) {
          this.denoAvailable = null;
        }

        resolve({
          executionId,
          success: false,
          error: {
            type: 'runtime',
            message: `Failed to spawn Deno: ${error.message}`,
          },
          logs: [],
          metrics: {
            executionTimeMs: 0,
            toolCalls: 0,
            dataProcessedBytes: 0,
            resultSizeBytes: 0,
          },
        });
      });
    });
  }
}
