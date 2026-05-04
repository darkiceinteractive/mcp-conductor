/**
 * Circuit breaker — closed/open/half-open state machine with rolling failure window.
 *
 * Tracks success/failure ratio within a configurable time window. When the ratio
 * drops below the threshold AND the minimum call count is met, the circuit trips
 * OPEN. After halfOpenProbeIntervalMs the circuit moves to HALF-OPEN allowing
 * exactly one probe call. A successful probe closes the circuit; a failed probe
 * re-opens it.
 */

import { CircuitOpenError } from './errors.js';
import { CircuitState, type ReliabilityProfile, DEFAULT_PROFILE } from './profile.js';

interface CallRecord {
  /** Timestamp of the call (ms since epoch) */
  ts: number;
  /** Whether the call succeeded */
  success: boolean;
}

export interface BreakerStats {
  state: CircuitState;
  totalCalls: number;
  successes: number;
  failures: number;
  /** Timestamp when circuit last tripped OPEN (ms since epoch), if ever */
  lastTrip?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private window: CallRecord[] = [];
  private lastTrip?: number;
  /** When in HALF-OPEN, true if a probe is already in flight */
  private probeInFlight = false;

  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly minCalls: number;
  private readonly halfOpenIntervalMs: number;
  private readonly server: string;

  constructor(server: string, profile: Partial<ReliabilityProfile> = {}) {
    this.server = server;
    this.threshold = profile.circuitBreakerThreshold ?? DEFAULT_PROFILE.circuitBreakerThreshold;
    this.windowMs = profile.circuitBreakerWindowMs ?? DEFAULT_PROFILE.circuitBreakerWindowMs;
    this.minCalls = profile.circuitBreakerMinCalls ?? DEFAULT_PROFILE.circuitBreakerMinCalls;
    this.halfOpenIntervalMs =
      profile.halfOpenProbeIntervalMs ?? DEFAULT_PROFILE.halfOpenProbeIntervalMs;
  }

  /** Current circuit state. */
  getState(): CircuitState {
    this._maybeTransitionToHalfOpen();
    return this.state;
  }

  /**
   * Check whether a call should be allowed through.
   * Throws CircuitOpenError if the circuit is OPEN (fast-fail).
   * In HALF-OPEN allows exactly one concurrent probe call.
   */
  allowCall(tool: string): void {
    this._maybeTransitionToHalfOpen();

    if (this.state === 'open') {
      throw new CircuitOpenError(this.server, tool);
    }

    if (this.state === 'half-open') {
      if (this.probeInFlight) {
        // Another probe is already in flight — fail fast for subsequent calls
        throw new CircuitOpenError(this.server, tool);
      }
      this.probeInFlight = true;
    }
  }

  /**
   * Record a successful call outcome.
   * If in HALF-OPEN, close the circuit.
   */
  recordSuccess(): void {
    this._pruneWindow();
    this.window.push({ ts: Date.now(), success: true });

    if (this.state === 'half-open') {
      this.probeInFlight = false;
      this.state = 'closed';
      this.window = []; // reset window on recovery
    }
  }

  /**
   * Record a failed call outcome.
   * Re-evaluates the failure ratio; may trip or re-trip the circuit.
   */
  recordFailure(): void {
    this._pruneWindow();
    this.window.push({ ts: Date.now(), success: false });

    if (this.state === 'half-open') {
      // Probe failed — return to OPEN
      this.probeInFlight = false;
      this.state = 'open';
      this.lastTrip = Date.now();
      return;
    }

    if (this.state === 'closed') {
      this._maybeTrip();
    }
  }

  /** Reset the circuit to CLOSED, clearing the window. */
  reset(): void {
    this.state = 'closed';
    this.window = [];
    this.lastTrip = undefined;
    this.probeInFlight = false;
  }

  /** Snapshot of current statistics (window-based). */
  getStats(): BreakerStats {
    this._pruneWindow();
    const successes = this.window.filter((r) => r.success).length;
    const failures = this.window.filter((r) => !r.success).length;
    return {
      state: this.getState(),
      totalCalls: this.window.length,
      successes,
      failures,
      lastTrip: this.lastTrip,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _pruneWindow(): void {
    const cutoff = Date.now() - this.windowMs;
    this.window = this.window.filter((r) => r.ts >= cutoff);
  }

  private _maybeTrip(): void {
    if (this.window.length < this.minCalls) return;

    const failures = this.window.filter((r) => !r.success).length;
    const ratio = failures / this.window.length;

    if (ratio > this.threshold) {
      this.state = 'open';
      this.lastTrip = Date.now();
    }
  }

  private _maybeTransitionToHalfOpen(): void {
    if (this.state === 'open' && this.lastTrip !== undefined) {
      const elapsed = Date.now() - this.lastTrip;
      if (elapsed >= this.halfOpenIntervalMs) {
        this.state = 'half-open';
        this.probeInFlight = false;
      }
    }
  }
}
