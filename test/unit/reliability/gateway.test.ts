import { describe, expect, test, vi } from 'vitest';
import { ReliabilityGateway } from '../../../src/reliability/gateway.js';
import {
  CircuitOpenError,
  RetryExhaustedError,
  TimeoutError,
} from '../../../src/reliability/errors.js';
import type { ToolLookup } from '../../../src/reliability/gateway.js';

const SERVER = 'ibkr';
const TOOL = 'get_portfolio';

/** Fast profile for deterministic tests — low thresholds, tiny timeouts */
const fastProfile = {
  timeoutMs: 50,
  retries: 1,
  retryDelayMs: 1,
  retryMaxDelayMs: 5,
  circuitBreakerThreshold: 0.5,
  circuitBreakerMinCalls: 4,
  halfOpenProbeIntervalMs: 30,
};

describe('ReliabilityGateway', () => {
  test('passes successful call through unchanged', async () => {
    const gw = new ReliabilityGateway({ defaultProfile: fastProfile });
    const fn = vi.fn(async () => ({ price: 100 }));
    const result = await gw.call(SERVER, TOOL, fn);
    expect(result).toEqual({ price: 100 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('circuit-open returns CircuitOpenError without calling fn', async () => {
    const gw = new ReliabilityGateway({ defaultProfile: fastProfile });
    // Trip circuit with enough failures (minCalls=4, threshold=0.5 → need >50%)
    // Each gateway.call with retries=1 → up to 2 fn invocations per call
    const failFn = async () => { throw new TimeoutError(SERVER, TOOL, 50, 1); };
    for (let i = 0; i < 4; i++) {
      await gw.call(SERVER, TOOL, failFn).catch(() => {});
    }
    expect(gw.getCircuitState(SERVER)).toBe('open');

    const trackedFn = vi.fn(async () => 'should-not-run');
    await expect(gw.call(SERVER, TOOL, trackedFn)).rejects.toThrow(CircuitOpenError);
    expect(trackedFn).not.toHaveBeenCalled();
  });

  test('retries on timeout then succeeds', async () => {
    const gw = new ReliabilityGateway({
      defaultProfile: { ...fastProfile, retries: 2, circuitBreakerMinCalls: 100 },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(new TimeoutError(SERVER, TOOL, 50, 1))
      .mockResolvedValue('ok');
    const result = await gw.call(SERVER, TOOL, fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('full pipeline: timeout → retry → circuit trip', async () => {
    const profile = { ...fastProfile, retries: 0 };
    const gw = new ReliabilityGateway({ defaultProfile: profile });
    const failFn = async () => { throw new TimeoutError(SERVER, TOOL, 50, 1); };

    for (let i = 0; i < 4; i++) {
      await gw.call(SERVER, TOOL, failFn).catch(() => {});
    }
    expect(gw.getCircuitState(SERVER)).toBe('open');
    await expect(gw.call(SERVER, TOOL, failFn)).rejects.toThrow(CircuitOpenError);
  });

  test('mutations do not retry by default', async () => {
    // No explicit retries in any override layer → mutation forced to retries=0
    const gw = new ReliabilityGateway({
      defaultProfile: {
        timeoutMs: 50,
        retryDelayMs: 1,
        retryMaxDelayMs: 5,
        circuitBreakerThreshold: 0.9,
        circuitBreakerMinCalls: 100,
        halfOpenProbeIntervalMs: 30_000,
        // retries intentionally omitted → applyMutationDefault forces 0 for mutations
      },
    });
    const fn = vi.fn().mockRejectedValue(new TimeoutError(SERVER, 'order_create', 50, 1));
    // retries=0 → 1 attempt → gateway unwraps RetryExhaustedError(attempts=1) → TimeoutError
    await expect(gw.call(SERVER, 'order_create', fn)).rejects.toThrow(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('stats reflect ground truth across mixed workload', async () => {
    const gw = new ReliabilityGateway({
      defaultProfile: {
        ...fastProfile,
        retries: 0,           // 1 attempt per call, no retry noise
        circuitBreakerMinCalls: 100,
      },
    });
    const successFn = async () => 'ok';
    const failFn = async () => { throw new TimeoutError(SERVER, TOOL, 50, 1); };

    await gw.call(SERVER, TOOL, successFn);
    await gw.call(SERVER, TOOL, successFn);
    await gw.call(SERVER, TOOL, failFn).catch(() => {});
    await gw.call(SERVER, TOOL, failFn).catch(() => {});

    const stats = gw.getStats();
    const s = stats.byServer[SERVER];
    expect(s).toBeDefined();
    expect(s.totalCalls).toBe(4);
    expect(s.successes).toBe(2);
    expect(s.failures).toBe(2);
    expect(s.timeouts).toBe(2);
  });

  test('IBKR-style hang fixture terminates within budget', async () => {
    const gw = new ReliabilityGateway({
      defaultProfile: {
        timeoutMs: 100,
        retries: 0,
        retryDelayMs: 10,
        retryMaxDelayMs: 50,
        circuitBreakerThreshold: 0.9,
        circuitBreakerMinCalls: 100,
        halfOpenProbeIntervalMs: 30_000,
      },
    });
    const hangFn = () => new Promise<never>(() => {});
    const start = Date.now();
    // retries=0 → 1 attempt → TimeoutError unwrapped from RetryExhaustedError
    await expect(gw.call('ibkr', 'get_portfolio', hangFn)).rejects.toThrow(TimeoutError);
    expect(Date.now() - start).toBeLessThan(500);
  }, 3000);

  test('per-server profile override applied correctly', async () => {
    const gw = new ReliabilityGateway({
      defaultProfile: { timeoutMs: 10_000, circuitBreakerMinCalls: 100 },
      serverProfiles: {
        ibkr: { timeoutMs: 80, retries: 0, circuitBreakerMinCalls: 100 },
      },
    });
    const hangFn = () => new Promise<never>(() => {});
    const start = Date.now();
    await expect(gw.call('ibkr', 'get_quotes', hangFn)).rejects.toThrow(TimeoutError);
    expect(Date.now() - start).toBeLessThan(500);
  }, 2000);

  test('per-tool profile via toolProfiles overrides server profile', async () => {
    const gw = new ReliabilityGateway({
      defaultProfile: { timeoutMs: 10_000, circuitBreakerMinCalls: 100 },
      serverProfiles: { ibkr: { timeoutMs: 5_000 } },
      toolProfiles: {
        'ibkr.get_portfolio': { timeoutMs: 60, retries: 0, circuitBreakerMinCalls: 100 },
      },
    });
    const hangFn = () => new Promise<never>(() => {});
    const start = Date.now();
    await expect(gw.call('ibkr', 'get_portfolio', hangFn)).rejects.toThrow(TimeoutError);
    expect(Date.now() - start).toBeLessThan(300);
  }, 2000);

  test('ToolLookup registry override applied', async () => {
    const lookup: ToolLookup = {
      getToolReliability: (server, tool) => {
        if (server === 'ibkr' && tool === 'slow_tool') {
          return { timeoutMs: 60, retries: 0 };
        }
        return undefined;
      },
    };
    const gw = new ReliabilityGateway({
      defaultProfile: { timeoutMs: 10_000, circuitBreakerMinCalls: 100 },
      toolLookup: lookup,
    });
    const hangFn = () => new Promise<never>(() => {});
    const start = Date.now();
    await expect(gw.call('ibkr', 'slow_tool', hangFn)).rejects.toThrow(TimeoutError);
    expect(Date.now() - start).toBeLessThan(300);
  }, 2000);

  test('resetCircuit moves circuit back to closed', async () => {
    const gw = new ReliabilityGateway({ defaultProfile: fastProfile });
    const failFn = async () => { throw new TimeoutError(SERVER, TOOL, 50, 1); };
    for (let i = 0; i < 4; i++) {
      await gw.call(SERVER, TOOL, failFn).catch(() => {});
    }
    expect(gw.getCircuitState(SERVER)).toBe('open');
    gw.resetCircuit(SERVER);
    expect(gw.getCircuitState(SERVER)).toBe('closed');
  });
});
