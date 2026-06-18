# MCP Conductor: Complete Memory Leak Investigation & Fix Plan

> **Kickoff command**: "Read `_plans/memory-issue/2026-03-12_14-30-MemoryFixPlan.md` and execute all 7 phases. Start with Phase 1 (the shutdown chain fix) and work through sequentially. Run `npm run build` after each phase and `npm run test:run` after all phases."

---

## Executive Summary

The MCP Conductor server leaks RAM continuously, eventually consuming all system memory and freezing Claude, VS Code, and other processes. **Root cause**: `MCPExecutorServer.stop()` only shuts down 2 of 7 components. Five global singletons (with running intervals, event listeners, caches, and accumulated data) are never cleaned up. Combined with zero Deno process tracking (each spawning 512MB V8 heaps with no concurrency limit), unbounded stdout/stderr string accumulation, and dangling reconnection timers.

**No Rust/Python/V8 isolates needed** - all issues are architectural (missing cleanup calls and unbounded collections).

---

## Investigation Findings (10 Experts, 75+ Files Analysed)

### CRITICAL Issue #1: Incomplete Shutdown Chain
- **File**: `src/server/mcp-server.ts` lines 1394-1402
- **What**: `stop()` only calls `hub.shutdown()` and `bridge.stop()`
- **Missing**: MetricsCollector, StreamManager, ModeHandler, SkillsEngine, ConfigWatcher, active Deno processes
- **Impact**: Every singleton persists with its intervals, listeners, and data structures forever

```typescript
// CURRENT (broken) - src/server/mcp-server.ts:1394
async stop(): Promise<void> {
  if (!this.useMockServers) {
    await this.hub.shutdown();
  }
  await this.bridge.stop();
  logger.info('MCP Executor server stopped');
}
```

### CRITICAL Issue #2: No Deno Process Tracking
- **File**: `src/runtime/executor.ts` lines 573-766
- **What**: Each `execute()` spawns `deno run` via `child_process.spawn()`. The `ChildProcess` handle is local to `runDeno()` closure and never stored anywhere.
- **No PID registry**, no concurrency limit, no shutdown cleanup
- **Default**: 512MB V8 heap per process (`--v8-flags=--max-old-space-size=512`)
- **Impact**: 10 concurrent calls = 5GB+ RAM. On server exit, all become zombies.

```typescript
// CURRENT (no tracking) - src/runtime/executor.ts:617
const proc: ChildProcess = spawn('deno', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1' },  // Also leaks ALL env vars
});
```

### CRITICAL Issue #3: Unbounded stdout/stderr Accumulation
- **File**: `src/runtime/executor.ts` lines 613-637
- **What**: O(n^2) string concatenation with zero size limit
- **Impact**: A verbose Deno process can fill RAM with a single execution

```typescript
// CURRENT (unbounded) - src/runtime/executor.ts:631-636
let stdout = '';
let stderr = '';
proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
```

### HIGH Issue #4: Dangling Reconnection Timers
- **File**: `src/hub/mcp-hub.ts` ~line 363
- **What**: `handleDisconnection()` calls `setTimeout()` for reconnects but never stores the reference
- **Impact**: On shutdown, timers keep firing, may trigger reconnect attempts, keep process alive

### HIGH Issue #5: checkDeno() Spawns Subprocess Every Execution
- **File**: `src/runtime/executor.ts` line 510
- **What**: `this.checkDeno()` called at start of every `execute()`, spawns `deno --version` each time
- **Impact**: 50-200ms wasted per execution, unnecessary process spawning

### MEDIUM Issue #6: StreamManager Cleanup Interval Never Cleared
- **File**: `src/streaming/execution-stream.ts` line 301
- **What**: `setInterval(() => this.cleanupStaleStreams(), 60000)` in constructor
- **Shutdown function exists** (`shutdownStreamManager()` at line 422) but is NEVER CALLED
- **Impact**: 60s interval runs forever, preventing GC of stream data

### MEDIUM Issue #7: Environment Variable Leakage
- **File**: `src/runtime/executor.ts` line 619
- **What**: `env: { ...process.env, NO_COLOR: '1' }` passes ALL parent env vars to Deno
- **Impact**: Security issue (API keys, tokens exposed to sandbox) + unnecessary memory per process

### MEDIUM Issue #8: No HTTP Body Size Limit on Bridge
- **File**: `src/bridge/http-server.ts` ~line 460
- **What**: `readBody()` accumulates entire request body with no size limit
- **Impact**: A malicious or buggy Deno process can OOM the bridge

### LOW Issue #9: EventEmitter Listener Accumulation
- **Files**: `src/hub/mcp-hub.ts`, `src/watcher/config-watcher.ts`, `src/streaming/execution-stream.ts`
- **What**: Listeners added on connection/reconnection but never removed
- **Impact**: Gradual listener accumulation on reconnection cycles

### LOW Issue #10: MetricsCollector Accumulation
- **File**: `src/metrics/metrics-collector.ts` ~line 118
- **What**: Stores up to 1000 `ExecutionMetrics` objects, trimmed but never fully cleared
- **Impact**: Minor memory overhead, but shutdown function never called

---

## Global Singleton Inventory

Each of these has a `shutdownXxx()` function that EXISTS but is NEVER CALLED:

| Singleton | File | Interval/Timers | Shutdown Function |
|-----------|------|-----------------|-------------------|
| StreamManager | `src/streaming/execution-stream.ts:407` | 60s cleanup interval | `shutdownStreamManager()` line 422 |
| MetricsCollector | `src/metrics/metrics-collector.ts:603` | None | `shutdownMetricsCollector()` line 621 |
| ModeHandler | `src/modes/mode-handler.ts:304` | None | `shutdownModeHandler()` line 318 |
| SkillsEngine | `src/skills/skills-engine.ts:488` | None | `shutdownSkillsEngine()` line 504 |

The ConfigWatcher is created via `createHubWatcher()` in `src/watcher/config-watcher.ts` and has a `stop()` method but no global shutdown function.

---

## Architecture Context

```
Claude (stdio) -> MCPExecutorServer -> HttpBridge (localhost HTTP)
                                    -> DenoExecutor (spawns child processes)
                                    -> MCPHub (manages backend MCP server connections)
                                    -> StreamManager (SSE streaming)
                                    -> ModeHandler (execution/passthrough logic)
                                    -> MetricsCollector (token savings tracking)
                                    -> SkillsEngine (YAML skill loading)
                                    -> ConfigWatcher (hot-reload file watcher)
```

**Key class**: `MCPExecutorServer` (src/server/mcp-server.ts) holds all components:
- `this.server: McpServer` (MCP SDK)
- `this.bridge: HttpBridge`
- `this.executor: DenoExecutor`
- `this.hub: MCPHub`
- `this.skills: SkillsEngine | null`
- `this.modeHandler: ModeHandler`
- `this.metricsCollector: MetricsCollector`
- `this.mockServers: Map` (test only)

**Entry point**: `src/index.ts` - creates server, registers SIGINT/SIGTERM -> `server.stop()` -> `process.exit(0)`

---

## Phase 1: Fix Shutdown Chain (CRITICAL)

### File: `src/server/mcp-server.ts`

**Add imports** (top of file, after existing imports):
```typescript
import { shutdownStreamManager } from '../streaming/index.js';
import { shutdownMetricsCollector } from '../metrics/index.js';
import { shutdownModeHandler } from '../modes/index.js';
import { shutdownSkillsEngine } from '../skills/index.js';
```

**Rewrite `stop()` method** (replace lines 1394-1402):
```typescript
async stop(): Promise<void> {
  logger.info('Stopping MCP Executor server...');

  // 1. Kill all in-flight Deno processes first
  await this.executor.shutdown();

  // 2. Shutdown hub connections (disconnects backend MCP servers)
  if (!this.useMockServers) {
    await this.hub.shutdown();
  }

  // 3. Shutdown global singletons (intervals, listeners, caches)
  shutdownStreamManager();
  shutdownMetricsCollector();
  shutdownModeHandler();
  shutdownSkillsEngine();

  // 4. Clean up instance-level references
  this.modeHandler.removeAllListeners();
  this.metricsCollector.removeAllListeners?.();

  // 5. Stop HTTP bridge last (Deno processes may still be calling it during cleanup)
  await this.bridge.stop();

  logger.info('MCP Executor server stopped');
}
```

**Note**: Check if these shutdown functions are exported from the barrel files (`../streaming/index.js` etc.). If not, add the exports. The functions exist in the source files - verify the barrel re-exports them:
- `src/streaming/index.ts` should export `shutdownStreamManager`
- `src/metrics/index.ts` should export `shutdownMetricsCollector`
- `src/modes/index.ts` should export `shutdownModeHandler`
- `src/skills/index.ts` should export `shutdownSkillsEngine`

### File: `src/index.ts`

**Replace the shutdown handler** (lines 47-55):
```typescript
// Handle shutdown gracefully with timeout guard
let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return; // Prevent double-shutdown
  isShuttingDown = true;

  logger.info('Shutting down...');

  // Safety: force exit if shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    logger.error('Shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  shutdownTimeout.unref(); // Don't keep process alive just for this timer

  try {
    await server.stop();
  } catch (error) {
    logger.error('Error during shutdown', { error: String(error) });
  }

  clearTimeout(shutdownTimeout);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Catch unhandled errors to prevent silent leaks
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: String(error), stack: error.stack });
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
```

---

## Phase 2: Deno Process Tracking & Concurrency Limit (CRITICAL)

### File: `src/config/schema.ts`

**Add to `SandboxConfig` interface** (find the interface and add these optional fields):
```typescript
export interface SandboxConfig {
  maxMemoryMb: number;
  allowedNetHosts: string[];
  maxConcurrentProcesses?: number;  // NEW - default 5
  maxOutputBytes?: number;          // NEW - default 10MB (10485760)
}
```

### File: `src/config/defaults.ts`

**Update sandbox defaults** (line 32-35):
```typescript
sandbox: {
  maxMemoryMb: 128,               // CHANGED from 512 - sufficient for 95%+ of use cases
  allowedNetHosts: ['localhost'],
  maxConcurrentProcesses: 5,      // NEW
  maxOutputBytes: 10 * 1024 * 1024, // NEW - 10MB
},
```

### File: `src/runtime/executor.ts`

**Add new class fields** (after existing fields in `DenoExecutor` class):
```typescript
private activeProcesses: Map<string, ChildProcess> = new Map();
private maxConcurrentProcesses: number;
private maxOutputBytes: number;
private isShuttingDown = false;
private denoAvailable: boolean | null = null; // Phase 5a cache
```

**Update constructor** to read new config values:
```typescript
constructor(config: SandboxConfig) {
  this.config = config;
  this.maxConcurrentProcesses = config.maxConcurrentProcesses ?? 5;
  this.maxOutputBytes = config.maxOutputBytes ?? 10 * 1024 * 1024;
  this.tempDir = join(tmpdir(), 'mcp-executor');
  if (!existsSync(this.tempDir)) {
    mkdirSync(this.tempDir, { recursive: true });
  }
}
```

**Add `shutdown()` method** (new method on DenoExecutor class):
```typescript
/**
 * Shutdown executor: kill all active Deno processes
 */
async shutdown(): Promise<void> {
  this.isShuttingDown = true;

  if (this.activeProcesses.size === 0) return;

  logger.info(`Killing ${this.activeProcesses.size} active Deno processes`);

  const killPromises = Array.from(this.activeProcesses.entries()).map(
    ([id, proc]) => {
      return new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, 3000);
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
```

**Update `runDeno()` method** (src/runtime/executor.ts ~line 573):

At the START of `runDeno()`, add concurrency check:
```typescript
private runDeno(filePath: string, timeoutMs: number, executionId: string, bridgeUrl: string): Promise<ExecutionResult> {
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

    // ... existing host expansion code ...
```

After the `spawn()` call (~line 617), ADD process tracking:
```typescript
const proc: ChildProcess = spawn('deno', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DENO_DIR: process.env.DENO_DIR,
    NO_COLOR: '1',
  },
});

// Track the process
this.activeProcesses.set(executionId, proc);
```

In BOTH `proc.on('close')` and `proc.on('error')` handlers, ADD cleanup:
```typescript
proc.on('close', (code) => {
  clearTimeout(timer);
  this.activeProcesses.delete(executionId); // ADD THIS LINE
  // ... rest of existing handler ...
});

proc.on('error', (error) => {
  clearTimeout(timer);
  this.activeProcesses.delete(executionId); // ADD THIS LINE
  // ... rest of existing handler ...
});
```

---

## Phase 3: Cap stdout/stderr Buffers (HIGH)

### File: `src/runtime/executor.ts`

**Replace stdout/stderr accumulation** (lines 613-637 in `runDeno()`):

REPLACE:
```typescript
let stdout = '';
let stderr = '';

proc.stdout?.on('data', (data: Buffer) => {
  stdout += data.toString();
});

proc.stderr?.on('data', (data: Buffer) => {
  stderr += data.toString();
});
```

WITH:
```typescript
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
```

Then in the `proc.on('close')` handler, at the very start, join the buffers:
```typescript
proc.on('close', (code) => {
  clearTimeout(timer);
  this.activeProcesses.delete(executionId);

  const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');

  // ... rest of existing close handler using stdout/stderr variables ...
});
```

---

## Phase 4: Reconnection Timer Tracking (HIGH)

### File: `src/hub/mcp-hub.ts`

**Add timer registry field** (after existing Map fields ~line 81):
```typescript
private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
```

**Update `handleDisconnection()` method** (~line 339-373):

Find the `setTimeout` call in this method and wrap it:
```typescript
// BEFORE (no reference stored):
setTimeout(async () => {
  if (this.isShuttingDown) return;
  // ... reconnect logic
}, this.config.reconnectDelayMs);

// AFTER (store reference):
// Clear any existing timer for this server
const existingTimer = this.reconnectTimers.get(name);
if (existingTimer) clearTimeout(existingTimer);

const timer = setTimeout(async () => {
  this.reconnectTimers.delete(name);
  if (this.isShuttingDown) return;
  // ... existing reconnect logic
}, this.config?.reconnectDelayMs ?? 5000);

this.reconnectTimers.set(name, timer);
```

**Update `shutdown()` method** (~line 496):

At the START of shutdown, before existing logic:
```typescript
async shutdown(): Promise<void> {
  logger.info('Shutting down MCP Hub');
  this.isShuttingDown = true;

  // Clear all pending reconnection timers
  for (const [name, timer] of this.reconnectTimers) {
    clearTimeout(timer);
  }
  this.reconnectTimers.clear();

  // ... existing disconnect logic ...

  // Clean up EventEmitter listeners at the end
  this.removeAllListeners();
  logger.info('MCP Hub shutdown complete');
}
```

**Update `disconnectServer()` method** (~line 402):

At the START, clear any pending reconnect timer for this server:
```typescript
async disconnectServer(name: string): Promise<void> {
  // Clear any pending reconnect timer
  const timer = this.reconnectTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    this.reconnectTimers.delete(name);
  }

  const connection = this.connections.get(name);
  if (!connection) return;

  // Clean up transport event handlers
  if (connection.transport) {
    connection.transport.onerror = undefined;
    connection.transport.onclose = undefined;
  }

  // Clean up rate limiter
  if (connection.rateLimiter) {
    connection.rateLimiter.destroy();
  }

  // ... rest of existing disconnect logic ...
}
```

---

## Phase 5: Performance Quick Wins (MEDIUM)

### 5a. Cache `checkDeno()` result

**File**: `src/runtime/executor.ts`

The `denoAvailable` field was already added in Phase 2. Now update `checkDeno()`:

```typescript
// Find the existing checkDeno() method and update it:
async checkDeno(): Promise<boolean> {
  if (this.denoAvailable !== null) return this.denoAvailable;

  // ... existing spawn('deno', ['--version']) logic ...
  // At the end where it returns true/false, cache the result:
  this.denoAvailable = true; // or false
  return this.denoAvailable;
}
```

Also reset on spawn failure in `runDeno()`:
```typescript
proc.on('error', (error) => {
  clearTimeout(timer);
  this.activeProcesses.delete(executionId);

  // Reset deno check cache on spawn failure
  if (error.message.includes('ENOENT')) {
    this.denoAvailable = null;
  }

  resolve({ /* ... existing error result ... */ });
});
```

### 5b. Use stdin piping instead of temp files

**File**: `src/runtime/executor.ts`

**Update `execute()` method** (~lines 538-560):

REPLACE:
```typescript
// Write to temp file
const tempFile = join(this.tempDir, `exec_${executionId}.ts`);
writeFileSync(tempFile, sandboxCode);

try {
  const result = await this.runDeno(tempFile, options.timeoutMs, executionId, options.bridgeUrl);
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
  try {
    unlinkSync(tempFile);
  } catch {
    // Ignore cleanup errors
  }
}
```

WITH:
```typescript
const result = await this.runDeno(sandboxCode, options.timeoutMs, executionId, options.bridgeUrl);
return {
  ...result,
  executionId,
  metrics: {
    ...result.metrics,
    executionTimeMs: Date.now() - startTime,
    resultSizeBytes: result.result ? JSON.stringify(result.result).length : 0,
  },
};
```

**Update `runDeno()` signature and spawn** - change first param from `filePath` to `code`:

```typescript
private runDeno(code: string, timeoutMs: number, executionId: string, bridgeUrl: string): Promise<ExecutionResult> {
```

Change `spawn` to use stdin:
```typescript
const args = [
  'run',
  `--allow-net=${allowedHosts}`,
  '--no-prompt',
  `--v8-flags=--max-old-space-size=${this.config.maxMemoryMb}`,
  '-',  // Read from stdin
];

const proc: ChildProcess = spawn('deno', args, {
  stdio: ['pipe', 'pipe', 'pipe'],  // CHANGED: stdin is now 'pipe' instead of 'ignore'
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DENO_DIR: process.env.DENO_DIR,
    NO_COLOR: '1',
  },
});

// Send code via stdin
proc.stdin?.write(code);
proc.stdin?.end();
```

**IMPORTANT**: Test that `deno run -` (reading from stdin) works with TypeScript. If Deno requires a file extension for TS compilation, keep the temp file approach but ensure cleanup is robust. Fallback:
```typescript
const args = [
  'run',
  `--allow-net=${allowedHosts}`,
  '--no-prompt',
  `--v8-flags=--max-old-space-size=${this.config.maxMemoryMb}`,
  '--ext=ts',  // Tell Deno to treat stdin as TypeScript
  '-',
];
```

### 5c. Reduce default memory (already done in Phase 2 defaults change)

### 5d. Strip environment variables (already done in Phase 2 spawn change)

### 5e. Add HTTP body size limit to bridge

**File**: `src/bridge/http-server.ts`

Find the `readBody()` function (~line 460):

```typescript
// Add size limit to readBody
private async readBody(req: IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}
```

Where `readBody` is called in request handlers, catch the size error and respond with 413:
```typescript
try {
  const body = await this.readBody(req);
  // ... handle request
} catch (error) {
  if (error.message.includes('maximum size')) {
    res.writeHead(413);
    res.end(JSON.stringify({ error: 'Request body too large' }));
    return;
  }
  throw error;
}
```

---

## Phase 6: EventEmitter Cleanup (LOW)

### File: `src/hub/mcp-hub.ts`

Already covered in Phase 4 changes:
- `disconnectServer()` nulls transport handlers
- `shutdown()` calls `this.removeAllListeners()`

### File: `src/streaming/execution-stream.ts`

In the `StreamManager.shutdown()` method (~line 390):
```typescript
shutdown(): void {
  if (this.cleanupInterval) {
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }

  // Clean up all streams
  for (const [id, stream] of this.streams) {
    stream.removeAllListeners();  // ADD THIS
    stream.closeAllConnections();
  }
  this.streams.clear();
}
```

---

## Phase 7: Tests

### New file: `test/unit/shutdown.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';

describe('Shutdown Chain', () => {
  it('should call all shutdown functions on stop()', async () => {
    // Create server with mock servers to avoid real connections
    const config = { /* minimal config with useMockServers: true */ };
    const server = new MCPExecutorServer(config, { useMockServers: true });

    // Spy on all shutdown-related methods
    // ... test that stop() calls all expected shutdowns
  });

  it('should have no active timers after stop()', async () => {
    vi.useFakeTimers();
    // ... create server, start, stop, advance timers, verify no callbacks fire
    vi.useRealTimers();
  });
});
```

### New/update: `test/unit/executor.test.ts`

```typescript
describe('DenoExecutor', () => {
  describe('concurrency limit', () => {
    it('should reject when max concurrent processes reached', async () => {
      // ... spawn maxConcurrent long-running processes, verify next is rejected
    });
  });

  describe('shutdown', () => {
    it('should kill all active processes', async () => {
      // ... start a process, call shutdown(), verify process is killed
    });

    it('should reject new executions after shutdown', async () => {
      // ... call shutdown(), try execute(), verify rejection
    });
  });

  describe('output limits', () => {
    it('should truncate stdout at maxOutputBytes', async () => {
      // ... execute code that outputs more than limit, verify truncation
    });
  });
});
```

---

## Decision Log

| Option | Decision | Reason |
|--------|----------|--------|
| Deno process pool | **No** | Incompatible with per-execution permissions & code injection model |
| V8 isolates (`isolated-vm`) | **No** | No `fetch()`, no TypeScript, no Deno permissions - would need full rewrite |
| Rust native components (napi-rs) | **No** | Bottlenecks are I/O + missing cleanup, not CPU. Adds cross-platform build complexity. |
| Python components | **No** | Adds second runtime dependency with no benefit over Node.js |
| Unix domain sockets for bridge | **No** | Deno `fetch()` doesn't support UDS - would need raw socket rewrite |
| Switch from Deno to Workers | **Future** | Cloudflare Workers or Deno Deploy could eliminate process management entirely |

---

## Files Modified Summary

| File | Phases | Key Changes |
|------|--------|-------------|
| `src/server/mcp-server.ts` | 1 | Rewrite `stop()` with full shutdown chain |
| `src/runtime/executor.ts` | 2,3,5a,5b | Process tracking, buffer caps, checkDeno cache, stdin piping, env stripping |
| `src/index.ts` | 1 | Shutdown timeout guard, uncaughtException handler |
| `src/hub/mcp-hub.ts` | 4,6 | Timer registry, listener cleanup |
| `src/config/schema.ts` | 2 | Add `maxConcurrentProcesses`, `maxOutputBytes` to SandboxConfig |
| `src/config/defaults.ts` | 2,5c | New defaults, reduce memory 512->128MB |
| `src/bridge/http-server.ts` | 5e | Body size limit on readBody() |
| `src/streaming/execution-stream.ts` | 6 | Listener cleanup in shutdown |
| `test/unit/shutdown.test.ts` | 7 | NEW: shutdown chain tests |
| `test/unit/executor.test.ts` | 7 | NEW/UPDATE: process tracking + buffer tests |

---

## Verification Checklist

1. `npm run build` - zero errors
2. `npm run test:run` - all 674+ tests pass
3. New tests for shutdown, concurrency, buffer caps all green
4. Manual smoke test:
   - Start server, execute code blocks, monitor RAM (`process.memoryUsage()`)
   - Ctrl+C server, verify no orphan Deno processes: `ps aux | grep deno`
   - Rapid 10 executions, verify max 5 concurrent in logs
   - Execute code that produces huge output, verify truncation
5. Memory baseline: compare `process.memoryUsage()` before/after a 10-minute session
6. Verify no `MaxListenersExceededWarning` in stderr after reconnection cycles

---

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Max RAM per execution | 512MB | 128MB |
| Max concurrent processes | Unlimited | 5 (configurable) |
| Max stdout/stderr per process | Unlimited | 10MB |
| Shutdown cleanup | 2/7 components | 7/7 components |
| checkDeno overhead | 50-200ms/call | 0ms (cached) |
| Zombie processes on exit | All active | Zero |
| Dangling timers on shutdown | All reconnect timers | Zero |
