/**
 * Scale Benchmark Suite
 *
 * Verifies token-savings compression across four usage scales using the same
 * token formula as MetricsCollector in src/metrics/metrics-collector.ts.
 *
 * Each scenario:
 *  1. Computes passthrough tokens  = (toolCalls × 150) + (dataBytes / 1024 × 256)
 *  2. Computes execution tokens    = codeChars / 3.5  +  resultJson.length / 3.8
 *  3. Derives compression %        = (passthrough − execution) / passthrough × 100
 *  4. Runs 10 iterations via BenchmarkRunner (deterministic math → stable p50/p95/p99)
 *  5. Asserts compression ≥ 85% (the verified minimum across all fixture scales)
 */

import { describe, it, expect } from 'vitest';
import { createBenchmarkRunner, assertBenchmark } from './harness/index.js';
import {
  SCALE_FIXTURES,
  computeScenarioMetrics,
  type ScenarioFixture,
} from '../fixtures/scale-fixtures.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * BenchmarkFn wrapper: computes token-savings metrics from a fixture
 * and returns them in the shape expected by BenchmarkRunner.
 */
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Scale Benchmark Suite', () => {
  for (const scaleFixture of SCALE_FIXTURES) {
    describe(`${scaleFixture.label}`, () => {
      it('all scenarios achieve ≥ 85% token compression', async () => {
        const runner = createBenchmarkRunner().configure({
          name: `Scale: ${scaleFixture.label}`,
        });

        for (const scenario of scaleFixture.scenarios) {
          runner.add(
            {
              name: scenario.name,
              iterations: 10,
              warmupIterations: 2,
              tags: [scaleFixture.scale, ...scenario.servers],
            },
            makeBenchmarkFn(scenario)
          );
        }

        const suiteResult = await runner.run();

        expect(suiteResult.passedCount).toBe(scaleFixture.scenarios.length);
        expect(suiteResult.failedCount).toBe(0);

        for (const benchmarkResult of suiteResult.benchmarks) {
          const assertion = assertBenchmark(benchmarkResult, {
            minTokenSavings: 85,
          });
          expect(assertion.passed, `${benchmarkResult.name}: ${assertion.failures.join(', ')}`).toBe(
            true
          );
        }
      });

      for (const scenario of scaleFixture.scenarios) {
        it(`${scenario.name}: metrics match formula`, () => {
          const metrics = computeScenarioMetrics(scenario);

          // Tokens saved must be positive
          expect(metrics.tokensSaved).toBeGreaterThan(0);

          // Compression must be at least 85%
          expect(metrics.compressionPct).toBeGreaterThanOrEqual(85);

          // Execution mode should use far fewer tokens than passthrough
          expect(metrics.executionTokens).toBeLessThan(metrics.passthroughTokens);

          // Sonnet savings must be positive
          expect(metrics.sonnetSavingsUsd).toBeGreaterThan(0);
        });
      }
    });
  }

  it('compression scales with data volume', () => {
    // Higher data volumes → higher compression (execution overhead is fixed)
    const compressions = SCALE_FIXTURES.map((sf) => {
      const perScenario = sf.scenarios.map((s) => computeScenarioMetrics(s).compressionPct);
      return perScenario.reduce((a, b) => a + b, 0) / perScenario.length;
    });

    // Each scale tier should compress at least as well as the previous
    for (let i = 1; i < compressions.length; i++) {
      const prev = compressions[i - 1];
      const curr = compressions[i];
      expect(curr, `${SCALE_FIXTURES[i]?.label} should compress ≥ ${SCALE_FIXTURES[i - 1]?.label}`).toBeGreaterThanOrEqual(
        prev - 2 // allow ±2% tolerance
      );
    }
  });

  it('enterprise scale saves > 100K tokens per session', () => {
    const enterprise = SCALE_FIXTURES.find((sf) => sf.scale === 'enterprise');
    expect(enterprise).toBeDefined();

    for (const scenario of enterprise!.scenarios) {
      const metrics = computeScenarioMetrics(scenario);
      expect(metrics.tokensSaved).toBeGreaterThan(100_000);
    }
  });
});
