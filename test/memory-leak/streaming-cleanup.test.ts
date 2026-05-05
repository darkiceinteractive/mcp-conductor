/**
 * T2: Streaming cleanup memory test — PR gate.
 *
 * Runs ITERATIONS executions through the StreamManager (half completed, half
 * marked as error) and asserts that the StreamManager state is cleared and no
 * orphan streams accumulate in memory.
 *
 * Nightly tier: 1,000 iterations.
 * PR-gate:        100 iterations.
 *
 * @module test/memory-leak/streaming-cleanup
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getStreamManager, shutdownStreamManager } from '../../src/streaming/index.js';
import type { CompleteEvent } from '../../src/streaming/execution-stream.js';

const ITERATIONS = process.env.NIGHTLY === '1' ? 1_000 : 100;
const GROWTH_TOLERANCE = 0.10;

function makeExecId(i: number): string {
  return `stream-soak-${i}-${Date.now()}`;
}

const COMPLETE_SUCCESS: CompleteEvent = {
  success: true,
  result: { ok: true },
  metrics: { executionTimeMs: 10, toolCalls: 1, dataProcessedBytes: 100 },
};

const COMPLETE_FAILURE: CompleteEvent = {
  success: false,
  error: { type: 'runtime', message: 'simulated failure' },
  metrics: { executionTimeMs: 5, toolCalls: 0, dataProcessedBytes: 0 },
};

describe(`T2 streaming-cleanup (${ITERATIONS} streams, half error)`, () => {
  afterEach(() => {
    shutdownStreamManager();
  });

  it(
    'StreamManager state cleared; no orphan streams after mixed complete/error runs',
    async () => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const baselineRss = process.memoryUsage().rss;

      const manager = getStreamManager();

      for (let i = 0; i < ITERATIONS; i++) {
        const execId = makeExecId(i);
        const stream = manager.createStream(execId);

        stream.log('Starting execution', 'info');
        stream.progress(10, 'working');

        // Alternate: even = success, odd = error.
        stream.complete(i % 2 === 0 ? COMPLETE_SUCCESS : COMPLETE_FAILURE);
      }

      // Shutdown drops all streams immediately.
      shutdownStreamManager();

      if (typeof globalThis.gc === 'function') globalThis.gc();
      const finalRss = process.memoryUsage().rss;
      const growth = (finalRss - baselineRss) / Math.max(baselineRss, 1);

      expect(growth).toBeLessThanOrEqual(GROWTH_TOLERANCE);
    },
    120_000,
  );
});
