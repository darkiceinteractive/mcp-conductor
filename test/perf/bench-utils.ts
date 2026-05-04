/**
 * Shared utilities for the performance benchmark suite.
 *
 * Provides a minimal runBenchmark harness that:
 *   1. Runs warmupIterations of the target function (discarded).
 *   2. Runs iterations, recording wall-clock elapsed per run.
 *   3. Returns raw sample array + p50 / p99 percentile helpers.
 *
 * This lets perf tests serve dual roles:
 *   - As `vitest bench` entries they produce throughput numbers.
 *   - As `vitest run` entries (used by CI) they assert threshold constraints
 *     via the returned percentile values + expect().
 */

export interface BenchOptions {
  /** Number of warmup runs (results discarded). Default: 10. */
  warmupIterations?: number;
  /** Number of measured iterations. Default: 50. */
  iterations?: number;
}

export interface BenchResult {
  /** Raw sample timings in milliseconds. */
  samples: number[];
  /** Median latency (p50) in ms. */
  p50: number;
  /** 99th-percentile latency in ms. */
  p99: number;
  /** Minimum observed latency in ms. */
  min: number;
  /** Maximum observed latency in ms. */
  max: number;
}

/**
 * Compute the p-th percentile of a sorted array of numbers.
 * Uses nearest-rank method (rounds up).
 */
export function percentile(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, Math.min(idx, sortedSamples.length - 1))];
}

/**
 * Run a benchmark harness around an async function.
 *
 * @param fn          - The function under test. Must be async or return a Promise.
 * @param options     - Warmup + iteration counts.
 * @returns           - Percentile summary over the measured iterations.
 */
export async function runBenchmark(
  fn: () => Promise<unknown> | unknown,
  options: BenchOptions = {}
): Promise<BenchResult> {
  const { warmupIterations = 10, iterations = 50 } = options;

  // Warmup phase — let JIT settle, node module caches warm.
  for (let i = 0; i < warmupIterations; i++) {
    await fn();
  }

  // Measurement phase.
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);

  return {
    samples,
    p50: percentile(samples, 50),
    p99: percentile(samples, 99),
    min: samples[0],
    max: samples[samples.length - 1],
  };
}

/**
 * Emit benchmark results to stdout in a structured JSON format.
 * CI/CD and the docs-site pipeline can consume this output.
 * Each call writes one newline-delimited JSON entry so multiple bench
 * runs can be streamed and collected into the daily JSON artifact.
 */
export function emitBenchmarkResult(
  suiteName: string,
  result: BenchResult,
  threshold?: { p50?: number; p99?: number; max?: number }
): void {
  const entry = {
    suite: suiteName,
    timestamp: new Date().toISOString(),
    p50_ms: result.p50,
    p99_ms: result.p99,
    min_ms: result.min,
    max_ms: result.max,
    iterations: result.samples.length,
    threshold_p50_ms: threshold?.p50 ?? null,
    threshold_p99_ms: threshold?.p99 ?? null,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
