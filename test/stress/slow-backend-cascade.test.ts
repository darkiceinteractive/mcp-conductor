/**
 * R1 — Slow-Backend Cascade Stress Test
 *
 * Sweeps backend response time across: 100ms, 500ms, 1s, 2s, 5s.
 * For each latency bucket:
 *   - Issues 100 concurrent calls through ReliabilityGateway
 *   - Measures timeouts, successes, retry-then-succeed counts
 *   - Asserts clean failure (TimeoutError) within wall-clock ceiling — no hangs
 *
 * The 5s case is gated behind STRESS=1 (takes ~3.5s alone).
 * Results emitted to docs/benchmarks/stress/slow-backend-YYYY-MM-DD.json
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReliabilityGateway,
  TimeoutError,
  RetryExhaustedError,
  CircuitOpenError,
} from '../../src/reliability/index.js';

const IS_STRESS = process.env['STRESS'] === '1';
const CONCURRENCY = 100;
const GATEWAY_TIMEOUT_MS = 3000;

interface BucketResult {
  backendMs: number;
  timeoutMs: number;
  concurrency: number;
  successes: number;
  timeouts: number;
  circuitOpen: number;
  retrySuccesses: number;
  failures: number;
  wallClockMs: number;
  maxSingleCallMs: number;
  allSettledWithinCeilingMs: boolean;
}

function makeSlowBackend(delayMs: number) {
  let callCount = 0;

  async function callTool(): Promise<{ ok: true; callIndex: number }> {
    const idx = callCount++;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return { ok: true, callIndex: idx };
  }

  return { callTool, totalCalls: () => callCount };
}

async function runBucket(
  gateway: ReliabilityGateway,
  backendFn: () => Promise<unknown>,
  server: string,
  concurrency: number
): Promise<{
  successes: number;
  timeouts: number;
  circuitOpen: number;
  other: number;
  durations: number[];
}> {
  let successes = 0;
  let timeouts = 0;
  let circuitOpen = 0;
  let other = 0;
  const durations: number[] = [];

  const tasks = Array.from({ length: concurrency }, async () => {
    const start = Date.now();
    try {
      await gateway.call(server, 'slow_tool', backendFn);
      successes++;
    } catch (err) {
      if (
        err instanceof TimeoutError ||
        (err instanceof RetryExhaustedError && err.lastError instanceof TimeoutError)
      ) {
        timeouts++;
      } else if (err instanceof CircuitOpenError) {
        circuitOpen++;
      } else {
        other++;
      }
    } finally {
      durations.push(Date.now() - start);
    }
  });

  await Promise.all(tasks);
  return { successes, timeouts, circuitOpen, other, durations };
}

const BASE_PROFILE = {
  timeoutMs: GATEWAY_TIMEOUT_MS,
  retries: 1,
  retryDelayMs: 50,
  retryMaxDelayMs: 200,
  circuitBreakerThreshold: 0.7,
  circuitBreakerWindowMs: 10_000,
  circuitBreakerMinCalls: 200, // high — don't trip during concurrent burst
  halfOpenProbeIntervalMs: 5_000,
};

const NON_STRESS_BUCKETS = [100, 500, 1000, 2000] as const;
const results: BucketResult[] = [];

describe('R1 — Slow-backend cascade (100ms → 2s; STRESS=1 adds 5s)', () => {
  beforeAll(async () => {
    for (const backendMs of NON_STRESS_BUCKETS) {
      const server = `slow-backend-${backendMs}ms`;
      const backend = makeSlowBackend(backendMs);
      const gateway = new ReliabilityGateway({ defaultProfile: BASE_PROFILE });

      const wallStart = Date.now();
      const { successes, timeouts, circuitOpen, other, durations } = await runBucket(
        gateway,
        backend.callTool,
        server,
        CONCURRENCY
      );
      const wallClockMs = Date.now() - wallStart;
      const maxSingleCallMs = Math.max(...durations);

      // retrySuccesses: extra backend hits beyond first-attempt count
      const retrySuccesses = Math.max(0, backend.totalCalls() - CONCURRENCY);
      const ceiling = GATEWAY_TIMEOUT_MS * 2 + 500;

      results.push({
        backendMs,
        timeoutMs: GATEWAY_TIMEOUT_MS,
        concurrency: CONCURRENCY,
        successes,
        timeouts,
        circuitOpen,
        retrySuccesses,
        failures: other,
        wallClockMs,
        maxSingleCallMs,
        allSettledWithinCeilingMs: maxSingleCallMs <= ceiling,
      });
    }
  }, 60_000);

  it('100ms backend — all calls succeed (well within timeout)', () => {
    const r = results.find((b) => b.backendMs === 100)!;
    expect(r).toBeDefined();
    expect(r.timeouts).toBe(0);
    expect(r.successes).toBe(CONCURRENCY);
  });

  it('500ms backend — all calls succeed', () => {
    const r = results.find((b) => b.backendMs === 500)!;
    expect(r).toBeDefined();
    expect(r.timeouts).toBe(0);
    expect(r.successes).toBe(CONCURRENCY);
  });

  it('1s backend — all calls succeed', () => {
    const r = results.find((b) => b.backendMs === 1000)!;
    expect(r).toBeDefined();
    expect(r.timeouts).toBe(0);
    expect(r.successes).toBe(CONCURRENCY);
  });

  it('2s backend — all calls succeed (within 3s timeout)', () => {
    const r = results.find((b) => b.backendMs === 2000)!;
    expect(r).toBeDefined();
    expect(r.timeouts).toBe(0);
    expect(r.successes).toBe(CONCURRENCY);
  });

  it('all non-STRESS buckets: no call hangs beyond ceiling (2× timeout + 500ms slop)', () => {
    const ceiling = GATEWAY_TIMEOUT_MS * 2 + 500;
    for (const r of results) {
      expect(
        r.maxSingleCallMs,
        `Backend ${r.backendMs}ms: maxSingle=${r.maxSingleCallMs}ms > ceiling=${ceiling}ms`
      ).toBeLessThanOrEqual(ceiling);
    }
  });

  it.skipIf(!IS_STRESS)(
    'STRESS: 5s backend + 3s timeout — all 100 calls fail (TimeoutError or CircuitOpen) within 3.5s ceiling',
    async () => {
      const backendMs = 5000;
      const server = 'slow-backend-5000ms';
      const backend = makeSlowBackend(backendMs);
      const gateway = new ReliabilityGateway({
        defaultProfile: {
          ...BASE_PROFILE,
          retries: 0, // single-shot — clean timeout
          circuitBreakerMinCalls: 200,
        },
      });

      const wallStart = Date.now();
      const { successes, timeouts, circuitOpen, other, durations } = await runBucket(
        gateway,
        backend.callTool,
        server,
        CONCURRENCY
      );
      const wallClockMs = Date.now() - wallStart;
      const maxSingleCallMs = Math.max(...durations);
      const HARD_CEILING_MS = GATEWAY_TIMEOUT_MS + 500;

      results.push({
        backendMs,
        timeoutMs: GATEWAY_TIMEOUT_MS,
        concurrency: CONCURRENCY,
        successes,
        timeouts,
        circuitOpen,
        retrySuccesses: 0,
        failures: other,
        wallClockMs,
        maxSingleCallMs,
        allSettledWithinCeilingMs: maxSingleCallMs <= HARD_CEILING_MS,
      });

      expect(successes).toBe(0);
      // All calls must resolve as timeout or circuit-open — none can hang
      expect(timeouts + circuitOpen).toBe(CONCURRENCY);
      expect(maxSingleCallMs).toBeLessThanOrEqual(HARD_CEILING_MS);
    },
    15_000
  );

  it('emits benchmark JSON to docs/benchmarks/stress/', () => {
    const date = new Date().toISOString().slice(0, 10);
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const outDir = join(root, 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });

    const output = {
      suite: 'R1 — slow-backend-cascade',
      date,
      gatewayTimeoutMs: GATEWAY_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      buckets: results,
    };

    writeFileSync(join(outDir, `slow-backend-${date}.json`), JSON.stringify(output, null, 2));
    expect(results.length).toBeGreaterThan(0);
  });
});
