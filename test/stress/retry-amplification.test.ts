/**
 * R4 — Retry Amplification Bounds Test
 *
 * Backend returns an error for the first 3 attempts and succeeds on the 4th.
 * Verifies that retries are bounded — no infinite loops, no amplification storms.
 *
 * Assertions per concurrency level:
 *   - Total backend hits ≤ concurrency × maxAttempts (4)
 *   - End-to-end success rate = 100%
 *   - Wall time ≤ retryDelayMs × maxAttempts × 2 (generous ceiling)
 *
 * Concurrency sweep: 1, 5, 50, 500
 * 500-concurrent case gated behind STRESS=1.
 *
 * Results emitted to docs/benchmarks/stress/retry-amplification-YYYY-MM-DD.json
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReliabilityGateway,
  TimeoutError,
} from '../../src/reliability/index.js';

const IS_STRESS = process.env['STRESS'] === '1';

const FAIL_FIRST_N = 3;   // fail for the first N attempts per logical call
const MAX_RETRIES = 3;     // gateway retries (= 3 extra attempts after first → 4 total)
const RETRY_DELAY_MS = 10;
const RETRY_MAX_DELAY_MS = 50;

// Wall-time ceiling: retryDelayMs × maxAttempts × 2 (generous for scheduler jitter)
const WALL_CEILING_MS = RETRY_DELAY_MS * (MAX_RETRIES + 1) * 2 + 200;

interface AmplificationResult {
  concurrency: number;
  totalBackendCalls: number;
  maxExpectedBackendCalls: number;
  successes: number;
  failures: number;
  wallClockMs: number;
  wallCeilingMs: number;
  withinCeiling: boolean;
  amplificationFactor: number; // totalBackendCalls / concurrency
}

/**
 * Build a per-call counter backend that fails the first `failFirstN` calls
 * for each *logical* invocation instance (tracked by closure per instance).
 *
 * Each gateway call creates its own closure, so each logical call has its own
 * failure counter independent of other concurrent calls.
 */
function makeRetryBackend(failFirstN: number) {
  let totalCallCount = 0;

  function makeCallFn() {
    let attemptForThisCall = 0;

    return async function callTool(): Promise<{ ok: true; attempt: number }> {
      totalCallCount++;
      attemptForThisCall++;

      if (attemptForThisCall <= failFirstN) {
        // Throw a retryable timeout error so gateway will retry
        throw new TimeoutError('retry-server', 'retry_tool', 100, attemptForThisCall);
      }

      return { ok: true, attempt: attemptForThisCall };
    };
  }

  return { makeCallFn, totalCalls: () => totalCallCount };
}

const NON_STRESS_CONCURRENCIES = [1, 5, 50] as const;
const results: AmplificationResult[] = [];

async function runConcurrencyLevel(
  concurrency: number
): Promise<AmplificationResult> {
  const backend = makeRetryBackend(FAIL_FIRST_N);

  const gateway = new ReliabilityGateway({
    defaultProfile: {
      timeoutMs: 500,
      retries: MAX_RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
      retryMaxDelayMs: RETRY_MAX_DELAY_MS,
      circuitBreakerThreshold: 0.95, // very high — don't trip during retry test
      circuitBreakerWindowMs: 30_000,
      circuitBreakerMinCalls: concurrency * (MAX_RETRIES + 1) + 10,
    },
  });

  let successes = 0;
  let failures = 0;

  const wallStart = Date.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const callFn = backend.makeCallFn();
      try {
        await gateway.call('retry-server', 'retry_tool', callFn);
        successes++;
      } catch {
        failures++;
      }
    })
  );

  const wallClockMs = Date.now() - wallStart;
  const totalBackendCalls = backend.totalCalls();
  const maxExpectedBackendCalls = concurrency * (MAX_RETRIES + 1); // 4 attempts per call

  return {
    concurrency,
    totalBackendCalls,
    maxExpectedBackendCalls,
    successes,
    failures,
    wallClockMs,
    wallCeilingMs: WALL_CEILING_MS,
    withinCeiling: wallClockMs <= WALL_CEILING_MS,
    amplificationFactor: totalBackendCalls / concurrency,
  };
}

describe('R4 — Retry amplification bounds (concurrency: 1, 5, 50; STRESS=1 adds 500)', () => {
  beforeAll(async () => {
    for (const concurrency of NON_STRESS_CONCURRENCIES) {
      const result = await runConcurrencyLevel(concurrency);
      results.push(result);
    }
  }, 60_000);

  it('concurrency=1: total backend calls bounded at ≤ 4 (1 × 4 attempts)', () => {
    const r = results.find((r) => r.concurrency === 1)!;
    expect(r.successes).toBe(1);
    expect(r.totalBackendCalls).toBeLessThanOrEqual(r.maxExpectedBackendCalls);
    expect(r.amplificationFactor).toBeLessThanOrEqual(MAX_RETRIES + 1);
  });

  it('concurrency=1: success rate 100%', () => {
    const r = results.find((r) => r.concurrency === 1)!;
    expect(r.successes).toBe(r.concurrency);
    expect(r.failures).toBe(0);
  });

  it('concurrency=5: total backend calls ≤ 5 × 4 = 20', () => {
    const r = results.find((r) => r.concurrency === 5)!;
    expect(r.totalBackendCalls).toBeLessThanOrEqual(r.maxExpectedBackendCalls);
    expect(r.successes).toBe(5);
    expect(r.failures).toBe(0);
  });

  it('concurrency=50: total backend calls ≤ 50 × 4 = 200', () => {
    const r = results.find((r) => r.concurrency === 50)!;
    expect(r.totalBackendCalls).toBeLessThanOrEqual(r.maxExpectedBackendCalls);
    expect(r.successes).toBe(50);
    expect(r.failures).toBe(0);
  });

  it('all non-STRESS levels: wall time within ceiling (no retry storm delays)', () => {
    for (const r of results) {
      expect(
        r.wallClockMs,
        `concurrency=${r.concurrency}: wallClock=${r.wallClockMs}ms > ceiling=${WALL_CEILING_MS}ms`
      ).toBeLessThanOrEqual(WALL_CEILING_MS);
    }
  });

  it('amplification factor ≤ 4 for all non-STRESS levels (bounded retry)', () => {
    for (const r of results) {
      expect(
        r.amplificationFactor,
        `concurrency=${r.concurrency}: amplification=${r.amplificationFactor} > 4`
      ).toBeLessThanOrEqual(MAX_RETRIES + 1);
    }
  });

  it.skipIf(!IS_STRESS)(
    'STRESS: concurrency=500 — 500×4=2000 max backend calls, 100% success, within ceiling',
    async () => {
      const result = await runConcurrencyLevel(500);
      results.push(result);

      expect(result.successes).toBe(500);
      expect(result.failures).toBe(0);
      expect(result.totalBackendCalls).toBeLessThanOrEqual(result.maxExpectedBackendCalls);
      expect(result.amplificationFactor).toBeLessThanOrEqual(MAX_RETRIES + 1);
      // Wall ceiling is more generous for 500 concurrent (scheduling overhead)
      expect(result.wallClockMs).toBeLessThanOrEqual(WALL_CEILING_MS * 5);
    },
    60_000
  );

  it('emits amplification-factor breakdown JSON to docs/benchmarks/stress/', () => {
    const date = new Date().toISOString().slice(0, 10);
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const outDir = join(root, 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });

    const output = {
      suite: 'R4 — retry-amplification',
      date,
      config: {
        failFirstN: FAIL_FIRST_N,
        maxRetries: MAX_RETRIES,
        retryDelayMs: RETRY_DELAY_MS,
        wallCeilingMs: WALL_CEILING_MS,
      },
      results,
    };

    writeFileSync(
      join(outDir, `retry-amplification-${date}.json`),
      JSON.stringify(output, null, 2)
    );
    expect(results.length).toBeGreaterThan(0);
  });
});
