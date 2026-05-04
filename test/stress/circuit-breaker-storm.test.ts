/**
 * R3 — Circuit-Breaker Storm Test
 *
 * 5 concurrent backends:
 *   - t=0ms:    all 5 healthy
 *   - t=300ms:  backends B, C, D go DOWN
 *   - t=600ms:  backend D recovers
 *   - t=1200ms: test ends; B, C remain down
 *
 * Key design: circuitBreakerWindowMs (120ms) is shorter than the failure window
 * duration (~300ms at 15ms/call), so old successes expire before failures
 * accumulate — guaranteeing each downed backend's circuit trips.
 *
 * Assertions:
 *   - Healthy backends (A, E) never trip
 *   - Downed backends (B, C, D) each trip their circuit
 *   - Recovered backend (D) transitions out of OPEN after recovery
 *   - Permanently downed backends (B, C) accumulate fast-fails, no retry storm
 *
 * Results emitted to docs/benchmarks/stress/circuit-storm-YYYY-MM-DD.json
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

const DOWN_AT_MS = 300;
const RECOVER_AT_MS = 600;
const TEST_DURATION_MS = 1200;
const CALL_INTERVAL_MS = 15;

const BACKENDS = ['A', 'B', 'C', 'D', 'E'] as const;
type BackendName = (typeof BACKENDS)[number];

// windowMs=120ms < failure window duration (~300ms) so old successes expire
// before the failure quota builds up in the rolling window.
const STRESS_PROFILE = {
  timeoutMs: 100,
  retries: 0,
  retryDelayMs: 10,
  retryMaxDelayMs: 50,
  circuitBreakerThreshold: 0.5,
  circuitBreakerWindowMs: 120,
  circuitBreakerMinCalls: 5,
  halfOpenProbeIntervalMs: 80,
};

interface BackendStats {
  name: BackendName;
  totalGatewayCalls: number;
  successes: number;
  failures: number;
  circuitOpenFastFails: number;
  trippedAt?: number;
  recoveredAt?: number;
  stateTimeline: Array<{ ts: number; state: CircuitState }>;
}

let backendStats: Map<BackendName, BackendStats>;

describe('R3 — Circuit-breaker storm (5 backends, 3 go down, 1 recovers)', () => {
  beforeAll(async () => {
    // Separate gateway per backend — independent circuit breakers
    const gateways = new Map<BackendName, ReliabilityGateway>(
      BACKENDS.map((name) => [name, new ReliabilityGateway({ defaultProfile: STRESS_PROFILE })])
    );

    const testStart = Date.now();

    backendStats = new Map(
      BACKENDS.map((name) => [
        name,
        {
          name,
          totalGatewayCalls: 0,
          successes: 0,
          failures: 0,
          circuitOpenFastFails: 0,
          stateTimeline: [],
        } as BackendStats,
      ])
    );

    const prevStates = new Map<BackendName, CircuitState>(
      BACKENDS.map((name) => [name, 'closed'])
    );

    while (Date.now() - testStart < TEST_DURATION_MS) {
      const elapsed = Date.now() - testStart;

      await Promise.all(
        BACKENDS.map(async (name) => {
          const stats = backendStats.get(name)!;
          const gw = gateways.get(name)!;
          stats.totalGatewayCalls++;

          // Is this backend currently down?
          const isDown =
            (name === 'B' || name === 'C' || name === 'D') &&
            elapsed >= DOWN_AT_MS &&
            !(name === 'D' && elapsed >= RECOVER_AT_MS);

          const backendFn = isDown
            ? async () => { throw new Error(`Backend ${name} is down`); }
            : async () => ({ backend: name, ts: Date.now() });

          try {
            await gw.call(`server-${name}`, 'storm_tool', backendFn);
            stats.successes++;
          } catch (err) {
            if (err instanceof CircuitOpenError) {
              stats.circuitOpenFastFails++;
            } else {
              stats.failures++;
            }
          }

          // Record circuit state transitions
          const state = gw.getCircuitState(`server-${name}`);
          const prev = prevStates.get(name)!;
          if (state !== prev) {
            const ts = elapsed;
            stats.stateTimeline.push({ ts, state });
            if (state === 'open' && stats.trippedAt === undefined) {
              stats.trippedAt = ts;
            }
            if (
              (state === 'closed' || state === 'half-open') &&
              prev === 'open' &&
              stats.recoveredAt === undefined
            ) {
              stats.recoveredAt = ts;
            }
            prevStates.set(name, state);
          }
        })
      );

      await new Promise<void>((resolve) => setTimeout(resolve, CALL_INTERVAL_MS));
    }
  }, 30_000);

  it('Backend A (always healthy) never trips its circuit', () => {
    const stats = backendStats.get('A')!;
    expect(stats.trippedAt).toBeUndefined();
    expect(stats.successes).toBeGreaterThan(0);
  });

  it('Backend E (always healthy) never trips its circuit', () => {
    const stats = backendStats.get('E')!;
    expect(stats.trippedAt).toBeUndefined();
    expect(stats.successes).toBeGreaterThan(0);
  });

  it('Backend B circuit trips after going down', () => {
    const stats = backendStats.get('B')!;
    expect(stats.trippedAt).toBeDefined();
    // Trip must occur after it went down
    expect(stats.trippedAt!).toBeGreaterThanOrEqual(DOWN_AT_MS - CALL_INTERVAL_MS * 2);
  });

  it('Backend C circuit trips after going down', () => {
    const stats = backendStats.get('C')!;
    expect(stats.trippedAt).toBeDefined();
    expect(stats.trippedAt!).toBeGreaterThanOrEqual(DOWN_AT_MS - CALL_INTERVAL_MS * 2);
  });

  it('Backend D circuit trips after going down', () => {
    const stats = backendStats.get('D')!;
    expect(stats.trippedAt).toBeDefined();
    expect(stats.trippedAt!).toBeGreaterThanOrEqual(DOWN_AT_MS - CALL_INTERVAL_MS * 2);
  });

  it('Backend D transitions out of OPEN after recovery (half-open or closed observed)', () => {
    const stats = backendStats.get('D')!;
    // After D recovers at RECOVER_AT_MS, circuit should probe (half-open) and close
    const postRecovery = stats.stateTimeline.filter(
      (t) => t.ts >= RECOVER_AT_MS && (t.state === 'half-open' || t.state === 'closed')
    );
    expect(postRecovery.length).toBeGreaterThan(0);
  });

  it('Backend B stays open — circuit-open fast-fails prove no retry storm', () => {
    const stats = backendStats.get('B')!;
    if (stats.trippedAt !== undefined) {
      expect(stats.circuitOpenFastFails).toBeGreaterThan(0);
    }
  });

  it('Backend C stays open — circuit-open fast-fails prove no retry storm', () => {
    const stats = backendStats.get('C')!;
    if (stats.trippedAt !== undefined) {
      expect(stats.circuitOpenFastFails).toBeGreaterThan(0);
    }
  });

  it('all backends: total calls = successes + failures + circuit-open (no silent drops)', () => {
    for (const [, stats] of backendStats) {
      const accounted = stats.successes + stats.failures + stats.circuitOpenFastFails;
      expect(accounted).toBe(stats.totalGatewayCalls);
    }
  });

  it('emits per-backend state timeline JSON to docs/benchmarks/stress/', () => {
    const date = new Date().toISOString().slice(0, 10);
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const outDir = join(root, 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });

    const output = {
      suite: 'R3 — circuit-breaker-storm',
      date,
      constants: { DOWN_AT_MS, RECOVER_AT_MS, TEST_DURATION_MS, CALL_INTERVAL_MS },
      profile: STRESS_PROFILE,
      backends: Object.fromEntries(backendStats),
    };

    writeFileSync(join(outDir, `circuit-storm-${date}.json`), JSON.stringify(output, null, 2));
    expect(backendStats.size).toBe(5);
  });
});
