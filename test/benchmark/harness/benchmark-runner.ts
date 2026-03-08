/**
 * Benchmark Runner
 *
 * Orchestrates benchmark execution with statistical analysis and reporting.
 */

import { calculateStatistics, type StatisticalResult } from './statistics.js';

export interface BenchmarkConfig {
  /** Name of the benchmark */
  name: string;
  /** Number of warmup iterations */
  warmupIterations?: number;
  /** Number of measured iterations */
  iterations?: number;
  /** Timeout per iteration in ms */
  timeoutMs?: number;
  /** Tags for categorisation */
  tags?: string[];
}

export interface BenchmarkResult {
  name: string;
  iterations: number;
  duration: StatisticalResult;
  tokenSavings?: StatisticalResult;
  toolCalls: number;
  success: boolean;
  error?: string;
  tags: string[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkSuiteResult {
  name: string;
  benchmarks: BenchmarkResult[];
  totalDurationMs: number;
  passedCount: number;
  failedCount: number;
  timestamp: string;
}

export type BenchmarkFn = () => Promise<{
  tokenSavings?: number;
  toolCalls?: number;
  metadata?: Record<string, unknown>;
}>;

interface BenchmarkEntry {
  config: BenchmarkConfig;
  fn: BenchmarkFn;
}

const DEFAULT_CONFIG: Required<Omit<BenchmarkConfig, 'name' | 'tags'>> & { tags: string[] } = {
  warmupIterations: 2,
  iterations: 10,
  timeoutMs: 30000,
  tags: [],
};

/**
 * Benchmark Runner class for orchestrating benchmarks
 */
export class BenchmarkRunner {
  private benchmarks: BenchmarkEntry[] = [];
  private suiteConfig: {
    name: string;
    beforeAll?: () => Promise<void>;
    afterAll?: () => Promise<void>;
    beforeEach?: () => Promise<void>;
    afterEach?: () => Promise<void>;
  } = { name: 'Benchmark Suite' };

  /**
   * Configure the benchmark suite
   */
  configure(config: typeof this.suiteConfig): this {
    this.suiteConfig = { ...this.suiteConfig, ...config };
    return this;
  }

  /**
   * Add a benchmark to the suite
   */
  add(config: BenchmarkConfig, fn: BenchmarkFn): this {
    this.benchmarks.push({
      config: { ...DEFAULT_CONFIG, ...config },
      fn,
    });
    return this;
  }

  /**
   * Run all benchmarks in the suite
   */
  async run(): Promise<BenchmarkSuiteResult> {
    const startTime = Date.now();
    const results: BenchmarkResult[] = [];

    // Run beforeAll hook
    if (this.suiteConfig.beforeAll) {
      await this.suiteConfig.beforeAll();
    }

    try {
      for (const entry of this.benchmarks) {
        const result = await this.runBenchmark(entry);
        results.push(result);
      }
    } finally {
      // Run afterAll hook
      if (this.suiteConfig.afterAll) {
        await this.suiteConfig.afterAll();
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const passedCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    return {
      name: this.suiteConfig.name,
      benchmarks: results,
      totalDurationMs,
      passedCount,
      failedCount,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run a single benchmark
   */
  private async runBenchmark(entry: BenchmarkEntry): Promise<BenchmarkResult> {
    const { config, fn } = entry;
    const durations: number[] = [];
    const tokenSavings: number[] = [];
    let totalToolCalls = 0;
    let error: string | undefined;
    let metadata: Record<string, unknown> | undefined;

    try {
      // Warmup iterations
      for (let i = 0; i < (config.warmupIterations || DEFAULT_CONFIG.warmupIterations); i++) {
        if (this.suiteConfig.beforeEach) {
          await this.suiteConfig.beforeEach();
        }

        await this.runWithTimeout(fn, config.timeoutMs || DEFAULT_CONFIG.timeoutMs);

        if (this.suiteConfig.afterEach) {
          await this.suiteConfig.afterEach();
        }
      }

      // Measured iterations
      for (let i = 0; i < (config.iterations || DEFAULT_CONFIG.iterations); i++) {
        if (this.suiteConfig.beforeEach) {
          await this.suiteConfig.beforeEach();
        }

        const start = performance.now();
        const result = await this.runWithTimeout(fn, config.timeoutMs || DEFAULT_CONFIG.timeoutMs);
        const duration = performance.now() - start;

        durations.push(duration);

        if (result.tokenSavings !== undefined) {
          tokenSavings.push(result.tokenSavings);
        }

        if (result.toolCalls !== undefined) {
          totalToolCalls += result.toolCalls;
        }

        if (result.metadata) {
          metadata = result.metadata;
        }

        if (this.suiteConfig.afterEach) {
          await this.suiteConfig.afterEach();
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const iterations = config.iterations || DEFAULT_CONFIG.iterations;

    return {
      name: config.name,
      iterations,
      duration: calculateStatistics(durations),
      tokenSavings: tokenSavings.length > 0 ? calculateStatistics(tokenSavings) : undefined,
      toolCalls: Math.round(totalToolCalls / iterations),
      success: error === undefined && durations.length === iterations,
      error,
      tags: config.tags || [],
      timestamp: new Date().toISOString(),
      metadata,
    };
  }

  /**
   * Run function with timeout
   */
  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Reset the runner
   */
  reset(): this {
    this.benchmarks = [];
    return this;
  }
}

/**
 * Create a new benchmark runner
 */
export function createBenchmarkRunner(): BenchmarkRunner {
  return new BenchmarkRunner();
}

/**
 * Quick benchmark utility for single functions
 */
export async function benchmark(
  name: string,
  fn: BenchmarkFn,
  iterations: number = 10
): Promise<BenchmarkResult> {
  const runner = new BenchmarkRunner();
  runner.add({ name, iterations }, fn);
  const suite = await runner.run();
  return suite.benchmarks[0];
}

/**
 * Compare benchmarks and return winner
 */
export function compareBenchmarks(
  results: BenchmarkResult[]
): {
  fastest: BenchmarkResult;
  slowest: BenchmarkResult;
  comparison: Array<{
    name: string;
    relativeSpeed: number;
  }>;
} {
  if (results.length === 0) {
    throw new Error('No benchmark results to compare');
  }

  const sorted = [...results].sort((a, b) => a.duration.median - b.duration.median);
  const fastest = sorted[0];
  const slowest = sorted[sorted.length - 1];

  const comparison = results.map((r) => ({
    name: r.name,
    relativeSpeed: fastest.duration.median / r.duration.median,
  }));

  return { fastest, slowest, comparison };
}

/**
 * Assert benchmark meets performance criteria
 */
export function assertBenchmark(
  result: BenchmarkResult,
  criteria: {
    maxP95Ms?: number;
    maxP99Ms?: number;
    maxMeanMs?: number;
    minTokenSavings?: number;
    maxCv?: number;
  }
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  if (criteria.maxP95Ms !== undefined && result.duration.p95 > criteria.maxP95Ms) {
    failures.push(`P95 ${result.duration.p95.toFixed(0)}ms exceeds max ${criteria.maxP95Ms}ms`);
  }

  if (criteria.maxP99Ms !== undefined && result.duration.p99 > criteria.maxP99Ms) {
    failures.push(`P99 ${result.duration.p99.toFixed(0)}ms exceeds max ${criteria.maxP99Ms}ms`);
  }

  if (criteria.maxMeanMs !== undefined && result.duration.mean > criteria.maxMeanMs) {
    failures.push(`Mean ${result.duration.mean.toFixed(0)}ms exceeds max ${criteria.maxMeanMs}ms`);
  }

  if (
    criteria.minTokenSavings !== undefined &&
    result.tokenSavings &&
    result.tokenSavings.mean < criteria.minTokenSavings
  ) {
    failures.push(
      `Token savings ${result.tokenSavings.mean.toFixed(1)}% below min ${criteria.minTokenSavings}%`
    );
  }

  if (criteria.maxCv !== undefined && result.duration.cv > criteria.maxCv) {
    failures.push(`CV ${result.duration.cv.toFixed(2)} exceeds max ${criteria.maxCv}`);
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
