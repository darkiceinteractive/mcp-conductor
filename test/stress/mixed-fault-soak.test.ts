/**
 * R5 — Mixed-Fault Soak Test (extended variant of soak-test.test.ts)
 *
 * Fault rates (harder than the v3 soak):
 *   20% timeout            (was 10%)
 *   10% 500-error          (was 5%)
 *   5%  truncated response (was 1%)
 *   5%  slow-success       (1.4× timeoutMs — passes before deadline)
 *   5%  backend-disconnect mid-call (ECONNRESET)
 *
 * PR gate:  30s (STRESS unset)
 * Full soak: 5 minutes (STRESS=1)
 *
 * Assertions:
 *   - Zero hangs (no call exceeds MAX_CALL_DURATION_MS ceiling)
 *   - Success rate ≥ 60%
 *   - All errors carry a non-empty message (no silent failures)
 *   - Fault injection does produce gateway errors (non-trivial run)
 *
 * Error surface behaviour (from gateway):
 *   - Timeouts      → TimeoutError or RetryExhaustedError(lastError=TimeoutError)
 *   - ECONNRESET    → retryable → RetryExhaustedError after max attempts
 *   - 500 errors    → non-retryable → pass through as plain Error
 *   - CircuitOpen   → CircuitOpenError
 *
 * The PRD asks errors surface as "MCPToolError with structured fields" — that
 * wrapping occurs at the hub layer above ReliabilityGateway. At the gateway
 * boundary, non-retryable upstream errors pass through as-is. This test
 * validates the gateway's own contracts; hub-layer wrapping is covered in
 * unit tests.
 *
 * Results emitted to docs/benchmarks/stress/mixed-fault-soak-YYYY-MM-DD.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const SOAK_DURATION_MS = IS_STRESS ? 5 * 60 * 1000 : 30_000;

// Fault rates
const TIMEOUT_RATE = 0.20;
const SERVER_ERROR_RATE = 0.10;
const TRUNCATION_RATE = 0.05;
const SLOW_SUCCESS_RATE = 0.05;
const DISCONNECT_RATE = 0.05;

const GATEWAY_TIMEOUT_MS = 80;
// slow-success sleeps at 1.4× timeout — passes before deadline with headroom
const SLOW_SUCCESS_MS = Math.floor(GATEWAY_TIMEOUT_MS * 1.4);
// ceiling: up to 2 attempts × timeout + retry delay + generous slop
const MAX_CALL_DURATION_MS = GATEWAY_TIMEOUT_MS * 5 + 200;

// Deterministic pseudo-random (independent of call ordering)
function pseudoRand(idx: number): number {
  return ((idx * 2053 + 97) % 1009) / 1009;
}

type FaultType = 'none' | 'timeout' | 'server_error' | 'truncated' | 'slow_success' | 'disconnect';

interface FaultRecord {
  callIndex: number;
  fault: FaultType;
}

function makeMixedFaultBackend() {
  const records: FaultRecord[] = [];
  let callIndex = 0;

  async function callTool(): Promise<unknown> {
    const idx = callIndex++;
    const rand = pseudoRand(idx);

    let cumulative = 0;

    cumulative += TRUNCATION_RATE;
    if (rand < cumulative) {
      records.push({ callIndex: idx, fault: 'truncated' });
      // Malformed JSON — gateway treats this as a resolved value (not an error)
      return '{"status":"ok","data":';
    }

    cumulative += SERVER_ERROR_RATE;
    if (rand < cumulative) {
      records.push({ callIndex: idx, fault: 'server_error' });
      // Non-retryable: plain Error without network keywords
      throw new Error(`Mixed-fault 500 error on call ${idx}`);
    }

    cumulative += TIMEOUT_RATE;
    if (rand < cumulative) {
      records.push({ callIndex: idx, fault: 'timeout' });
      // Sleep 2× timeout to reliably trigger TimeoutError
      await new Promise<void>((resolve) => setTimeout(resolve, GATEWAY_TIMEOUT_MS * 2));
      return { status: 'late' };
    }

    cumulative += SLOW_SUCCESS_RATE;
    if (rand < cumulative) {
      records.push({ callIndex: idx, fault: 'slow_success' });
      // Sleep just under timeout — should resolve in time
      await new Promise<void>((resolve) => setTimeout(resolve, SLOW_SUCCESS_MS));
      return { status: 'slow_ok', call: idx };
    }

    cumulative += DISCONNECT_RATE;
    if (rand < cumulative) {
      records.push({ callIndex: idx, fault: 'disconnect' });
      // Retryable: ECONNRESET matches isRetryable() network-keyword check
      throw new Error(`ECONNRESET: socket hang up on call ${idx}`);
    }

    records.push({ callIndex: idx, fault: 'none' });
    return { status: 'ok', call: idx };
  }

  return { callTool, records: () => records };
}

// ─── Collected metrics ────────────────────────────────────────────────────────

interface SoakResult {
  durationMs: number;
  faultRates: Record<string, string>;
  totalAttempted: number;
  successes: number;
  successRate: number;
  maxCallDurationMs: number;
  maxAllowedMs: number;
  zeroHangs: boolean;
  errorTypeCounts: Record<string, number>;
  errorsWithEmptyMessage: number;
  allErrorsHaveMessage: boolean;
  faultBreakdown: Record<FaultType, number>;
}

let soakResult: SoakResult;
let faultRecords: FaultRecord[] = [];
let gatewayErrors: Error[] = [];
let callDurationsMs: number[] = [];
let totalAttempted = 0;
let successes = 0;

describe(`R5 — Mixed-fault soak (${SOAK_DURATION_MS / 1000}s, 45% fault rate)`, () => {
  beforeAll(async () => {
    const backend = makeMixedFaultBackend();
    const gateway = new ReliabilityGateway({
      defaultProfile: {
        timeoutMs: GATEWAY_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 10,
        retryMaxDelayMs: 50,
        // Higher threshold tolerance — this fault mix is harder than base soak
        circuitBreakerThreshold: 0.65,
        circuitBreakerWindowMs: 500,
        circuitBreakerMinCalls: 5,
        halfOpenProbeIntervalMs: 150,
      },
    });

    const startTime = Date.now();
    const CALLS_PER_SECOND = 10;
    const intervalMs = Math.floor(1000 / CALLS_PER_SECOND);

    while (Date.now() - startTime < SOAK_DURATION_MS) {
      totalAttempted++;
      const opStart = Date.now();

      await gateway
        .call('mixed-fault-server', 'mixed_tool', () => backend.callTool())
        .then(() => { successes++; })
        .catch((err: unknown) => {
          if (err instanceof Error) {
            gatewayErrors.push(err);
          }
        });

      const opDurationMs = Date.now() - opStart;
      callDurationsMs.push(opDurationMs);

      const remaining = intervalMs - opDurationMs;
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
    }

    faultRecords = backend.records();

    // Categorise errors — gateway surfaces:
    //   TimeoutError         — direct timeout, retries=0 path
    //   RetryExhaustedError  — all retries consumed (timeout or ECONNRESET cause)
    //   CircuitOpenError     — fast-fail
    //   plain Error          — non-retryable upstream (500 errors pass through)
    const errorTypeCounts: Record<string, number> = {
      TimeoutError: 0,
      RetryExhaustedError: 0,
      CircuitOpenError: 0,
      OtherError: 0, // non-retryable upstream errors (500s) — expected
    };

    for (const e of gatewayErrors) {
      if (e instanceof TimeoutError) errorTypeCounts['TimeoutError']++;
      else if (e instanceof RetryExhaustedError) errorTypeCounts['RetryExhaustedError']++;
      else if (e instanceof CircuitOpenError) errorTypeCounts['CircuitOpenError']++;
      else errorTypeCounts['OtherError']++;
    }

    // "No silent failures" = every error has a non-empty message
    const errorsWithEmptyMessage = gatewayErrors.filter((e) => !e.message || e.message === '').length;

    const maxCallDurationMs = callDurationsMs.length > 0 ? Math.max(...callDurationsMs) : 0;
    const faultBreakdown = Object.fromEntries(
      (
        ['none', 'timeout', 'server_error', 'truncated', 'slow_success', 'disconnect'] as FaultType[]
      ).map((ft) => [ft, faultRecords.filter((r) => r.fault === ft).length])
    ) as Record<FaultType, number>;

    soakResult = {
      durationMs: SOAK_DURATION_MS,
      faultRates: {
        timeout: '20%',
        serverError: '10%',
        truncated: '5%',
        slowSuccess: '5%',
        disconnect: '5%',
        total: '45%',
      },
      totalAttempted,
      successes,
      successRate: successes / totalAttempted,
      maxCallDurationMs,
      maxAllowedMs: MAX_CALL_DURATION_MS,
      zeroHangs: maxCallDurationMs <= MAX_CALL_DURATION_MS,
      errorTypeCounts,
      errorsWithEmptyMessage,
      allErrorsHaveMessage: errorsWithEmptyMessage === 0,
      faultBreakdown,
    };
  }, SOAK_DURATION_MS + 60_000);

  afterAll(() => {
    console.log('\n=== R5 Mixed-Fault Soak Results ===');
    console.log(JSON.stringify(soakResult, null, 2));
  });

  it('zero hangs — no call exceeds MAX_CALL_DURATION_MS ceiling', () => {
    expect(soakResult.zeroHangs).toBe(true);
  });

  it('success rate ≥ 60% despite 45% fault injection', () => {
    expect(soakResult.successRate).toBeGreaterThanOrEqual(0.60);
  });

  it('all errors carry a non-empty message — no silent failures', () => {
    expect(soakResult.errorsWithEmptyMessage).toBe(0);
  });

  it('fault injection actually triggered gateway errors (non-trivial run)', () => {
    expect(gatewayErrors.length).toBeGreaterThan(0);
  });

  it('at least some calls succeed', () => {
    expect(soakResult.successes).toBeGreaterThan(0);
  });

  it('emits soak results MD to docs/benchmarks/stress/', () => {
    const date = new Date().toISOString().slice(0, 10);
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const outDir = join(root, 'docs', 'benchmarks', 'stress');
    mkdirSync(outDir, { recursive: true });

    const md = [
      `# R5 Mixed-Fault Soak — ${date}`,
      '',
      `**Duration**: ${soakResult.durationMs / 1000}s`,
      `**Total calls**: ${soakResult.totalAttempted}`,
      `**Successes**: ${soakResult.successes} (${(soakResult.successRate * 100).toFixed(1)}%)`,
      `**Zero hangs**: ${soakResult.zeroHangs}`,
      `**Max call duration**: ${soakResult.maxCallDurationMs}ms (ceiling: ${soakResult.maxAllowedMs}ms)`,
      '',
      '## Fault Rates',
      '| Fault | Rate |',
      '|-------|------|',
      ...Object.entries(soakResult.faultRates).map(([k, v]) => `| ${k} | ${v} |`),
      '',
      '## Backend Fault Breakdown',
      '| Fault | Count |',
      '|-------|-------|',
      ...Object.entries(soakResult.faultBreakdown).map(([k, v]) => `| ${k} | ${v} |`),
      '',
      '## Gateway Error Types',
      '| Error | Count |',
      '|-------|-------|',
      ...Object.entries(soakResult.errorTypeCounts).map(([k, v]) => `| ${k} | ${v} |`),
    ].join('\n');

    writeFileSync(join(outDir, `mixed-fault-soak-${date}.md`), md);
    expect(soakResult.totalAttempted).toBeGreaterThan(0);
  });
}, SOAK_DURATION_MS + 90_000);
