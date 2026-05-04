/**
 * Bridge-throughput benchmark — T1 (STUB)
 *
 * Will measure sustained concurrent calls/sec through the HTTP bridge over
 * a 60-second window.
 *
 * PRD §6.1 threshold: >= 80 calls/sec sustained.
 *
 * Status: stubbed — requires the HTTP bridge to be bound to a test port and
 * a concurrent-caller harness. Deferred to T1.b follow-up PR.
 *
 * All tests in this file are skipped.
 */

import { describe, test } from 'vitest';
import { runBenchmark } from './bench-utils.js';

// Placeholder function.
async function bridgeThroughputFn(): Promise<void> {
  // TODO(T1.b): wire against real HTTP bridge listener on a random port.
  await Promise.resolve();
}

describe.skip('bridge-throughput (stub — T1.b)', () => {
  test.skip('bridge sustains >= 80 calls/sec over 60s', async () => {
    const durationMs = 60_000;
    const start = performance.now();
    let callCount = 0;
    while (performance.now() - start < durationMs) {
      await bridgeThroughputFn();
      callCount++;
    }
    const elapsed = (performance.now() - start) / 1000;
    const callsPerSec = callCount / elapsed;

    expect(callsPerSec).toBeGreaterThanOrEqual(80);
  });
});

void runBenchmark;
