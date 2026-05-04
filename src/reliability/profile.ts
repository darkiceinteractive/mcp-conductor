/**
 * ReliabilityProfile — per-tool/per-server/global reliability configuration.
 *
 * Resolution order:
 *   tool-level ToolDefinition.reliability → server-level config → global default
 */

export interface ReliabilityProfile {
  /** Call timeout in ms. Default: 10000 */
  timeoutMs?: number;
  /**
   * Number of retry attempts after the initial failure.
   * Default: 2 for reads, 0 for mutations.
   */
  retries?: number;
  /** Initial retry delay in ms; doubles on each attempt. Default: 100 */
  retryDelayMs?: number;
  /** Maximum retry delay ceiling in ms. Default: 5000 */
  retryMaxDelayMs?: number;
  /**
   * Failure ratio (0–1) that trips the circuit OPEN when exceeded.
   * Default: 0.5
   */
  circuitBreakerThreshold?: number;
  /** Rolling window for failure ratio tracking in ms. Default: 60000 */
  circuitBreakerWindowMs?: number;
  /** Minimum calls in the window before the circuit can trip. Default: 10 */
  circuitBreakerMinCalls?: number;
  /** How long to wait in OPEN state before allowing a probe. Default: 30000 */
  halfOpenProbeIntervalMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Global defaults applied when no profile field is provided. */
export const DEFAULT_PROFILE: Required<ReliabilityProfile> = {
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 100,
  retryMaxDelayMs: 5_000,
  circuitBreakerThreshold: 0.5,
  circuitBreakerWindowMs: 60_000,
  circuitBreakerMinCalls: 10,
  halfOpenProbeIntervalMs: 30_000,
};

/**
 * Merge profile overrides onto the global default, producing a fully-resolved
 * profile with every field set.
 */
export function resolveProfile(
  override?: ReliabilityProfile,
  base: Required<ReliabilityProfile> = DEFAULT_PROFILE
): Required<ReliabilityProfile> {
  if (!override) return base;
  return {
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    retries: override.retries ?? base.retries,
    retryDelayMs: override.retryDelayMs ?? base.retryDelayMs,
    retryMaxDelayMs: override.retryMaxDelayMs ?? base.retryMaxDelayMs,
    circuitBreakerThreshold: override.circuitBreakerThreshold ?? base.circuitBreakerThreshold,
    circuitBreakerWindowMs: override.circuitBreakerWindowMs ?? base.circuitBreakerWindowMs,
    circuitBreakerMinCalls: override.circuitBreakerMinCalls ?? base.circuitBreakerMinCalls,
    halfOpenProbeIntervalMs: override.halfOpenProbeIntervalMs ?? base.halfOpenProbeIntervalMs,
  };
}

/**
 * Mutation tool name patterns — tools matching any of these patterns do NOT
 * retry by default (retries forced to 0 unless the profile explicitly overrides).
 */
const MUTATION_PATTERNS = [/_create$/, /_update$/, /_delete$/, /_remove$/, /_write$/];

/** Returns true if the tool name matches a mutation pattern. */
export function isMutation(toolName: string): boolean {
  return MUTATION_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Apply mutation override: if the tool is a mutation AND the resolved profile
 * did not explicitly set `retries`, force retries to 0.
 *
 * We detect "explicitly set" by checking whether the override provided the
 * `retries` field directly (i.e., override?.retries is a number).
 */
export function applyMutationDefault(
  toolName: string,
  profile: Required<ReliabilityProfile>,
  explicitRetries: boolean
): Required<ReliabilityProfile> {
  if (isMutation(toolName) && !explicitRetries) {
    return { ...profile, retries: 0 };
  }
  return profile;
}
