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
    maxMemoryMb: 512,
    allowedNetHosts: ['localhost'],
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
