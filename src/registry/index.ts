/**
 * Tool Registry — authoritative catalog of all backend MCP tools with
 * auto-generated TypeScript declarations, ajv-based input validation,
 * snapshot persistence, and hot-reload change events.
 *
 * Every v3 agent imports from this module. Do not change the public API
 * without coordinating with all agents.
 *
 * @module registry
 */

export type { RegistryEventType, RegistryEvent } from './events.js';
export { ToolRegistry } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema (draft 7+)
// ─────────────────────────────────────────────────────────────────────────────

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  const?: unknown;
  format?: string;
  default?: unknown;
  title?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  nullable?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reliability profile (referenced by ToolDefinition; full impl in Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-tool reliability overrides. Populated fully by Phase 3 (Agent C).
 * Defined here so Phase 1 ToolDefinition can reference it without circular deps.
 */
export interface ReliabilityProfile {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerWindowMs?: number;
  circuitBreakerMinCalls?: number;
  halfOpenProbeIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core tool definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single tool in the registry catalog.
 *
 * Core fields mirror the MCP `tools/list` response.
 * Conductor-extension fields are optional and opt-in.
 *
 * Plan amendments (consolidated plan §3 Part B):
 * - `routing`  — for X1 passthrough adapter (Agent H)
 * - `redact`   — for X4 PII tokenization (Agent J)
 * - `examples` — Anthropic Tool Use Examples pattern; emitted as @example JSDoc
 */
export interface ToolDefinition {
  /** Backend server name (matches key in ~/.mcp-conductor.json) */
  server: string;
  /** Tool name as reported by the backend */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: JsonSchema;
  /** JSON Schema for the tool's output (optional; not all servers provide this) */
  outputSchema?: JsonSchema;

  // ── Conductor-extension metadata (optional, all opt-in) ──────────────────

  /** Estimated call cost; used by cache policy and observability */
  cost?: 'low' | 'medium' | 'high';
  /** Whether this tool's results are safe to cache */
  cacheable?: boolean;
  /** Cache TTL in milliseconds (requires cacheable: true) */
  cacheTtl?: number;
  /** Per-tool reliability overrides (Phase 3) */
  reliability?: ReliabilityProfile;

  /**
   * Execution routing decision.
   * - `execute_code` (default) — route through the Deno sandbox
   * - `passthrough`            — expose as a first-class MCP tool (X1 / Agent H)
   * - `hidden`                 — suppress from Claude's tool list
   */
  routing?: 'passthrough' | 'execute_code' | 'hidden';

  /**
   * PII redaction config applied to this tool's response before it enters
   * the sandbox or Claude's context. (X4 — Agent J)
   */
  redact?: {
    response?: Array<'email' | 'phone' | 'ssn' | 'credit_card' | string>;
  };

  /**
   * Worked examples. Emitted as `@example` JSDoc blocks in generated .d.ts
   * so both the sandbox TS LSP and Claude see concrete usage without extra
   * round-trips. (Anthropic Tool Use Examples pattern)
   */
  examples?: Array<{
    args: unknown;
    result: unknown;
    description?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry options + bridge interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal interface that ToolRegistry needs from the backend connection layer.
 * MCPHub satisfies this interface; tests can pass a lightweight mock.
 */
export interface BackendBridge {
  /** Returns names of all currently-known servers and their connection status */
  listServers(): Array<{ name: string; status: string; toolCount: number }>;
  /**
   * Returns raw tool descriptors for a server.
   * Shape matches the MCP SDK's Tool type (name + description + inputSchema).
   */
  getServerTools(serverName: string): Array<{
    name: string;
    description?: string;
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
  }>;
  /** Register for server lifecycle events */
  on(event: 'serverConnected' | 'serverDisconnected', listener: (name: string) => void): void;
  /** Deregister server lifecycle event listeners */
  off(event: 'serverConnected' | 'serverDisconnected', listener: (name: string) => void): void;
}

export interface RegistryOptions {
  /** Backend connection layer (MCPHub or compatible mock) */
  bridge: BackendBridge;
  /** Path to persist/load the registry snapshot */
  snapshotPath?: string;
  /** Directory where generated .d.ts files are written */
  typesDir?: string;
  /** Run ajv validation before every backend call (default: true) */
  validateInputs?: boolean;
  /** Regenerate .d.ts files when a server reconnects (default: true) */
  regenerateOnConnect?: boolean;
}
