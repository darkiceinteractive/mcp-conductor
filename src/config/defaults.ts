/**
 * Default configuration values for MCP Conductor.
 *
 * These defaults are applied when no user configuration file or environment
 * variable overrides are present. The loading precedence is:
 * defaults → `~/.mcp-conductor.json` → environment variables.
 *
 * @module config/defaults
 */

import type { MCPExecutorConfig } from './schema.js';

/**
 * Built-in defaults for every configuration option.
 *
 * - `bridge.port: 0` — OS picks an available port dynamically
 * - `execution.mode: 'execution'` — sandbox-first mode for maximum token savings
 * - `sandbox.maxMemoryMb: 512` — Deno subprocess memory ceiling
 * - `hotReload.enabled: true` — config file changes take effect in ~500 ms
 */
export const DEFAULT_CONFIG: MCPExecutorConfig = {
  bridge: {
    port: 0, // Dynamic port allocation - OS will pick an available port
    host: '127.0.0.1',
  },
  execution: {
    mode: 'execution',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 300000,
    streamingEnabled: true,
  },
  sandbox: {
    maxMemoryMb: 128,
    allowedNetHosts: ['localhost'],
    // Bumped from 5 → 8 in v2.0.0-alpha.2 (X3 cleanup) per IBKR-side analysis
    // finding #5. PRD Phase 4's worker pool further parameterises this with
    // per-server overrides and warm-pool sizing.
    maxConcurrentProcesses: 8,
    maxOutputBytes: 10 * 1024 * 1024, // 10MB
  },
  skills: {
    path: null,
    watchForChanges: true,
  },
  hotReload: {
    enabled: true,
    debounceMs: 500,
  },
  metrics: {
    enabled: true,
    logToFile: false,
    logPath: null,
  },
  servers: {
    allowList: ['*'],
    denyList: [],
  },
};

/**
 * Environment variable names recognised by MCP Conductor.
 *
 * Any of these can override the corresponding value from the config file.
 * For example, `MCP_EXECUTOR_MODE=passthrough` forces passthrough mode
 * regardless of what `~/.mcp-conductor.json` says.
 */
export const ENV_VARS = {
  PORT: 'MCP_EXECUTOR_PORT',
  MODE: 'MCP_EXECUTOR_MODE',
  TIMEOUT: 'MCP_EXECUTOR_TIMEOUT',
  MAX_TIMEOUT: 'MCP_EXECUTOR_MAX_TIMEOUT',
  LOG_LEVEL: 'MCP_EXECUTOR_LOG_LEVEL',
  CONFIG: 'MCP_EXECUTOR_CONFIG',
  CLAUDE_CONFIG: 'MCP_EXECUTOR_CLAUDE_CONFIG',
  CONDUCTOR_CONFIG: 'MCP_CONDUCTOR_CONFIG',
  SKILLS_PATH: 'MCP_EXECUTOR_SKILLS_PATH',
  WATCH_CONFIG: 'MCP_EXECUTOR_WATCH_CONFIG',
  WATCH_SKILLS: 'MCP_EXECUTOR_WATCH_SKILLS',
  STREAM_ENABLED: 'MCP_EXECUTOR_STREAM_ENABLED',
  ALLOWED_SERVERS: 'MCP_EXECUTOR_ALLOWED_SERVERS',
  MAX_MEMORY_MB: 'MCP_EXECUTOR_MAX_MEMORY_MB',
} as const;

/**
 * Default `~/.mcp-conductor.json` skeleton used when creating a new config.
 *
 * `exclusive: true` is the recommended setting — it routes all MCP traffic
 * through the conductor so Claude cannot bypass it with direct tool calls.
 */
export const DEFAULT_CONDUCTOR_CONFIG = {
  exclusive: true,
  servers: {},
};

/**
 * Lifecycle timeouts (milliseconds).
 *
 * Grouped together so memory-leak diagnostics and load testing can adjust
 * them centrally without hunting through the source tree. Consumers:
 * - `SHUTDOWN_TIMEOUT_MS` — `src/index.ts` SIGINT/SIGTERM handler
 * - `PROCESS_FORCE_KILL_MS` — `DenoExecutor.shutdown()` SIGTERM → SIGKILL grace
 * - `STREAM_STALE_TTL_MS` — `StreamManager` normal cleanup (completed, no connections)
 * - `STREAM_COMPLETED_TTL_MS` — `StreamManager` force cleanup (completed, any connections)
 * - `STREAM_STUCK_TTL_MS` — `StreamManager` cleanup for hung running streams
 * - `STREAM_CLEANUP_INTERVAL_MS` — `StreamManager` tick rate for the sweep
 * - `MEMORY_LOG_INTERVAL_MS` — periodic heap/RSS log from the main entry point
 * - `BRIDGE_SESSION_TTL_MS` — HTTP bridge session idle expiry (Mcp-Session-Id)
 * - `BRIDGE_SESSION_CLEANUP_INTERVAL_MS` — sweep cadence for expired sessions
 */
export const LIFECYCLE_TIMEOUTS = {
  SHUTDOWN_TIMEOUT_MS: 10_000,
  PROCESS_FORCE_KILL_MS: 3_000,
  STREAM_STALE_TTL_MS: 5 * 60_000,
  STREAM_COMPLETED_TTL_MS: 10 * 60_000,
  STREAM_STUCK_TTL_MS: 15 * 60_000,
  STREAM_CLEANUP_INTERVAL_MS: 60_000,
  MEMORY_LOG_INTERVAL_MS: 60_000,
  BRIDGE_SESSION_TTL_MS: 30 * 60_000,
  BRIDGE_SESSION_CLEANUP_INTERVAL_MS: 5 * 60_000,
  ORPHAN_CHECK_INTERVAL_MS: 10_000,
} as const;

/**
 * Cap on simultaneously tracked bridge sessions. Bounded to prevent the
 * session registry from growing unbounded if a client keeps rotating IDs.
 */
export const MAX_BRIDGE_SESSIONS = 1000;
