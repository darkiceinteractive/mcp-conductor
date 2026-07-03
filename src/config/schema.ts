/**
 * Configuration type definitions for MCP Executor
 */

export type ExecutionMode = 'execution' | 'passthrough' | 'hybrid';

export interface BridgeConfig {
  port: number;
  host: string;
}

export interface ExecutionConfig {
  mode: ExecutionMode;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  streamingEnabled: boolean;
}

export interface SandboxConfig {
  maxMemoryMb: number;
  allowedNetHosts: string[];
  maxConcurrentProcesses?: number;
  maxOutputBytes?: number;
}

export interface SkillsConfig {
  path: string | null;
  watchForChanges: boolean;
}

export interface HotReloadConfig {
  enabled: boolean;
  debounceMs: number;
}

export interface MetricsConfig {
  enabled: boolean;
  logToFile: boolean;
  logPath: string | null;
  /**
   * When true, every execute_code response automatically includes a
   * tokenSavings block without requiring the per-call show_token_savings flag.
   * Corresponds to ~/.mcp-conductor.json `metrics.alwaysShowTokenSavings`.
   * Default: false.
   */
  alwaysShowTokenSavings?: boolean;
}

export interface ServersConfig {
  allowList: string[];
  denyList: string[];
}

export interface MCPExecutorConfig {
  bridge: BridgeConfig;
  execution: ExecutionConfig;
  sandbox: SandboxConfig;
  skills: SkillsConfig;
  hotReload: HotReloadConfig;
  metrics: MetricsConfig;
  servers: ServersConfig;
}

export interface ServerInfo {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

/**
 * Rate limiting configuration for a server
 */
export interface RateLimitConfig {
  /** Maximum requests per second */
  requestsPerSecond: number;
  /** Maximum burst size (defaults to requestsPerSecond) */
  burstSize?: number;
  /** Behaviour when rate limit exceeded: 'queue' waits, 'reject' fails immediately */
  onLimitExceeded?: 'queue' | 'reject';
  /** Maximum time to wait in queue before rejecting (ms, defaults to 30000) */
  maxQueueTimeMs?: number;
}

/**
 * Per-server routing override.
 *
 * - `passthrough` — every tool from this server is exposed as a first-class
 *   `<server>__<tool>` MCP tool, regardless of the per-tool `BUILT_IN_ROUTING`
 *   table or any prior `recommend_routing --apply` annotations.
 * - `execute_code` — none of this server's tools are exposed as first-class;
 *   they're only reachable through `execute_code`. Use for servers whose
 *   tools you always want to batch/transform inside the sandbox.
 * - `auto` (default) — fall back to per-tool routing: the
 *   `BUILT_IN_ROUTING` table for known servers, else `execute_code`.
 *
 * Per-server settings ALWAYS win over per-tool settings — when present, this
 * field is the authoritative override.
 */
export type ServerRoutingMode = 'passthrough' | 'execute_code' | 'auto';

/**
 * Server definition for conductor config
 */
export interface ConductorServerConfig {
  /** Server type (stdio is the default and most common) */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Rate limiting configuration for this server */
  rateLimit?: RateLimitConfig;
  /**
   * Force a routing strategy for every tool this server exposes.
   * Defaults to `'auto'` when omitted. See {@link ServerRoutingMode}.
   */
  routing?: ServerRoutingMode;
}

/**
 * Catalog presence configuration — controls the handshake `instructions` budget.
 */
export interface CatalogConfig {
  /**
   * Token budget for the catalog text embedded in the MCP initialize `instructions`
   * field. Catalog is trimmed (tool lists dropped, then small servers collapsed)
   * if the full text would exceed this. Default: 1200.
   */
  instructions_budget_tokens?: number;
}

/**
 * MCP Conductor's own configuration file (~/.mcp-conductor.json)
 * Used in exclusive mode to store server configurations separately from Claude's config.
 */
export interface ConductorConfig {
  /** When true, only use servers from this config (not Claude's config) */
  exclusive: boolean;
  /** MCP servers that conductor will connect to internally */
  servers: Record<string, ConductorServerConfig>;
  /**
   * Maximum time to wait for an individual child server's stdio handshake
   * before marking it as failed and continuing startup. Default: 10000 ms.
   * Prevents a single slow/hung server from blocking the whole conductor.
   */
  connect_timeout_ms?: number;
  /**
   * Catalog presence layer configuration. Controls the `instructions` field
   * included in the MCP initialize response.
   */
  catalog?: CatalogConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Connection Pool & Worker Pool configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connection pool configuration for persistent stdio connections to MCP
 * backend servers. Reduces cold-start latency by keeping connections alive
 * and multiplexing JSON-RPC requests over the same stdio channel.
 */
export interface ConnectionPoolConfig {
  /** Minimum idle connections to keep per server (default: 1) */
  minConnectionsPerServer?: number;
  /** Maximum simultaneous connections per server (default: 4) */
  maxConnectionsPerServer?: number;
  /** Idle connection shutdown timeout in ms (default: 300000 = 5 min) */
  idleTimeoutMs?: number;
  /** Timeout for acquiring a connection from the pool (default: 5000) */
  acquireTimeoutMs?: number;
}

/**
 * Warm Deno worker pool configuration. Workers are pre-spawned at startup
 * so the first execute_code call hits an already-warm sandbox.
 */
export interface WorkerPoolConfig {
  /** Number of warm workers to maintain (default: 4) */
  size?: number;
  /** Recycle a worker after this many jobs (default: 100) */
  maxJobsPerWorker?: number;
  /** Recycle a worker after this many ms since spawn (default: 600000 = 10 min) */
  maxAgeMs?: number;
}

/**
 * Phase 4 runtime pool configuration block (nested under `runtime` in conductor config).
 */
export interface RuntimePoolConfig {
  workerPool?: WorkerPoolConfig;
  connectionPool?: ConnectionPoolConfig;
}
