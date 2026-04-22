import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { DenoExecutor } from '../../src/runtime/executor.js';
import type { SandboxConfig } from '../../src/config/schema.js';

describe('DenoExecutor', () => {
  let executor: DenoExecutor;
  let sandboxConfig: SandboxConfig;
  let denoAvailable: boolean;

  beforeAll(async () => {
    sandboxConfig = {
      maxMemoryMb: 128,
      allowedNetHosts: ['localhost'],
      maxConcurrentProcesses: 5,
      maxOutputBytes: 10 * 1024 * 1024,
    };
    const tempExecutor = new DenoExecutor(sandboxConfig);
    denoAvailable = await tempExecutor.checkDeno();
  });

  beforeEach(() => {
    executor = new DenoExecutor(sandboxConfig);
  });

  describe('constructor', () => {
    it('should create executor with config', () => {
      expect(executor).toBeDefined();
    });

    it('should use default concurrency and output limits when not specified', () => {
      const minimalExecutor = new DenoExecutor({
        maxMemoryMb: 128,
        allowedNetHosts: ['localhost'],
      });
      expect(minimalExecutor).toBeDefined();
      expect(minimalExecutor.getActiveProcessCount()).toBe(0);
    });
  });

  describe('checkDeno', () => {
    it('should check if Deno is available', async () => {
      const result = await executor.checkDeno();
      expect(typeof result).toBe('boolean');
    });

    it('should cache the result on subsequent calls', async () => {
      const result1 = await executor.checkDeno();
      const result2 = await executor.checkDeno();
      expect(result1).toBe(result2);
    });

    it('should expose the private cache state so tests can reset it', async () => {
      await executor.checkDeno(); // Populate cache
      // Private field access via index — confirms the cache slot exists
      // and can be invalidated by the ENOENT spawn-error branch at runtime.
      const cached = (executor as unknown as { denoAvailable: boolean | null }).denoAvailable;
      expect(cached === true || cached === false).toBe(true);

      // Reset and re-probe
      (executor as unknown as { denoAvailable: boolean | null }).denoAvailable = null;
      const afterReset = await executor.checkDeno();
      expect(typeof afterReset).toBe('boolean');
    });
  });

  describe('process tracking', () => {
    it('should start with zero active processes', () => {
      expect(executor.getActiveProcessCount()).toBe(0);
    });

    it('should track active processes during execution', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      // Start a long-running execution
      const promise = executor.execute(
        'await new Promise(r => setTimeout(r, 2000)); return "done";',
        {
          timeoutMs: 5000,
          bridgeUrl: 'http://localhost:9847',
          servers: [],
        }
      );

      // Give it a moment to spawn
      await new Promise(r => setTimeout(r, 500));
      expect(executor.getActiveProcessCount()).toBeGreaterThanOrEqual(1);

      // Wait for completion
      const result = await promise;
      expect(result.success).toBe(true);
      expect(executor.getActiveProcessCount()).toBe(0);
    }, 10000);
  });

  describe('concurrency limit', () => {
    it('should reject when max concurrent processes reached', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const limitedExecutor = new DenoExecutor({
        maxMemoryMb: 128,
        allowedNetHosts: ['localhost'],
        maxConcurrentProcesses: 2,
      });

      // Start 2 long-running processes (the limit)
      const longCode = 'await new Promise(r => setTimeout(r, 3000)); return "done";';
      const opts = { timeoutMs: 5000, bridgeUrl: 'http://localhost:9847', servers: [] };

      const p1 = limitedExecutor.execute(longCode, opts);
      const p2 = limitedExecutor.execute(longCode, opts);

      // Give them time to spawn
      await new Promise(r => setTimeout(r, 500));

      // Third should be rejected
      const p3 = limitedExecutor.execute('return 42;', opts);
      const result3 = await p3;

      expect(result3.success).toBe(false);
      expect(result3.error?.message).toContain('Maximum concurrent executions');

      // Clean up
      await limitedExecutor.shutdown();
      await Promise.allSettled([p1, p2]);
    }, 15000);
  });

  describe('shutdown', () => {
    it('should kill all active processes', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      // Start a long-running process
      const promise = executor.execute(
        'await new Promise(r => setTimeout(r, 30000)); return "done";',
        {
          timeoutMs: 60000,
          bridgeUrl: 'http://localhost:9847',
          servers: [],
        }
      );

      // Give it time to spawn
      await new Promise(r => setTimeout(r, 500));
      expect(executor.getActiveProcessCount()).toBeGreaterThanOrEqual(1);

      // Shutdown should kill it
      await executor.shutdown();
      expect(executor.getActiveProcessCount()).toBe(0);

      // The execution promise should resolve (with error or not)
      await promise;
    }, 10000);

    it('should reject new executions after shutdown', async () => {
      await executor.shutdown();

      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('return 42;', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('shutting down');
    });

    it('should handle shutdown with no active processes', async () => {
      await executor.shutdown();
      // Should not throw
      expect(executor.getActiveProcessCount()).toBe(0);
    });
  });

  describe('execute (requires Deno)', () => {
    it('should execute simple return value', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('return 42;', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
    });

    it('should capture console logs', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('console.log("test"); return "done";', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(true);
      expect(result.logs).toContain('test');
      expect(result.result).toBe('done');
    });

    it('should handle syntax errors', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('const x = {;', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(false);
      expect(['syntax', 'runtime']).toContain(result.error?.type);
    });

    it('should handle runtime errors', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('throw new Error("test error");', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('runtime');
      expect(result.error?.message).toContain('test error');
    });

    it('should track execution metrics', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('return { value: 123 };', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.metrics).toBeDefined();
      expect(result.metrics.executionTimeMs).toBeGreaterThanOrEqual(0);
      if (result.success) {
        expect(result.metrics.resultSizeBytes).toBeGreaterThan(0);
      }
    });

    it('should handle async code', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute(
        'await new Promise(r => setTimeout(r, 100)); return "async done";',
        {
          timeoutMs: 5000,
          bridgeUrl: 'http://localhost:9847',
          servers: [],
        }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('async done');
    });

    it('should handle object returns', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute('return { name: "test", values: [1, 2, 3] };', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ name: 'test', values: [1, 2, 3] });
    });

    it('should not leak environment variables to Deno subprocess', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      // Try to read an env var that exists in the parent but shouldn't be passed
      const result = await executor.execute(
        'return { user: Deno.env.get("USER") ?? "not-set", shell: Deno.env.get("SHELL") ?? "not-set" };',
        {
          timeoutMs: 5000,
          bridgeUrl: 'http://localhost:9847',
          servers: [],
        }
      );

      // The sandbox should not have USER or SHELL env vars
      if (result.success && result.result) {
        const env = result.result as { user: string; shell: string };
        expect(env.user).toBe('not-set');
        expect(env.shell).toBe('not-set');
      }
    });
  });

  describe('timeout handling (requires Deno)', () => {
    it('should timeout long-running code', async () => {
      if (!denoAvailable) {
        console.log('Skipping test: Deno not available');
        return;
      }

      const result = await executor.execute(
        'while(true) {}', // Infinite loop
        {
          timeoutMs: 500, // Very short timeout
          bridgeUrl: 'http://localhost:9847',
          servers: [],
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('timeout');

      // Process should be cleaned up after timeout
      expect(executor.getActiveProcessCount()).toBe(0);
    }, 10000);
  });

  describe('error handling without Deno', () => {
    it('should return runtime error when Deno not found', async () => {
      // This test always runs - if Deno IS available, it will succeed
      // If Deno is NOT available, it verifies proper error handling
      const result = await executor.execute('return 42;', {
        timeoutMs: 5000,
        bridgeUrl: 'http://localhost:9847',
        servers: [],
      });

      if (result.success) {
        expect(result.result).toBe(42);
      } else {
        expect(result.error?.type).toBe('runtime');
        expect(result.error?.message).toContain('Deno');
      }
    });
  });
});
