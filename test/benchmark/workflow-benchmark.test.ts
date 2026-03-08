/**
 * Workflow Benchmark Suite
 *
 * Verifies token-savings compression across 7 developer workflow categories,
 * each with quick and deep variants (14 scenarios total).
 *
 * Uses the same harness and token formula as scale-benchmark.test.ts.
 * Asserts ≥ 85% compression per scenario and > 90% average across all scenarios.
 */

import { describe, it, expect } from 'vitest';
import { createBenchmarkRunner, assertBenchmark } from './harness/index.js';
import {
  WORKFLOW_FIXTURES,
  type WorkflowFixture,
} from '../fixtures/workflow-fixtures.js';
import {
  computeScenarioMetrics,
  type ScenarioFixture,
} from '../fixtures/scale-fixtures.js';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeBenchmarkFn(scenario: ScenarioFixture) {
  return async () => {
    const metrics = computeScenarioMetrics(scenario);
    return {
      tokenSavings: metrics.compressionPct,
      toolCalls: scenario.toolCalls,
      metadata: {
        passthroughTokens: metrics.passthroughTokens,
        executionTokens: metrics.executionTokens,
        tokensSaved: metrics.tokensSaved,
        compressionPct: parseFloat(metrics.compressionPct.toFixed(2)),
        dataKb: Math.round(scenario.dataBytes / 1024),
        sonnetSavingsUsd: parseFloat(metrics.sonnetSavingsUsd.toFixed(4)),
        servers: scenario.servers,
      },
    };
  };
}

// ─── Per-workflow tests ────────────────────────────────────────────────────────

describe('Workflow Benchmark Suite', () => {
  for (const workflowFixture of WORKFLOW_FIXTURES) {
    describe(workflowFixture.label, () => {
      it('quick variant achieves ≥ 85% token compression', async () => {
        const scenario = workflowFixture.quick;
        const runner = createBenchmarkRunner().configure({
          name: `Workflow: ${workflowFixture.label} — quick`,
        });

        runner.add(
          {
            name: scenario.name,
            iterations: 10,
            warmupIterations: 2,
            tags: [workflowFixture.category, 'quick', ...scenario.servers],
          },
          makeBenchmarkFn(scenario)
        );

        const suiteResult = await runner.run();
        expect(suiteResult.failedCount).toBe(0);

        const [benchmarkResult] = suiteResult.benchmarks;
        const assertion = assertBenchmark(benchmarkResult!, { minTokenSavings: 85 });
        expect(
          assertion.passed,
          `${benchmarkResult!.name}: ${assertion.failures.join(', ')}`
        ).toBe(true);
      });

      it('deep variant achieves ≥ 85% token compression', async () => {
        const scenario = workflowFixture.deep;
        const runner = createBenchmarkRunner().configure({
          name: `Workflow: ${workflowFixture.label} — deep`,
        });

        runner.add(
          {
            name: scenario.name,
            iterations: 10,
            warmupIterations: 2,
            tags: [workflowFixture.category, 'deep', ...scenario.servers],
          },
          makeBenchmarkFn(scenario)
        );

        const suiteResult = await runner.run();
        expect(suiteResult.failedCount).toBe(0);

        const [benchmarkResult] = suiteResult.benchmarks;
        const assertion = assertBenchmark(benchmarkResult!, { minTokenSavings: 85 });
        expect(
          assertion.passed,
          `${benchmarkResult!.name}: ${assertion.failures.join(', ')}`
        ).toBe(true);
      });

      it('quick and deep: metrics satisfy formula invariants', () => {
        for (const [variant, scenario] of [
          ['quick', workflowFixture.quick],
          ['deep', workflowFixture.deep],
        ] as const) {
          const metrics = computeScenarioMetrics(scenario);

          expect(
            metrics.tokensSaved,
            `${workflowFixture.category} ${variant}: tokensSaved must be positive`
          ).toBeGreaterThan(0);

          expect(
            metrics.compressionPct,
            `${workflowFixture.category} ${variant}: compression must be ≥ 85%`
          ).toBeGreaterThanOrEqual(85);

          expect(
            metrics.executionTokens,
            `${workflowFixture.category} ${variant}: execution must be < passthrough`
          ).toBeLessThan(metrics.passthroughTokens);

          expect(
            metrics.sonnetSavingsUsd,
            `${workflowFixture.category} ${variant}: Sonnet savings must be positive`
          ).toBeGreaterThan(0);
        }
      });
    });
  }

  // ─── Cross-scenario assertions ───────────────────────────────────────────

  it('all 14 workflow scenarios beat the scale-benchmark floor (≥ 85%)', () => {
    const SCALE_BENCHMARK_FLOOR = 85;
    for (const wf of WORKFLOW_FIXTURES) {
      for (const [variant, scenario] of [
        ['quick', wf.quick],
        ['deep', wf.deep],
      ] as const) {
        const { compressionPct } = computeScenarioMetrics(scenario);
        expect(
          compressionPct,
          `${wf.category} ${variant}: ${compressionPct.toFixed(1)}% < floor ${SCALE_BENCHMARK_FLOOR}%`
        ).toBeGreaterThanOrEqual(SCALE_BENCHMARK_FLOOR);
      }
    }
  });

  it('all categories show > 90% average compression (quick + deep combined)', () => {
    for (const wf of WORKFLOW_FIXTURES) {
      const quickPct = computeScenarioMetrics(wf.quick).compressionPct;
      const deepPct = computeScenarioMetrics(wf.deep).compressionPct;
      const avg = (quickPct + deepPct) / 2;
      expect(
        avg,
        `${wf.label}: avg compression ${avg.toFixed(1)}% should exceed 90%`
      ).toBeGreaterThan(90);
    }
  });

  it('deep variant always compresses ≥ quick variant within each category', () => {
    // Deeper data volumes → higher compression (execution overhead is fixed)
    for (const wf of WORKFLOW_FIXTURES) {
      const quickPct = computeScenarioMetrics(wf.quick).compressionPct;
      const deepPct = computeScenarioMetrics(wf.deep).compressionPct;
      expect(
        deepPct,
        `${wf.label}: deep (${deepPct.toFixed(1)}%) should compress ≥ quick (${quickPct.toFixed(1)}%)`
      ).toBeGreaterThanOrEqual(quickPct - 1); // ±1% tolerance
    }
  });

  it('overall average compression across all 14 scenarios exceeds 95%', () => {
    const allCompressions = WORKFLOW_FIXTURES.flatMap((wf) => [
      computeScenarioMetrics(wf.quick).compressionPct,
      computeScenarioMetrics(wf.deep).compressionPct,
    ]);
    const overall = allCompressions.reduce((a, b) => a + b, 0) / allCompressions.length;
    expect(overall).toBeGreaterThan(95);
  });

  it('research-synthesis quick (lowest data volume) still achieves ≥ 90% compression', () => {
    // research-synthesis-quick uses only 8 KB / 3 tool calls — the tightest case
    const rs = WORKFLOW_FIXTURES.find((wf) => wf.category === 'research-synthesis')!;
    const { compressionPct } = computeScenarioMetrics(rs.quick);
    expect(compressionPct).toBeGreaterThanOrEqual(90);
  });

  it('project-context-load deep saves the most tokens of any single workflow', () => {
    // 13 calls × 75 KB is the largest workflow fixture — should have the highest absolute savings
    const pc = WORKFLOW_FIXTURES.find((wf) => wf.category === 'project-context-load')!;
    const pcMetrics = computeScenarioMetrics(pc.deep);

    for (const wf of WORKFLOW_FIXTURES) {
      if (wf.category === 'project-context-load') continue;
      const { tokensSaved } = computeScenarioMetrics(wf.deep);
      expect(
        pcMetrics.tokensSaved,
        `project-context-load-deep should save more tokens than ${wf.category}-deep`
      ).toBeGreaterThanOrEqual(tokensSaved);
    }
  });

  it('all workflow compression values form a summary table (spot-check)', () => {
    // Produce a concise summary for debugging; assert it is non-empty
    const rows = WORKFLOW_FIXTURES.map((wf) => {
      const q = computeScenarioMetrics(wf.quick);
      const d = computeScenarioMetrics(wf.deep);
      return {
        category: wf.category,
        quickPct: parseFloat(q.compressionPct.toFixed(1)),
        deepPct: parseFloat(d.compressionPct.toFixed(1)),
        avgPct: parseFloat(((q.compressionPct + d.compressionPct) / 2).toFixed(1)),
        deepTokensSaved: d.tokensSaved,
        deepSonnetUsd: parseFloat(d.sonnetSavingsUsd.toFixed(4)),
      };
    });

    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.quickPct >= 85 && r.deepPct >= 85)).toBe(true);
  });
});
