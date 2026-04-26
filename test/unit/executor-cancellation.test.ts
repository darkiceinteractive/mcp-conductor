import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DenoExecutor } from '../../src/runtime/executor.js';

/**
 * Phase 1.5 — MCP cancellation for execute_code.
 *
 * The SDK 1.29 hands an AbortSignal to tool handlers via RequestHandlerExtra.
 * We plumb that signal into DenoExecutor so a client cancelling an in-flight
 * request actually kills the Deno process.
 */

describe('DenoExecutor — MCP cancellation', () => {
  let executor: DenoExecutor;

  beforeEach(() => {
    executor = new DenoExecutor({
      maxMemoryMb: 128,
      allowedNetHosts: ['localhost'],
      maxConcurrentProcesses: 5,
      maxOutputBytes: 1024 * 1024,
    });
  });

  afterEach(async () => {
    await executor.shutdown();
  });

  it('short-circuits when the signal is already aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute('return 1;', {
      timeoutMs: 5000,
      bridgeUrl: 'http://127.0.0.1:1',
      servers: [],
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/cancel/i);
    // No process should have been spawned.
    expect(executor.getActiveProcessCount()).toBe(0);
  });

  it('accepts a caller-provided execution id', async () => {
    // Execute a tiny script so we can assert the id flows through.
    const preallocated = executor.generateExecutionId();
    const controller = new AbortController();
    controller.abort(); // abort immediately — keeps the test fast + sandboxed

    const result = await executor.execute('return 1;', {
      timeoutMs: 5000,
      bridgeUrl: 'http://127.0.0.1:1',
      servers: [],
      signal: controller.signal,
      executionId: preallocated,
    });

    expect(result.executionId).toBe(preallocated);
  });

  it('removes the abort listener even when spawn fails (no leak)', async () => {
    // Force a spawn failure by misconfiguring PATH so `deno` is unfindable.
    const savedPath = process.env.PATH;
    const savedDeno = (executor as unknown as { denoAvailable: boolean | null }).denoAvailable;
    // Mark deno as available so checkDeno() doesn't short-circuit.
    (executor as unknown as { denoAvailable: boolean | null }).denoAvailable = true;
    process.env.PATH = '/nonexistent-path-for-spawn-failure-test';

    try {
      const controller = new AbortController();
      const signal = controller.signal;

      // Count listeners before. There are no abort listeners on a fresh signal.
      const before = (signal as unknown as { listenerCount?: (event: string) => number })
        .listenerCount?.('abort') ?? 0;
      expect(before).toBe(0);

      const result = await executor.execute('return 1;', {
        timeoutMs: 5000,
        bridgeUrl: 'http://127.0.0.1:1',
        servers: [],
        signal,
      });

      // Spawn failed → runtime error, but the listener must have been removed.
      expect(result.success).toBe(false);
      const after = (signal as unknown as { listenerCount?: (event: string) => number })
        .listenerCount?.('abort') ?? 0;
      expect(after).toBe(0);
    } finally {
      process.env.PATH = savedPath;
      (executor as unknown as { denoAvailable: boolean | null }).denoAvailable = savedDeno;
    }
  });

  it('kills the Deno process when the signal aborts mid-execution', async () => {
    const controller = new AbortController();
    // Long-running code: sleep 30s then return.
    const longCode = `await new Promise(r => setTimeout(r, 30_000)); return 'done';`;

    // Fire abort after 200ms — well before the 30s script would complete.
    setTimeout(() => controller.abort(), 200);

    const start = Date.now();
    const result = await executor.execute(longCode, {
      timeoutMs: 60_000,
      bridgeUrl: 'http://127.0.0.1:1',
      servers: [],
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/cancel/i);
    // Should return promptly after abort, not wait for the 60s timeout.
    expect(elapsed).toBeLessThan(5000);
    // Process should be cleaned up from the active map.
    expect(executor.getActiveProcessCount()).toBe(0);
  }, 10_000);
});
