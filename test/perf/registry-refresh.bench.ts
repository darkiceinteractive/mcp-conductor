/**
 * Registry-refresh benchmark — T1 (STUB)
 *
 * Will measure a full registry refresh with 10 mock MCP servers each
 * exposing 100 tools.
 *
 * PRD §6.1 threshold: full refresh must complete in < 2s.
 *
 * Status: stubbed — requires the registry refresh API to be exposed on a
 * stable interface. Deferred to T1.b follow-up PR.
 *
 * All tests in this file are skipped.
 */

import { describe, test } from 'vitest';
import { runBenchmark } from './bench-utils.js';

// Placeholder function.
async function registryRefreshFn(): Promise<void> {
  // TODO(T1.b): wire against RegistryManager.refresh() with 10-server mock.
  await Promise.resolve();
}

describe.skip('registry-refresh (stub — T1.b)', () => {
  test.skip('registry refresh with 10 servers × 100 tools < 2s', async () => {
    const result = await runBenchmark(registryRefreshFn, {
      warmupIterations: 3,
      iterations: 10,
    });

    // Threshold: 2000ms.
    expect(result.p50).toBeLessThan(2000);
  });
});

void runBenchmark;
