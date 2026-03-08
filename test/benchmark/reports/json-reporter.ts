/**
 * JSON Reporter
 *
 * Generates JSON reports from benchmark results.
 */

import type { BenchmarkSuiteResult, BenchmarkResult } from '../harness/benchmark-runner.js';
import type { StatisticalResult } from '../harness/statistics.js';

export interface JsonReport {
  meta: {
    version: string;
    generatedAt: string;
    environment: {
      platform: string;
      nodeVersion: string;
      arch: string;
    };
  };
  summary: {
    totalBenchmarks: number;
    passed: number;
    failed: number;
    totalDurationMs: number;
    averageDurationMs: number;
    averageTokenSavings: number | null;
  };
  benchmarks: Array<{
    name: string;
    success: boolean;
    iterations: number;
    tags: string[];
    duration: StatisticalResult;
    tokenSavings: StatisticalResult | null;
    toolCalls: number;
    error: string | null;
    metadata: Record<string, unknown> | null;
  }>;
  comparisons?: Array<{
    name: string;
    vsBaseline: {
      percentFaster: number;
      significantlyDifferent: boolean;
    } | null;
  }>;
}

/**
 * Generate a JSON report from benchmark suite results
 */
export function generateJsonReport(
  suiteResult: BenchmarkSuiteResult,
  baselineResults?: BenchmarkResult[]
): JsonReport {
  const tokenSavingsValues = suiteResult.benchmarks
    .filter((b) => b.tokenSavings)
    .map((b) => b.tokenSavings!.mean);

  const averageTokenSavings =
    tokenSavingsValues.length > 0
      ? tokenSavingsValues.reduce((a, b) => a + b, 0) / tokenSavingsValues.length
      : null;

  const averageDurationMs =
    suiteResult.benchmarks.length > 0
      ? suiteResult.benchmarks.reduce((a, b) => a + b.duration.mean, 0) /
        suiteResult.benchmarks.length
      : 0;

  const report: JsonReport = {
    meta: {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        arch: process.arch,
      },
    },
    summary: {
      totalBenchmarks: suiteResult.benchmarks.length,
      passed: suiteResult.passedCount,
      failed: suiteResult.failedCount,
      totalDurationMs: suiteResult.totalDurationMs,
      averageDurationMs,
      averageTokenSavings,
    },
    benchmarks: suiteResult.benchmarks.map((b) => ({
      name: b.name,
      success: b.success,
      iterations: b.iterations,
      tags: b.tags,
      duration: b.duration,
      tokenSavings: b.tokenSavings || null,
      toolCalls: b.toolCalls,
      error: b.error || null,
      metadata: b.metadata || null,
    })),
  };

  // Add comparisons if baseline provided
  if (baselineResults) {
    report.comparisons = suiteResult.benchmarks.map((current) => {
      const baseline = baselineResults.find((b) => b.name === current.name);

      if (!baseline) {
        return {
          name: current.name,
          vsBaseline: null,
        };
      }

      const percentFaster =
        ((baseline.duration.mean - current.duration.mean) / baseline.duration.mean) * 100;
      const significantlyDifferent = Math.abs(percentFaster) > 10;

      return {
        name: current.name,
        vsBaseline: {
          percentFaster,
          significantlyDifferent,
        },
      };
    });
  }

  return report;
}

/**
 * Parse JSON report back into structured format
 */
export function parseJsonReport(json: string): JsonReport {
  return JSON.parse(json) as JsonReport;
}

/**
 * Merge multiple JSON reports into a summary
 */
export function mergeJsonReports(reports: JsonReport[]): JsonReport {
  if (reports.length === 0) {
    throw new Error('No reports to merge');
  }

  const allBenchmarks = reports.flatMap((r) => r.benchmarks);
  const totalDurationMs = reports.reduce((a, r) => a + r.summary.totalDurationMs, 0);

  const tokenSavingsValues = allBenchmarks
    .filter((b) => b.tokenSavings)
    .map((b) => b.tokenSavings!.mean);

  const averageTokenSavings =
    tokenSavingsValues.length > 0
      ? tokenSavingsValues.reduce((a, b) => a + b, 0) / tokenSavingsValues.length
      : null;

  return {
    meta: {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      environment: reports[0].meta.environment,
    },
    summary: {
      totalBenchmarks: allBenchmarks.length,
      passed: allBenchmarks.filter((b) => b.success).length,
      failed: allBenchmarks.filter((b) => !b.success).length,
      totalDurationMs,
      averageDurationMs:
        allBenchmarks.length > 0
          ? allBenchmarks.reduce((a, b) => a + b.duration.mean, 0) / allBenchmarks.length
          : 0,
      averageTokenSavings,
    },
    benchmarks: allBenchmarks,
  };
}

/**
 * Calculate regression from baseline report
 */
export function calculateRegression(
  current: JsonReport,
  baseline: JsonReport,
  thresholdPercent: number = 10
): Array<{
  name: string;
  regression: boolean;
  percentChange: number;
  currentMs: number;
  baselineMs: number;
}> {
  const results: Array<{
    name: string;
    regression: boolean;
    percentChange: number;
    currentMs: number;
    baselineMs: number;
  }> = [];

  for (const currentBench of current.benchmarks) {
    const baselineBench = baseline.benchmarks.find((b) => b.name === currentBench.name);

    if (!baselineBench) {
      continue;
    }

    const percentChange =
      ((currentBench.duration.mean - baselineBench.duration.mean) / baselineBench.duration.mean) *
      100;

    results.push({
      name: currentBench.name,
      regression: percentChange > thresholdPercent,
      percentChange,
      currentMs: currentBench.duration.mean,
      baselineMs: baselineBench.duration.mean,
    });
  }

  return results;
}
