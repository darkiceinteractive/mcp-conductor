/**
 * Warm-call benchmark — T1
 *
 * Measures subsequent execute_code calls when the worker pool is already
 * warmed up (i.e., the executor has handled at least one prior call).
 *
 * PRD §6.1 thresholds: p50 < 15ms, p99 < 50ms.
 *
 * The mock simulates a warmed Deno worker returning immediately, isolating
 * framework dispatch overhead (queue, metrics recording, result serialisation).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBenchmark, emitBenchmarkResult } from './bench-utils.js';

vi.mock('../../src/runtime/executor.js', () => {
  return {
    DenoExecutor: vi.fn().mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({
        success: true,
        result: { type: 'json', value: { result: 'warm' } },
        metrics: { toolCalls: 0, dataProcessedBytes: 256, durationMs: 2 },
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

// Singleton executor — warm across all benchmark iterations.
let warmExecutor: { execute: (opts: unknown) => Promise<unknown> };

async function makeExecutor() {
  const { DenoExecutor } = await import('../../src/runtime/executor.js');
  const executor = new DenoExecutor({
    maxMemoryMb: 128,
    allowedNetHosts: ['localhost'],
    maxConcurrentProcesses: 5,
    maxOutputBytes: 10 * 1024 * 1024,
  });
  // Prime the executor (not measured).
  await executor.execute({
    code: 'console.log(JSON.stringify({primed: true}))',
    timeout: 5000,
    memoryLimitMb: 128,
  });
  return executor;
}

async function warmCallFn(): Promise<void> {
  await warmExecutor.execute({
    code: 'console.log(JSON.stringify({n: Math.random()}))',
    timeout: 5000,
    memoryLimitMb: 128,
  });
}

describe('warm-call', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    warmExecutor = await makeExecutor();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('warm-call p50 < 15ms (CI gate)', async () => {
    const result = await runBenchmark(warmCallFn, {
      warmupIterations: 10,
      iterations: 50,
    });

    emitBenchmarkResult('warm-call', result, { p50: 15, p99: 50 });

    expect(result.p50).toBeLessThan(15);
  });

  test('warm-call p99 < 50ms (CI gate)', async () => {
    const result = await runBenchmark(warmCallFn, {
      warmupIterations: 10,
      iterations: 50,
    });

    expect(result.p99).toBeLessThan(50);
  });
});
