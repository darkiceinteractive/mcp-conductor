/**
 * Soak Test — Fault-Injected Backend (10-second representative sample)
 *
 * Validates MCP Conductor reliability under sustained fault injection:
 *   - 10%% timeout fault rate
 *   - 5%%  server error fault rate
 *   - 1%%  truncated response fault rate
 *
 * Full 1-hour soak: SOAK_DURATION_MS=3600000 npx vitest run soak-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MCPToolError,
  ReliabilityGateway,
  TimeoutError,
  RetryExhaustedError,
  CircuitOpenError,
} from '../../src/reliability/index.js';

const SOAK_DURATION_MS = parseInt(process.env['SOAK_DURATION_MS'] ?? '10000', 10);
const CALLS_PER_SECOND = 10;
const TIMEOUT_FAULT_RATE = 0.10;
const SERVER_ERROR_RATE = 0.05;
const TRUNCATION_RATE = 0.01;
const GATEWAY_TIMEOUT_MS = 80;
/** Maximum allowed ms for any single gateway call (gateway timeout × 3 retries + generous buffer) */
const MAX_CALL_DURATION_MS = GATEWAY_TIMEOUT_MS * 5;

interface FaultRecord {
  callIndex: number;
  fault: 'none' | 'timeout' | 'server_error' | 'truncated';
}

function makeFaultingBackend() {
  const records: FaultRecord[] = [];
  let callIndex = 0;

  async function callTool(): Promise<unknown> {
    const idx = callIndex++;
    const rand = ((idx * 1597 + 53) % 997) / 997;

    if (rand < TRUNCATION_RATE) {
      records.push({ callIndex: idx, fault: 'truncated' });
      return '{"status":"ok","data":';
    }
    if (rand < TRUNCATION_RATE + SERVER_ERROR_RATE) {
      records.push({ callIndex: idx, fault: 'server_error' });
      throw new Error(`Backend 500 error on call ${idx}`);
    }
    if (rand < TRUNCATION_RATE + SERVER_ERROR_RATE + TIMEOUT_FAULT_RATE) {
      // Sleep slightly longer than gateway timeout to trigger TimeoutError
      await new Promise<void>((resolve) => setTimeout(resolve, GATEWAY_TIMEOUT_MS * 2));
      records.push({ callIndex: idx, fault: 'timeout' });
      return { status: 'ok' };
    }
    records.push({ callIndex: idx, fault: 'none' });
    return { status: 'ok', call: idx };
  }

  return { callTool, records: () => records };
}

describe(`Soak Test — ${SOAK_DURATION_MS / 1000}s representative run`, () => {
  let faultRecords: FaultRecord[] = [];
  let gatewayErrors: Error[] = [];
  let callDurationsMs: number[] = [];
  let totalAttempted = 0;
  let successes = 0;

  beforeAll(async () => {
    const backend = makeFaultingBackend();
    const gateway = new ReliabilityGateway({
      defaultProfile: {
        timeoutMs: GATEWAY_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 10,
        retryMaxDelayMs: 50,
        circuitBreakerThreshold: 0.6,
        circuitBreakerWindowMs: 500,
        circuitBreakerMinCalls: 5,
        halfOpenProbeIntervalMs: 200,
      },
    });

    const startTime = Date.now();
    const intervalMs = Math.floor(1000 / CALLS_PER_SECOND);

    while (Date.now() - startTime < SOAK_DURATION_MS) {
      totalAttempted++;
      const opStart = Date.now();

      await gateway
        .call('soak-server', 'soak-tool', () => backend.callTool())
        .then(() => { successes++; })
        .catch((err: unknown) => {
          if (err instanceof Error) gatewayErrors.push(err);
        });

      const opDurationMs = Date.now() - opStart;
      callDurationsMs.push(opDurationMs);

      const elapsed = opDurationMs;
      if (elapsed < intervalMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs - elapsed));
      }
    }

    faultRecords = backend.records();
  }, SOAK_DURATION_MS + 30_000);

  afterAll(() => {
    const maxDuration = Math.max(...callDurationsMs);
    const faultBreakdown = {
      none: faultRecords.filter((r) => r.fault === 'none').length,
      timeout: faultRecords.filter((r) => r.fault === 'timeout').length,
      server_error: faultRecords.filter((r) => r.fault === 'server_error').length,
      truncated: faultRecords.filter((r) => r.fault === 'truncated').length,
    };
    const errorTypes = {
      TimeoutError: gatewayErrors.filter((e) => e instanceof TimeoutError).length,
      RetryExhaustedError: gatewayErrors.filter((e) => e instanceof RetryExhaustedError).length,
      CircuitOpenError: gatewayErrors.filter((e) => e instanceof CircuitOpenError).length,
      MCPToolError: gatewayErrors.filter((e) => e instanceof MCPToolError).length,
      Other: gatewayErrors.filter(
        (e) => !(e instanceof TimeoutError) && !(e instanceof RetryExhaustedError) &&
               !(e instanceof CircuitOpenError) && !(e instanceof MCPToolError)
      ).length,
    };

    const stats = {
      durationMs: SOAK_DURATION_MS,
      faultRates: { timeout: '10%%', serverError: '5%%', truncated: '1%%' },
      totalAttempted,
      successes,
      gatewayErrors: gatewayErrors.length,
      faultBreakdown,
      errorTypes,
      maxCallDurationMs: maxDuration,
      maxAllowedDurationMs: MAX_CALL_DURATION_MS,
      hangFree: maxDuration <= MAX_CALL_DURATION_MS,
      successRate: `${(successes / totalAttempted * 100).toFixed(1)}%%`,
    };

    console.log('\n=== Soak Test Results ===');
    console.log(JSON.stringify(stats, null, 2));
  });

  it('no calls exceed max duration — zero hangs', () => {
    const maxDuration = Math.max(...callDurationsMs);
    // With 1 retry + timeouts, worst case is: gateway_timeout × 2 + retry_delay
    // Allow generous 5× headroom for Node.js timer imprecision
    expect(maxDuration).toBeLessThanOrEqual(MAX_CALL_DURATION_MS);
  });

  it('fault injection produces gateway errors — faults are surfaced', () => {
    expect(gatewayErrors.length).toBeGreaterThan(0);
  });

  it('at least some calls succeed despite 15%% fault injection', () => {
    expect(successes).toBeGreaterThan(0);
  });

  it('all errors carry a message — no silent failures', () => {
    const silent = gatewayErrors.filter((e) => !e.message || e.message === '');
    expect(silent.length).toBe(0);
  });
}, SOAK_DURATION_MS + 60_000);
