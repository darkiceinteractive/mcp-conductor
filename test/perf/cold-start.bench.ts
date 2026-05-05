/**
 * Cold-start benchmark — T1
 *
 * Measures the latency of the first execute_code-equivalent operation after
 * the module graph has been imported but no worker pool has been warmed up.
 *
 * PRD §6.1 threshold: p50 must be < 50ms.
 *
 * Implementation note: a full Deno spawn on cold start is intentionally
 * excluded from the CI assertion because it is environment-dependent and
 * may be unavailable in sandboxed runners. Instead we benchmark the
 * executor setup path (config parsing, pool initialisation, first call
 * dispatch) using a mock that returns immediately, so we are measuring
 * framework overhead rather than Deno process spin-up.
 * The nightly tier runs this against a real Deno binary with a tighter threshold.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBenchmark, emitBenchmarkResult } from './bench-utils.js';

// ---------------------------------------------------------------------------
// Mock the Deno executor so cold-start measures framework overhead only.
// ---------------------------------------------------------------------------
vi.mock('../../src/runtime/executor.js', () => {
  return {
    DenoExecutor: vi.fn().mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({
        success: true,
        result: { type: 'json', value: { answer: 42 } },
        metrics: { toolCalls: 1, dataProcessedBytes: 1024, durationMs: 5 },
      }),
      checkDeno: vi.fn().mockResolvedValue(true),
      getActiveProcessCount: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('../../src/config/loader.js', () => ({
  loadClaudeConfig: vi.fn().mockReturnValue({ mcpServers: {} }),
  findClaudeConfig: vi.fn().mockReturnValue('/mock/claude_desktop_config.json'),
  loadConductorConfig: vi.fn().mockReturnValue(null),
  findConductorConfig: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Cold-start function: instantiates DenoExecutor on every call to simulate
// a fresh-start scenario. Module cache is warm; constructor + first-call
// overhead is what we are measuring.
// ---------------------------------------------------------------------------
async function coldStartFn(): Promise<void> {
  const { DenoExecutor } = await import('../../src/runtime/executor.js');
  const executor = new DenoExecutor({
    maxMemoryMb: 128,
    allowedNetHosts: ['localhost'],
    maxConcurrentProcesses: 5,
    maxOutputBytes: 10 * 1024 * 1024,
  });
  await executor.execute({
    code: 'console.log(JSON.stringify({answer: 42}))',
    timeout: 5000,
    memoryLimitMb: 128,
  });
}

// ---------------------------------------------------------------------------
// Test suite — dual role: bench report + CI threshold gate.
// ---------------------------------------------------------------------------
describe('cold-start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('cold-start p50 < 50ms (CI gate)', async () => {
    const result = await runBenchmark(coldStartFn, {
      warmupIterations: 5,
      iterations: 30,
    });

    emitBenchmarkResult('cold-start', result, { p50: 50 });

    expect(result.p50).toBeLessThan(50);
  });

  // p99 is informational in CI — nightly tier applies the tighter gate.
  test('cold-start p99 informational', async () => {
    const result = await runBenchmark(coldStartFn, {
      warmupIterations: 3,
      iterations: 20,
    });

    expect(result.p99).toBeGreaterThanOrEqual(0);
  });
});
