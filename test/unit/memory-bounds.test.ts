import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetricsCollector } from '../../src/metrics/metrics-collector.js';
import { ExecutionStream, StreamManager } from '../../src/streaming/execution-stream.js';
import { RateLimiter } from '../../src/utils/rate-limiter.js';
import { DenoExecutor } from '../../src/runtime/executor.js';
import type { SandboxConfig } from '../../src/config/schema.js';
import { LIFECYCLE_TIMEOUTS } from '../../src/config/defaults.js';

describe('Memory Bounds', () => {
  describe('MetricsCollector caps at maxStoredExecutions', () => {
    it('should cap stored executions at 100', () => {
      const collector = new MetricsCollector({ enabled: true, logToFile: false });

      // Record 200 executions
      for (let i = 0; i < 200; i++) {
        collector.recordExecution({
          executionId: `exec_${i}`,
          code: 'return 1',
          result: { value: i },
          success: true,
          durationMs: 100,
          toolCalls: 1,
          dataProcessedBytes: 1024,
          resultSizeBytes: 64,
          mode: 'execution',
        });
      }

      const recent = collector.getRecentExecutions(200);
      expect(recent.length).toBeLessThanOrEqual(100);
    });
  });

  describe('ExecutionStream caps logs at 500', () => {
    it('should keep at most 500 log entries', () => {
      const stream = new ExecutionStream('test-stream');

      // Push 1000 log messages
      for (let i = 0; i < 1000; i++) {
        stream.log(`Log message ${i}`);
      }

      const state = stream.getState();
      expect(state.logs.length).toBeLessThanOrEqual(500);
      // Should keep the most recent logs
      expect(state.logs[state.logs.length - 1]).toBe('Log message 999');
    });

    it('should clear logs on completion', () => {
      const stream = new ExecutionStream('test-stream-complete');

      for (let i = 0; i < 100; i++) {
        stream.log(`Log message ${i}`);
      }

      stream.complete({
        success: true,
        metrics: { executionTimeMs: 100, toolCalls: 0, dataProcessedBytes: 0 },
      });

      const state = stream.getState();
      expect(state.logs.length).toBe(0);
    });
  });

  describe('StreamManager force-cleans old streams', () => {
    let manager: StreamManager;

    beforeEach(() => {
      manager = new StreamManager();
    });

    afterEach(() => {
      manager.shutdown();
    });

    it('should report correct stream count', () => {
      manager.createStream('stream-1');
      manager.createStream('stream-2');
      expect(manager.getStreamCount()).toBe(2);
    });

    it('should clean up streams on shutdown', () => {
      manager.createStream('stream-1');
      manager.createStream('stream-2');
      manager.shutdown();
      expect(manager.getStreamCount()).toBe(0);
    });
  });

  describe('RateLimiter rejects when queue full', () => {
    let limiter: RateLimiter;

    afterEach(() => {
      limiter?.destroy();
    });

    it('should reject when queue exceeds 100 pending requests', async () => {
      // Very slow rate limiter: 0.01 req/s so tokens never refill during test
      limiter = new RateLimiter(
        { requestsPerSecond: 0.01, burstSize: 1, onLimitExceeded: 'queue', maxQueueTimeMs: 60000 },
        'test-server'
      );

      // First call consumes the single burst token
      await limiter.acquire();

      // Queue up 100 requests (they'll all wait)
      const pendingPromises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        pendingPromises.push(limiter.acquire());
      }

      // The 101st should be rejected with queue full
      await expect(limiter.acquire()).rejects.toThrow(/queue full/i);

      // Clean up: destroy rejects all pending
      limiter.destroy();

      // Wait for all pending to settle (they'll reject from destroy)
      await Promise.allSettled(pendingPromises);
    });
  });

  describe('DenoExecutor cleanup', () => {
    it('should have zero active processes initially', () => {
      const config: SandboxConfig = {
        maxMemoryMb: 128,
        allowedNetHosts: ['localhost'],
        maxConcurrentProcesses: 5,
        maxOutputBytes: 10 * 1024 * 1024,
      };
      const executor = new DenoExecutor(config);
      expect(executor.getActiveProcessCount()).toBe(0);
    });
  });

  describe('StreamManager TTL-based force cleanup', () => {
    let manager: StreamManager;

    beforeEach(() => {
      vi.useFakeTimers();
      manager = new StreamManager();
    });

    afterEach(() => {
      manager.shutdown();
      vi.useRealTimers();
    });

    it('should force-remove completed streams older than STREAM_COMPLETED_TTL_MS even with connections', () => {
      const stream = manager.createStream('old-completed');
      stream.complete({
        success: true,
        metrics: { executionTimeMs: 1, toolCalls: 0, dataProcessedBytes: 0 },
      });

      // Back-date the lastUpdate so cleanup picks it up.
      const state = stream.getState();
      const backdated = new Date(Date.now() - LIFECYCLE_TIMEOUTS.STREAM_COMPLETED_TTL_MS - 1000);
      Object.assign(stream.getState(), { lastUpdate: backdated });
      // `getState` returns a copy, so mutate via the private field directly:
      (stream as unknown as { state: { lastUpdate: Date } }).state.lastUpdate = backdated;

      expect(state.id).toBe('old-completed');
      expect(manager.getStreamCount()).toBe(1);

      // Advance past one cleanup interval tick
      vi.advanceTimersByTime(LIFECYCLE_TIMEOUTS.STREAM_CLEANUP_INTERVAL_MS + 100);
      expect(manager.getStreamCount()).toBe(0);
    });

    it('should remove stuck running streams older than STREAM_STUCK_TTL_MS', () => {
      const stream = manager.createStream('stuck-running');
      // Leave status as 'running' and back-date beyond the stuck TTL.
      const backdated = new Date(Date.now() - LIFECYCLE_TIMEOUTS.STREAM_STUCK_TTL_MS - 1000);
      (stream as unknown as { state: { lastUpdate: Date } }).state.lastUpdate = backdated;

      expect(manager.getStreamCount()).toBe(1);

      vi.advanceTimersByTime(LIFECYCLE_TIMEOUTS.STREAM_CLEANUP_INTERVAL_MS + 100);
      expect(manager.getStreamCount()).toBe(0);
    });

    it('should NOT remove recently-updated running streams', () => {
      manager.createStream('fresh-running');
      expect(manager.getStreamCount()).toBe(1);

      // Advance only one cleanup tick; stream is far younger than STUCK_TTL.
      vi.advanceTimersByTime(LIFECYCLE_TIMEOUTS.STREAM_CLEANUP_INTERVAL_MS + 100);
      expect(manager.getStreamCount()).toBe(1);
    });
  });
});
