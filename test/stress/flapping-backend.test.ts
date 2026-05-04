/**
 * R2 — Flapping-Backend Stress Test
 *
 * Mock backend alternates: 10 successful responses → 10 failures → 10 successful → ...
 * Over 200 calls total (with 20ms inter-call delay so the rolling window expires cleanly).
 *
 * Key design: circuitBreakerWindowMs (150ms) is shorter than one full success window
 * duration (10 calls × 20ms = 200ms), so old successes expire before the failure
 * window accumulates its quota — guaranteeing the circuit can trip.
 *
 * Assertions:
 *   - Circuit trips OPEN during failure windows
 *   - Circuit recovers (half-open or closed) after success windows
 *   - Fast-fails reduce backend load during failure windows (circuit-open fast-fails > 0)
 *   - No calls hang: all 200 gateway calls settle
 *   - State-transition timeline is non-empty (trip/recover events recorded)
 *
 * Success-rate note: with a 50/50 flapping backend, the raw gateway success rate
 * approaches ~50% (success windows succeed fully; failure windows shed load via
 * fast-fails but gateway calls during failure windows still fail). The test
 * validates circuit behaviour and load-shedding — not an absolute success rate.
 *
 * Results emitted to docs/benchmarks/stress/flapping-backend-YYYY-MM-DD.json
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReliabilityGateway,
  CircuitOpenError,
} from '../../src/reliability/index.js';
import type { CircuitState } from '../../src/reliability/profile.js';

const TOTAL_CALLS = 200;
const FLAP_PERIOD = 10;     // 10 success → 10 fail → repeat
const CALL_DELAY_MS = 20;   // delay between calls so rolling window expires cleanly

interface StateTransitionRecord {
  callIndex: number;
  state: CircuitState;
  outcome: 'success' | 'failure' | 'circuit_open';
}

interface FlappingResult {
  totalCalls: number;
  successes: number;
  failures: number;
  circuitOpenFastFails: number;
  /** effectiveSuccessRate = successes / (successes + failures), excluding fast-fails */
  effectiveSuccessRate: number;
  stateTransitions: StateTransitionRecord[];
  everTripped: boolean;
  everRecovered: boolean;
  windowStats: Array<{
    window: number;
    windowType: 'success' | 'failure';
    gatewaySuccesses: number;
    gatewayFailures: number;
    circuitOpen: number;
  }>;
}

/**
 * Flapping backend keyed on a pre-assigned logical-call index (captured before
 * the gateway call) so circuit-open fast-fails don't shift the index.
 */
function makeFlappingBackend(flapPeriod: number) {
  let logicalCallIndex = 0;

  function makeCallFn() {
    const idx = logicalCallIndex++;
    const windowIndex = Math.floor(idx / flapPeriod);
    const isFailureWindow = windowIndex % 2 === 1;

    return async function callTool(): Promise<{ ok: true; call: number }> {
      if (isFailureWindow) {
        throw new Error(`Backend flap error on call ${idx} (window ${windowIndex})`);
      }
      return { ok: true, call: idx };
    };
  }

  return { makeCallFn };
}

let flappingResult: FlappingResult;

describe('R2 — Flapping backend (10-success / 10-failure cycles)', () => {
  beforeAll(async () => {
    const backend = makeFlappingBackend(FLAP_PERIOD);

    // windowMs (150ms) < one full window duration (10 calls × 20ms = 200ms)
    // so old successes expire before the failure window fills its quota.
    const gateway = new ReliabilityGateway({
      defaultProfile: {
        timeoutMs: 500,
        retries: 0,
        retryDelayMs: 10,
        retryMaxDelayMs: 50,
        circuitBreakerThreshold: 0.5,
        circuitBreakerWindowMs: 150,
        circuitBreakerMinCalls: 5,
        halfOpenProbeIntervalMs: 80,
      },
    });

    const stateTransitions: StateTransitionRecord[] = [];
    let prevState: CircuitState = 'closed';

    let successes = 0;
    let failures = 0;
    let circuitOpenFastFails = 0;

    const windowStats: FlappingResult['windowStats'] = [];
    let currentWindow = -1;
    let windowSuccesses = 0;
    let windowFailures = 0;
    let windowCircuitOpen = 0;

    for (let i = 0; i < TOTAL_CALLS; i++) {
      const windowIndex = Math.floor(i / FLAP_PERIOD);

      if (windowIndex !== currentWindow) {
        if (currentWindow >= 0) {
          windowStats.push({
            window: currentWindow,
            windowType: currentWindow % 2 === 0 ? 'success' : 'failure',
            gatewaySuccesses: windowSuccesses,
            gatewayFailures: windowFailures,
            circuitOpen: windowCircuitOpen,
          });
        }
        currentWindow = windowIndex;
        windowSuccesses = 0;
        windowFailures = 0;
        windowCircuitOpen = 0;
      }

      const callFn = backend.makeCallFn();

      let outcome: 'success' | 'failure' | 'circuit_open';
      try {
        await gateway.call('flapping-server', 'flap_tool', callFn);
        successes++;
        windowSuccesses++;
        outcome = 'success';
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          circuitOpenFastFails++;
          windowCircuitOpen++;
          outcome = 'circuit_open';
        } else {
          failures++;
          windowFailures++;
          outcome = 'failure';
        }
      }

      const currentState = gateway.getCircuitState('flapping-server');
      if (currentState !== prevState) {
        stateTransitions.push({ callIndex: i, state: currentState, outcome });
        prevState = currentState;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, CALL_DELAY_MS));
    }

    // Flush final window
    if (currentWindow >= 0) {
      windowStats.push({
        window: currentWindow,
        windowType: currentWindow % 2 === 0 ? 'success' : 'failure',
        gatewaySuccesses: windowSuccesses,
        gatewayFailures: windowFailures,
        circuitOpen: windowCircuitOpen,
      });
    }

    const everTripped = stateTransitions.some((t) => t.state === 'open');
    const everRecovered = stateTransitions.some(
      (t) => t.state === 'closed' || t.state === 'half-open'
    );

    const backendCalls = successes + failures;
    const effectiveSuccessRate = backendCalls > 0 ? successes / backendCalls : 0;

    flappingResult = {
      totalCalls: TOTAL_CALLS,
      successes,
      failures,
      circuitOpenFastFails,
      effectiveSuccessRate,
      stateTransitions,
      everTripped,
      everRecovered,
      windowStats,
    };
  }, 60_000); // 200 calls × 20ms ≈ 4s; generous timeout

  it('circuit breaker trips OPEN during a failure window', () => {
    expect(flappingResult.everTripped).toBe(true);
  });

  it('circuit breaker transitions out of OPEN (half-open or closed) after a success window', () => {
    expect(flappingResult.everRecovered).toBe(true);
  });

  it('circuit-open fast-fails during failure windows reduce backend load', () => {
    // If the breaker works correctly, some calls are fast-failed instead of hitting
    // the failing backend — this is the primary value of the circuit breaker.
    expect(flappingResult.circuitOpenFastFails).toBeGreaterThan(0);
  });

  it('success windows contribute meaningfully — successes ≥ (TOTAL_CALLS / 2) × 0.75', () => {
    // There are 10 success windows × 10 calls = 100 potential successes.
    // The circuit may stay open briefly into success windows (half-open probe
    // allows only one call before closing), so allow 25% slack: successes ≥ 75.
    expect(flappingResult.successes).toBeGreaterThanOrEqual(Math.floor(TOTAL_CALLS / 2 * 0.75));
  });

  it('all 200 gateway calls settle without hanging', () => {
    const accounted =
      flappingResult.successes +
      flappingResult.failures +
      flappingResult.circuitOpenFastFails;
    expect(accounted).toBe(TOTAL_CALLS);
  });

  it('state-transition timeline records at least one transition', () => {
    expect(flappingResult.stateTransitions.length).toBeGreaterThan(0);
  });

  it('emits benchmark JSON to docs/benchmarks/stress/', () => {
    const date = new Date().toISOString().slice(0, 10);
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const outDir = join(root, 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });

    const output = {
      suite: 'R2 — flapping-backend',
      date,
      flapPeriod: FLAP_PERIOD,
      callDelayMs: CALL_DELAY_MS,
      totalCalls: TOTAL_CALLS,
      result: flappingResult,
    };

    writeFileSync(join(outDir, `flapping-backend-${date}.json`), JSON.stringify(output, null, 2));
    expect(flappingResult.totalCalls).toBe(TOTAL_CALLS);
  });
});
