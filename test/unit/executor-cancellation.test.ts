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
