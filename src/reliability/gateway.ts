/**
 * ReliabilityGateway — composes timeout, retry, and circuit breaker into a
 * single call pipeline.
 *
 * Wiring order (cache sits in front of this layer per Agent B):
 *   cache miss → ReliabilityGateway.call() → backend fn
 *
 * Profile resolution order:
 *   tool-level ToolDefinition.reliability → server-level config → global default
 */

import { CircuitBreaker } from './breaker.js';
import {
  CircuitOpenError,
  MCPToolError,
  RetryExhaustedError,
  TimeoutError,
  extractErrorCode,
} from './errors.js';
import {
  DEFAULT_PROFILE,
  applyMutationDefault,
  resolveProfile,
  type CircuitState,
  type ReliabilityProfile,
} from './profile.js';
import { withRetry } from './retry.js';
import { withTimeoutSimple } from './timeout.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public stats types
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerStats {
  totalCalls: number;
  successes: number;
  failures: number;
  timeouts: number;
  retries: number;
  circuitState: CircuitState;
  lastTrip?: number;
}

export interface ReliabilityStats {
  byServer: Record<string, ServerStats>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal tool-lookup interface so ReliabilityGateway can resolve per-tool
 * profiles without importing the full ToolRegistry (avoids circular deps).
 */
export interface ToolLookup {
  getToolReliability(server: string, tool: string): ReliabilityProfile | undefined;
}

export interface GatewayOptions {
  /** Optional per-tool profile resolver (typically the ToolRegistry) */
  toolLookup?: ToolLookup;
  /** Global default profile override */
  defaultProfile?: ReliabilityProfile;
  /**
   * Per-server profile overrides, keyed by server name.
   * Corresponds to the `reliability.perServer` block in conductor config.
   */
  serverProfiles?: Record<string, ReliabilityProfile>;
  /**
   * Per-tool profile overrides, keyed by "server.tool".
   * Corresponds to the `reliability.perTool` block in conductor config.
   */
  toolProfiles?: Record<string, ReliabilityProfile>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutable stats accumulator (private)
// ─────────────────────────────────────────────────────────────────────────────

interface MutableStats {
  totalCalls: number;
  successes: number;
  failures: number;
  timeouts: number;
  retries: number;
}

function emptyMutableStats(): MutableStats {
  return { totalCalls: 0, successes: 0, failures: 0, timeouts: 0, retries: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ReliabilityGateway
// ─────────────────────────────────────────────────────────────────────────────

export class ReliabilityGateway {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly stats = new Map<string, MutableStats>();
  private readonly options: Required<Omit<GatewayOptions, 'toolLookup'>> & {
    toolLookup?: ToolLookup;
  };

  constructor(options: GatewayOptions = {}) {
    this.options = {
      toolLookup: options.toolLookup,
      defaultProfile: options.defaultProfile ?? DEFAULT_PROFILE,
      serverProfiles: options.serverProfiles ?? {},
      toolProfiles: options.toolProfiles ?? {},
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute `fn` with full reliability protection: timeout → retry → circuit breaker.
   *
   * Returns the resolved value of `fn` or throws one of:
   *   - CircuitOpenError (circuit OPEN, fast-fail)
   *   - TimeoutError (single attempt timed out, retries=0)
   *   - RetryExhaustedError (all attempts failed)
   *   - MCPToolError (non-retryable upstream error wrapped by hub)
   *   - original error (non-retryable, non-MCPToolError)
   */
  async call<T>(server: string, tool: string, fn: () => Promise<T>): Promise<T> {
    const profile = this._resolveProfile(server, tool);
    const breaker = this._breaker(server, profile);
    const acc = this._accumulator(server);

    acc.totalCalls++;

    // Fast-fail if circuit is open
    breaker.allowCall(tool);

    let attemptCount = 0;

    const wrappedFn = async (): Promise<T> => {
      attemptCount++;
      const attempt = attemptCount;

      // Count retries (all attempts after the first)
      if (attempt > 1) {
        acc.retries++;
      }

      return withTimeoutSimple(fn, {
        timeoutMs: profile.timeoutMs,
        server,
        tool,
        attempt,
      });
    };

    try {
      const result = await withRetry(wrappedFn, {
        retries: profile.retries,
        retryDelayMs: profile.retryDelayMs,
        retryMaxDelayMs: profile.retryMaxDelayMs,
        server,
        tool,
      });

      breaker.recordSuccess();
      acc.successes++;
      return result;
    } catch (err) {
      breaker.recordFailure();
      acc.failures++;

      // Count timeouts: either a direct TimeoutError or a RetryExhaustedError
      // whose last underlying cause was a TimeoutError.
      if (err instanceof TimeoutError) {
        acc.timeouts++;
        throw err;
      }

      if (err instanceof RetryExhaustedError) {
        if (err.lastError instanceof TimeoutError) {
          acc.timeouts++;
        }
        // When there was only one attempt (retries=0), surface the underlying
        // error directly so the sandbox sees the specific error type (TimeoutError,
        // etc.) rather than the wrapping RetryExhaustedError.
        if (err.attempts === 1 && err.lastError instanceof Error) {
          throw err.lastError;
        }
      }

      throw err;
    }
  }

  /** Current circuit state for a server. Returns 'closed' if never seen. */
  getCircuitState(server: string): CircuitState {
    return this.breakers.get(server)?.getState() ?? 'closed';
  }

  /** Aggregate stats snapshot across all servers seen so far. */
  getStats(): ReliabilityStats {
    const byServer: Record<string, ServerStats> = {};

    for (const [server, acc] of this.stats) {
      const breaker = this.breakers.get(server);
      const breakerStats = breaker?.getStats();
      byServer[server] = {
        totalCalls: acc.totalCalls,
        successes: acc.successes,
        failures: acc.failures,
        timeouts: acc.timeouts,
        retries: acc.retries,
        circuitState: breakerStats?.state ?? 'closed',
        lastTrip: breakerStats?.lastTrip,
      };
    }

    return { byServer };
  }

  /** Reset circuit breaker for a specific server back to CLOSED. */
  resetCircuit(server: string): void {
    this.breakers.get(server)?.reset();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _breaker(server: string, profile: Required<ReliabilityProfile>): CircuitBreaker {
    if (!this.breakers.has(server)) {
      this.breakers.set(server, new CircuitBreaker(server, profile));
    }
    return this.breakers.get(server)!;
  }

  private _accumulator(server: string): MutableStats {
    if (!this.stats.has(server)) {
      this.stats.set(server, emptyMutableStats());
    }
    return this.stats.get(server)!;
  }

  /**
   * Resolve the effective profile for a specific server+tool combination.
   *
   * Priority (highest → lowest):
   *   1. toolProfiles["server.tool"]
   *   2. toolLookup.getToolReliability(server, tool) [ToolDefinition.reliability]
   *   3. serverProfiles[server]
   *   4. defaultProfile (global)
   *   5. DEFAULT_PROFILE (hardcoded fallback)
   *
   * After resolution, mutation default is applied (retries forced to 0 if
   * no explicit retries were set for a mutation-named tool).
   */
  private _resolveProfile(server: string, tool: string): Required<ReliabilityProfile> {
    const globalBase = resolveProfile(this.options.defaultProfile);

    // Layer 3: server-level override
    const serverOverride = this.options.serverProfiles[server];
    const afterServer = serverOverride ? resolveProfile(serverOverride, globalBase) : globalBase;

    // Layer 2: tool-level from ToolDefinition (via registry lookup)
    const registryOverride = this.options.toolLookup?.getToolReliability(server, tool);
    const afterRegistry = registryOverride
      ? resolveProfile(registryOverride, afterServer)
      : afterServer;

    // Layer 1: explicit tool profile key "server.tool"
    const toolKey = `${server}.${tool}`;
    const toolOverride = this.options.toolProfiles[toolKey];
    const explicit = toolOverride ? resolveProfile(toolOverride, afterRegistry) : afterRegistry;

    // Determine whether retries were explicitly set at a tool/server-specific
    // override level. The global defaultProfile does NOT count as an explicit
    // override — if only the global default has retries set, mutations still
    // get retries forced to 0 by applyMutationDefault.
    const explicitRetries =
      toolOverride?.retries !== undefined ||
      registryOverride?.retries !== undefined ||
      serverOverride?.retries !== undefined;

    return applyMutationDefault(tool, explicit, explicitRetries);
  }
}

// Re-export error types at gateway level for convenience
export { CircuitOpenError, MCPToolError, RetryExhaustedError, TimeoutError, extractErrorCode };
