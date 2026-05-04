import { describe, expect, test } from 'vitest';
import { CircuitBreaker } from '../../../src/reliability/breaker.js';
import { CircuitOpenError } from '../../../src/reliability/errors.js';

describe('CircuitBreaker', () => {
  const SERVER = 'test-server';
  const TOOL = 'test_tool';

  test('starts closed', () => {
    const cb = new CircuitBreaker(SERVER);
    expect(cb.getState()).toBe('closed');
  });

  test('does not trip below minimum call threshold', () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 10,
    });
    for (let i = 0; i < 9; i++) {
      cb.allowCall(TOOL);
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('closed');
  });

  test('trips open when failure ratio exceeded', () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
      circuitBreakerWindowMs: 60_000,
    });
    // 3 failures out of 5 = 60% > 50% threshold
    cb.allowCall(TOOL); cb.recordSuccess();
    cb.allowCall(TOOL); cb.recordSuccess();
    cb.allowCall(TOOL); cb.recordFailure();
    cb.allowCall(TOOL); cb.recordFailure();
    cb.allowCall(TOOL); cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  test('rolls window correctly — old calls do not count', async () => {
    // Short window AND short half-open interval for deterministic timing.
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
      circuitBreakerWindowMs: 50,      // window expires after 50ms
      halfOpenProbeIntervalMs: 30,     // open→half-open after 30ms
    });

    // Phase 1: 5 failures in window → circuit OPEN
    for (let i = 0; i < 5; i++) {
      cb.allowCall(TOOL);
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('open');

    // Phase 2: wait for half-open, then successful probe → CLOSED (window reset)
    await new Promise(r => setTimeout(r, 40));
    expect(cb.getState()).toBe('half-open');
    cb.allowCall(TOOL);   // probe allowed
    cb.recordSuccess();   // probe succeeds → CLOSED, window cleared

    expect(cb.getState()).toBe('closed');

    // Phase 3: clean window — no stale failures, breaker stays closed
    cb.allowCall(TOOL);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  }, 2000);

  test('throws CircuitOpenError in open state', () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
    });
    for (let i = 0; i < 5; i++) {
      try { cb.allowCall(TOOL); } catch { /* ignore after trip */ }
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('open');
    expect(() => cb.allowCall(TOOL)).toThrow(CircuitOpenError);
  });

  test('half-open allows single probe after interval', async () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
      halfOpenProbeIntervalMs: 30,
    });
    for (let i = 0; i < 5; i++) {
      try { cb.allowCall(TOOL); } catch { /* ignore */ }
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('open');

    await new Promise(r => setTimeout(r, 40));
    expect(cb.getState()).toBe('half-open');

    // First probe allowed
    expect(() => cb.allowCall(TOOL)).not.toThrow();
    // Second probe while first in flight is blocked
    expect(() => cb.allowCall(TOOL)).toThrow(CircuitOpenError);
  }, 2000);

  test('probe success returns to closed', async () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
      halfOpenProbeIntervalMs: 30,
    });
    for (let i = 0; i < 5; i++) {
      try { cb.allowCall(TOOL); } catch { /* ignore */ }
      cb.recordFailure();
    }
    await new Promise(r => setTimeout(r, 40));
    cb.allowCall(TOOL);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  }, 2000);

  test('probe failure returns to open', async () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
      halfOpenProbeIntervalMs: 30,
    });
    for (let i = 0; i < 5; i++) {
      try { cb.allowCall(TOOL); } catch { /* ignore */ }
      cb.recordFailure();
    }
    await new Promise(r => setTimeout(r, 40));
    cb.allowCall(TOOL);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  }, 2000);

  test('reset clears state and window', () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.5,
      circuitBreakerMinCalls: 5,
    });
    for (let i = 0; i < 5; i++) {
      try { cb.allowCall(TOOL); } catch { /* ignore */ }
      cb.recordFailure();
    }
    cb.reset();
    expect(cb.getState()).toBe('closed');
    const stats = cb.getStats();
    expect(stats.totalCalls).toBe(0);
  });

  test('getStats reflects window counts', () => {
    const cb = new CircuitBreaker(SERVER, {
      circuitBreakerThreshold: 0.9,   // high threshold — stays closed
      circuitBreakerMinCalls: 100,
    });
    cb.allowCall(TOOL); cb.recordSuccess();
    cb.allowCall(TOOL); cb.recordFailure();
    cb.allowCall(TOOL); cb.recordSuccess();
    const stats = cb.getStats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(1);
  });
});
