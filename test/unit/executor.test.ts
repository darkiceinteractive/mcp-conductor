import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { DenoExecutor } from '../../src/runtime/executor.js';
import type { SandboxConfig } from '../../src/config/schema.js';

describe('DenoExecutor', () => {
  let executor: DenoExecutor;
  let sandboxConfig: SandboxConfig;
  let denoAvailable: boolean;

  beforeAll(async () => {
    sandboxConfig = {
      maxMemoryMb: 512,
      allowedNetHosts: ['localhost'],
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
  });

  describe('checkDeno', () => {
    it('should check if Deno is available', async () => {
      const result = await executor.checkDeno();
      expect(typeof result).toBe('boolean');
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
