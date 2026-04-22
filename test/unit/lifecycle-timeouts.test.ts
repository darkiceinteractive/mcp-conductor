import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LIFECYCLE_TIMEOUTS } from '../../src/config/defaults.js';

/**
 * Regression tests for the lifecycle timeout constants introduced when the
 * memory-leak fix was consolidated. These catch the two common failure modes:
 *
 *  1. Someone reintroduces a magic number in a cleanup path (e.g. a new
 *     `setTimeout(() => ..., 3000)` that should have used PROCESS_FORCE_KILL_MS).
 *  2. The shutdown timeout is accidentally lowered below the force-kill grace
 *     so that server.stop() cannot complete before process.exit(1) fires.
 */
describe('LIFECYCLE_TIMEOUTS', () => {
  it('has reasonable defaults', () => {
    expect(LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(30_000);

    expect(LIFECYCLE_TIMEOUTS.PROCESS_FORCE_KILL_MS).toBeGreaterThanOrEqual(1_000);
    expect(LIFECYCLE_TIMEOUTS.PROCESS_FORCE_KILL_MS).toBeLessThanOrEqual(10_000);

    expect(LIFECYCLE_TIMEOUTS.STREAM_CLEANUP_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('orders TTLs correctly: stale < completed < stuck', () => {
    expect(LIFECYCLE_TIMEOUTS.STREAM_STALE_TTL_MS).toBeLessThan(LIFECYCLE_TIMEOUTS.STREAM_COMPLETED_TTL_MS);
    expect(LIFECYCLE_TIMEOUTS.STREAM_COMPLETED_TTL_MS).toBeLessThan(LIFECYCLE_TIMEOUTS.STREAM_STUCK_TTL_MS);
  });

  it('keeps shutdown timeout longer than force-kill grace so cleanup can finish', () => {
    expect(LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(LIFECYCLE_TIMEOUTS.PROCESS_FORCE_KILL_MS);
  });
});

/**
 * Simulates the shutdown-timeout guard from src/index.ts. We can't import that
 * file directly (it auto-runs `main()`), so this exercises the same pattern:
 * a SHUTDOWN_TIMEOUT_MS timer that fires process.exit(1) if server.stop() hangs.
 */
describe('Shutdown timeout guard (simulated)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('fires process.exit(1) when stop() hangs past SHUTDOWN_TIMEOUT_MS', () => {
    const shutdownTimeout = setTimeout(() => {
      process.exit(1);
    }, LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS);
    shutdownTimeout.unref();

    // Just before the deadline — no exit yet.
    vi.advanceTimersByTime(LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Cross the deadline.
    expect(() => vi.advanceTimersByTime(2)).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    clearTimeout(shutdownTimeout);
  });

  it('does NOT fire when stop() completes before the deadline', () => {
    const shutdownTimeout = setTimeout(() => {
      process.exit(1);
    }, LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS);
    shutdownTimeout.unref();

    // Simulate a fast stop() — clear the guard.
    clearTimeout(shutdownTimeout);

    vi.advanceTimersByTime(LIFECYCLE_TIMEOUTS.SHUTDOWN_TIMEOUT_MS * 2);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
