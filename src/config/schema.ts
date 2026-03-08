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
}
