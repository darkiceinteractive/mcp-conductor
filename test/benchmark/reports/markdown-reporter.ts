/**
 * Markdown Reporter
 *
 * Generates Markdown reports from benchmark results.
 */

import type { BenchmarkSuiteResult, BenchmarkResult } from '../harness/benchmark-runner.js';
import type { JsonReport } from './json-reporter.js';

/**
 * Generate a Markdown report from benchmark suite results
 */
export function generateMarkdownReport(suiteResult: BenchmarkSuiteResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Benchmark Report: ${suiteResult.name}`);
  lines.push('');
  lines.push(`**Generated**: ${suiteResult.timestamp}`);
  lines.push(`**Total Duration**: ${(suiteResult.totalDurationMs / 1000).toFixed(2)}s`);
  lines.push(
    `**Results**: ${suiteResult.passedCount} passed, ${suiteResult.failedCount} failed`
  );
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Benchmarks | ${suiteResult.benchmarks.length} |`);
  lines.push(`| Passed | ${suiteResult.passedCount} |`);
  lines.push(`| Failed | ${suiteResult.failedCount} |`);
  lines.push(
    `| Average Duration | ${(suiteResult.benchmarks.reduce((a, b) => a + b.duration.mean, 0) / suiteResult.benchmarks.length).toFixed(0)}ms |`
  );

  const tokenSavingsValues = suiteResult.benchmarks
    .filter((b) => b.tokenSavings)
    .map((b) => b.tokenSavings!.mean);
  if (tokenSavingsValues.length > 0) {
    const avgSavings =
      tokenSavingsValues.reduce((a, b) => a + b, 0) / tokenSavingsValues.length;
    lines.push(`| Avg Token Savings | ${avgSavings.toFixed(1)}% |`);
  }
  lines.push('');

  // Detailed results
  lines.push('## Detailed Results');
  lines.push('');
  lines.push('| Benchmark | Status | Mean | Median | P95 | P99 | CV | Token Savings |');
  lines.push('|-----------|--------|------|--------|-----|-----|----|---------------|');

  for (const benchmark of suiteResult.benchmarks) {
    const status = benchmark.success ? '✅' : '❌';
    const tokenSavings = benchmark.tokenSavings
      ? `${benchmark.tokenSavings.mean.toFixed(1)}%`
      : '-';

    lines.push(
      `| ${benchmark.name} | ${status} | ${benchmark.duration.mean.toFixed(0)}ms | ${benchmark.duration.median.toFixed(0)}ms | ${benchmark.duration.p95.toFixed(0)}ms | ${benchmark.duration.p99.toFixed(0)}ms | ${(benchmark.duration.cv * 100).toFixed(1)}% | ${tokenSavings} |`
    );
  }
  lines.push('');

  // Failed benchmarks detail
  const failedBenchmarks = suiteResult.benchmarks.filter((b) => !b.success);
  if (failedBenchmarks.length > 0) {
    lines.push('## Failed Benchmarks');
    lines.push('');

    for (const benchmark of failedBenchmarks) {
      lines.push(`### ${benchmark.name}`);
      lines.push('');
      lines.push(`**Error**: ${benchmark.error || 'Unknown error'}`);
      lines.push('');
    }
  }

  // Tag breakdown
  const tagCounts = new Map<string, number>();
  for (const benchmark of suiteResult.benchmarks) {
    for (const tag of benchmark.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  if (tagCounts.size > 0) {
    lines.push('## Tags');
    lines.push('');
    lines.push('| Tag | Count |');
    lines.push('|-----|-------|');
    for (const [tag, count] of tagCounts) {
      lines.push(`| ${tag} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a Markdown report from JSON report
 */
export function generateMarkdownFromJson(report: JsonReport): string {
  const lines: string[] = [];

  // Header
  lines.push('# Benchmark Report');
  lines.push('');
  lines.push(`**Generated**: ${report.meta.generatedAt}`);
  lines.push(`**Platform**: ${report.meta.environment.platform}`);
  lines.push(`**Node Version**: ${report.meta.environment.nodeVersion}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Benchmarks | ${report.summary.totalBenchmarks} |`);
  lines.push(`| Passed | ${report.summary.passed} |`);
  lines.push(`| Failed | ${report.summary.failed} |`);
  lines.push(`| Total Duration | ${(report.summary.totalDurationMs / 1000).toFixed(2)}s |`);
  lines.push(`| Avg Duration | ${report.summary.averageDurationMs.toFixed(0)}ms |`);
  if (report.summary.averageTokenSavings !== null) {
    lines.push(`| Avg Token Savings | ${report.summary.averageTokenSavings.toFixed(1)}% |`);
  }
  lines.push('');

  // Results table
  lines.push('## Results');
  lines.push('');
  lines.push('| Benchmark | Status | Mean | Median | P95 | P99 | Savings |');
  lines.push('|-----------|--------|------|--------|-----|-----|---------|');

  for (const b of report.benchmarks) {
    const status = b.success ? '✅' : '❌';
    const savings = b.tokenSavings ? `${b.tokenSavings.mean.toFixed(1)}%` : '-';

    lines.push(
      `| ${b.name} | ${status} | ${b.duration.mean.toFixed(0)}ms | ${b.duration.median.toFixed(0)}ms | ${b.duration.p95.toFixed(0)}ms | ${b.duration.p99.toFixed(0)}ms | ${savings} |`
    );
  }
  lines.push('');

  // Comparisons if present
  if (report.comparisons && report.comparisons.length > 0) {
    lines.push('## Comparison vs Baseline');
    lines.push('');
    lines.push('| Benchmark | Change | Significant |');
    lines.push('|-----------|--------|-------------|');

    for (const c of report.comparisons) {
      if (c.vsBaseline) {
        const change = c.vsBaseline.percentFaster > 0 ? '🟢' : '🔴';
        const percent = `${c.vsBaseline.percentFaster > 0 ? '+' : ''}${c.vsBaseline.percentFaster.toFixed(1)}%`;
        const significant = c.vsBaseline.significantlyDifferent ? '⚠️' : '-';

        lines.push(`| ${c.name} | ${change} ${percent} | ${significant} |`);
      } else {
        lines.push(`| ${c.name} | - | - |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a compact Markdown summary
 */
export function generateCompactSummary(suiteResult: BenchmarkSuiteResult): string {
  const passed = suiteResult.passedCount;
  const total = suiteResult.benchmarks.length;
  const avgDuration =
    suiteResult.benchmarks.reduce((a, b) => a + b.duration.mean, 0) / total;

  const tokenSavingsValues = suiteResult.benchmarks
    .filter((b) => b.tokenSavings)
    .map((b) => b.tokenSavings!.mean);
  const avgSavings =
    tokenSavingsValues.length > 0
      ? tokenSavingsValues.reduce((a, b) => a + b, 0) / tokenSavingsValues.length
      : null;

  let summary = `**${suiteResult.name}**: ${passed}/${total} passed`;
  summary += ` | Avg: ${avgDuration.toFixed(0)}ms`;
  if (avgSavings !== null) {
    summary += ` | Savings: ${avgSavings.toFixed(1)}%`;
  }

  return summary;
}

/**
 * Generate benchmark comparison table
 */
export function generateComparisonTable(
  results: BenchmarkResult[],
  sortBy: 'duration' | 'savings' = 'duration'
): string {
  const sorted = [...results].sort((a, b) => {
    if (sortBy === 'duration') {
      return a.duration.mean - b.duration.mean;
    }
    const aSavings = a.tokenSavings?.mean || 0;
    const bSavings = b.tokenSavings?.mean || 0;
    return bSavings - aSavings;
  });

  const lines: string[] = [];
  lines.push('| Rank | Benchmark | Mean Duration | Token Savings | Relative |');
  lines.push('|------|-----------|---------------|---------------|----------|');

  const baseline = sorted[0].duration.mean;

  sorted.forEach((result, index) => {
    const rank = index + 1;
    const savings = result.tokenSavings ? `${result.tokenSavings.mean.toFixed(1)}%` : '-';
    const relative =
      index === 0 ? '1.00x' : `${(result.duration.mean / baseline).toFixed(2)}x`;

    lines.push(
      `| ${rank} | ${result.name} | ${result.duration.mean.toFixed(0)}ms | ${savings} | ${relative} |`
    );
  });

  return lines.join('\n');
}

/**
 * Generate ASCII bar chart for durations
 */
export function generateDurationChart(results: BenchmarkResult[], width: number = 40): string {
  const maxDuration = Math.max(...results.map((r) => r.duration.mean));
  const lines: string[] = [];

  lines.push('Duration Chart:');
  lines.push('');

  for (const result of results) {
    const barLength = Math.round((result.duration.mean / maxDuration) * width);
    const bar = '█'.repeat(barLength);
    const name = result.name.padEnd(20);
    const duration = `${result.duration.mean.toFixed(0)}ms`.padStart(8);

    lines.push(`${name} │${bar} ${duration}`);
  }

  return lines.join('\n');
}
