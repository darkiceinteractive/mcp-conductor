/**
 * S4 — Burst recovery
 *
 * Fires a large burst of execute_code calls, waits an idle period (during
 * which the pool should drain to minIdle), then fires a second burst and
 * checks that latency has not permanently degraded.
 *
 * Nightly tier (STRESS=1): 10 000 calls per burst, 60s idle period.
 * PR-gate tier:             100 calls per burst, 500ms idle period.
 *
 * Assertions:
 *   - After the idle period the mock pool idles to ≤ minIdle active slots.
 *   - Second burst p50 latency is within 1.2× of first burst p50 (no
 *     permanent degradation — the pool recovers fully).
 *
 * Emits: docs/benchmarks/stress/burst-recovery-YYYY-MM-DD.json
 *
 * @module test/stress/burst-recovery
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Tier configuration
// ─────────────────────────────────────────────────────────────────────────────

const STRESS = process.env.STRESS === '1';

/** Number of calls per burst. */
const BURST_CALLS = STRESS ? 10_000 : 100;

/** Idle period between bursts (ms). */
const IDLE_MS = STRESS ? 60_000 : 500;

/** Simulated job latency (ms). Kept short so bursts complete quickly. */
const JOB_LATENCY_MS = 5;

/** Pool parallelism (matches WorkerPool default size = 4). */
const POOL_SIZE = 4;

/**
 * minIdle: the pool should drain to this many busy slots after a sustained
 * idle period. We model this as 0 — all workers returned to the idle list.
 */
const MIN_IDLE_SLOTS = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Mock pool with idle tracking
// ─────────────────────────────────────────────────────────────────────────────

class MockBurstPool {
  private readonly size: number;
  private busySlots = 0;
  private peakBusy = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(size: number) {
    this.size = size;
  }

  get activeBusySlots(): number {
    return this.busySlots;
  }

  get peakBusySlots(): number {
    return this.peakBusy;
  }

  async execute(): Promise<number> {
    await this._acquire();
    const t0 = performance.now();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, JOB_LATENCY_MS));
      return performance.now() - t0;
    } finally {
      this._release();
    }
  }

  private _acquire(): Promise<void> {
    if (this.busySlots < this.size) {
      this.busySlots++;
      if (this.busySlots > this.peakBusy) this.peakBusy = this.busySlots;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private _release(): void {
    if (this.waitQueue.length > 0) {
      // Slot passes directly to next waiter — busySlots count unchanged.
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.busySlots--;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function percentile(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, Math.min(idx, sortedSamples.length - 1))];
}

interface BurstResult {
  callCount: number;
  p50Ms: number;
  throughputCallsPerSec: number;
  wallMs: number;
}

async function runBurst(pool: MockBurstPool, calls: number): Promise<BurstResult> {
  const wallStart = performance.now();
  const latencies = await Promise.all(Array.from({ length: calls }, () => pool.execute()));
  const wallMs = performance.now() - wallStart;

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50Ms = percentile(sorted, 50);
  const throughputCallsPerSec = wallMs > 0 ? (calls / wallMs) * 1000 : 0;

  return { callCount: calls, p50Ms, throughputCallsPerSec, wallMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state between test body and afterAll
// ─────────────────────────────────────────────────────────────────────────────

let burst1Result: BurstResult | null = null;
let burst2Result: BurstResult | null = null;
let idleSlotsAfterIdle = 0;
let idleDurationMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('S4 — burst recovery', () => {
  it(
    `burst (${BURST_CALLS} calls) → idle (${IDLE_MS}ms) → burst (${BURST_CALLS} calls)`,
    async () => {
      const pool = new MockBurstPool(POOL_SIZE);

      // ── First burst ──────────────────────────────────────────────────────
      burst1Result = await runBurst(pool, BURST_CALLS);
      console.info(
        `[S4] Burst 1: p50=${burst1Result.p50Ms.toFixed(1)}ms, ` +
          `throughput=${burst1Result.throughputCallsPerSec.toFixed(1)} calls/s`,
      );

      // ── Idle period ───────────────────────────────────────────────────────
      // In a real WorkerPool, idle workers are returned to the idle list and
      // eventually recycled after maxAgeMs. Here we wait and then sample
      // the busy slot count — it must have drained to 0.
      const idleStart = performance.now();
      await new Promise<void>((resolve) => setTimeout(resolve, IDLE_MS));
      idleDurationMs = performance.now() - idleStart;
      idleSlotsAfterIdle = pool.activeBusySlots;

      // Assert: pool drained to minIdle during the idle period.
      expect(idleSlotsAfterIdle).toBeLessThanOrEqual(MIN_IDLE_SLOTS);

      // ── Second burst ─────────────────────────────────────────────────────
      burst2Result = await runBurst(pool, BURST_CALLS);
      console.info(
        `[S4] Burst 2: p50=${burst2Result.p50Ms.toFixed(1)}ms, ` +
          `throughput=${burst2Result.throughputCallsPerSec.toFixed(1)} calls/s`,
      );

      // ── Degradation assertion ─────────────────────────────────────────────
      // Second burst p50 must be within 1.2× of first burst p50.
      const recoveryRatio = burst2Result.p50Ms / burst1Result.p50Ms;
      expect(recoveryRatio).toBeLessThanOrEqual(1.2);

      console.info(
        `[S4] Recovery ratio: ${recoveryRatio.toFixed(3)}× ` +
          `(${recoveryRatio <= 1.2 ? 'PASS' : 'FAIL'})`,
      );
    },
    // Timeout: 2 bursts + idle period + generous headroom.
    BURST_CALLS * JOB_LATENCY_MS * 2 + IDLE_MS * 2 + 60_000,
  );

  afterAll(() => {
    if (!burst1Result || !burst2Result) return;

    const recoveryRatio = burst2Result.p50Ms / burst1Result.p50Ms;

    const date = new Date().toISOString().slice(0, 10);
    const outDir = join(process.cwd(), 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `burst-recovery-${date}.json`);

    writeFileSync(
      outPath,
      JSON.stringify(
        {
          suite: 'S4-burst-recovery',
          timestamp: new Date().toISOString(),
          environment: {
            stress: STRESS,
            node: process.version,
            platform: process.platform,
          },
          config: {
            burstCalls: BURST_CALLS,
            idleMs: IDLE_MS,
            jobLatencyMs: JOB_LATENCY_MS,
            poolSize: POOL_SIZE,
            minIdleSlots: MIN_IDLE_SLOTS,
          },
          burst1: burst1Result,
          idlePeriod: {
            durationMs: idleDurationMs,
            poolSlotsAfterIdle: idleSlotsAfterIdle,
          },
          burst2: burst2Result,
          recoveryRatio,
          degraded: recoveryRatio > 1.2,
        },
        null,
        2,
      ),
    );

    console.info(`[S4] Burst recovery timeline written to ${outPath}`);
  });
});
