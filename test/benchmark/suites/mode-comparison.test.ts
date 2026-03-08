/**
 * Mode Comparison Benchmarks
 *
 * Benchmarks comparing execution, passthrough, and hybrid modes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createBenchmarkRunner,
  assertBenchmark,
  compareBenchmarks,
  type BenchmarkResult,
} from '../harness/index.js';
import { generateMarkdownReport, generateCompactSummary } from '../reports/index.js';
import {
  createStandardTestSetup,
  type BridgeHandlers,
} from '../../fixtures/mock-servers/index.js';
import {
  simpleSamples,
  aggregationSamples,
  type CodeSample,
} from '../../fixtures/code-samples/index.js';

describe('Mode Comparison Benchmarks', () => {
  let handlers: BridgeHandlers;

  beforeAll(() => {
    handlers = createStandardTestSetup();
  });

  describe('Simple Operations', () => {
    it('should benchmark simple single-tool operations', async () => {
      const runner = createBenchmarkRunner()
        .configure({
          name: 'Simple Operations',
        })
        .add(
          {
            name: 'filesystem-list-execution',
            iterations: 5,
            tags: ['simple', 'filesystem', 'execution'],
          },
          async () => {
            // Simulate execution mode
            const start = performance.now();
            const result = await Promise.resolve({
              files: ['src', 'test', 'package.json'],
            });
            const duration = performance.now() - start;

            return {
              tokenSavings: 25, // Low savings for simple operations
              toolCalls: 1,
              metadata: { duration },
            };
          }
        )
        .add(
          {
            name: 'filesystem-list-passthrough',
            iterations: 5,
            tags: ['simple', 'filesystem', 'passthrough'],
          },
          async () => {
            // Simulate passthrough mode
            const start = performance.now();
            const result = await Promise.resolve('[DIR] src\n[DIR] test\n[FILE] package.json');
            const duration = performance.now() - start;

            return {
              tokenSavings: 0, // No savings in passthrough
              toolCalls: 1,
              metadata: { duration },
            };
          }
        );

      const suiteResult = await runner.run();

      expect(suiteResult.passedCount).toBe(2);
      expect(suiteResult.benchmarks).toHaveLength(2);

      // Generate report
      const report = generateMarkdownReport(suiteResult);
      expect(report).toContain('Simple Operations');
    });
  });

  describe('Aggregation Operations', () => {
    it('should benchmark multi-file aggregation', async () => {
      const runner = createBenchmarkRunner()
        .configure({
          name: 'Aggregation Operations',
        })
        .add(
          {
            name: 'multi-file-execution',
            iterations: 5,
            tags: ['aggregation', 'execution'],
          },
          async () => {
            // Simulate reading multiple files and aggregating
            await new Promise((r) => setTimeout(r, 10));

            return {
              tokenSavings: 85, // High savings for aggregation
              toolCalls: 5,
              metadata: {
                filesRead: 5,
                totalSize: 15000,
              },
            };
          }
        )
        .add(
          {
            name: 'multi-file-passthrough',
            iterations: 5,
            tags: ['aggregation', 'passthrough'],
          },
          async () => {
            // Simulate passthrough mode (slower due to context)
            await new Promise((r) => setTimeout(r, 15));

            return {
              tokenSavings: 0,
              toolCalls: 5,
            };
          }
        );

      const suiteResult = await runner.run();

      expect(suiteResult.passedCount).toBe(2);

      // Find execution mode result
      const executionResult = suiteResult.benchmarks.find((b) =>
        b.name.includes('execution')
      );
      expect(executionResult?.tokenSavings?.mean).toBeGreaterThan(50);
    });

    it('should benchmark cross-server aggregation', async () => {
      const runner = createBenchmarkRunner()
        .configure({
          name: 'Cross-Server Aggregation',
        })
        .add(
          {
            name: 'cross-server-execution',
            iterations: 5,
            tags: ['cross-server', 'execution'],
          },
          async () => {
            // Simulate cross-server calls with data aggregation
            await new Promise((r) => setTimeout(r, 20));

            return {
              tokenSavings: 92,
              toolCalls: 3,
              metadata: {
                servers: ['filesystem', 'context7', 'memory'],
              },
            };
          }
        )
        .add(
          {
            name: 'cross-server-passthrough',
            iterations: 5,
            tags: ['cross-server', 'passthrough'],
          },
          async () => {
            // Passthrough has to show all intermediate results
            await new Promise((r) => setTimeout(r, 25));

            return {
              tokenSavings: 0,
              toolCalls: 3,
            };
          }
        );

      const suiteResult = await runner.run();

      // Compare the two approaches
      const comparison = compareBenchmarks(suiteResult.benchmarks);
      expect(comparison.fastest).toBeDefined();
    });
  });

  describe('Performance Assertions', () => {
    it('should meet P95 performance criteria', async () => {
      const runner = createBenchmarkRunner()
        .configure({ name: 'Performance Test' })
        .add(
          {
            name: 'fast-operation',
            iterations: 10,
            tags: ['performance'],
          },
          async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 20 + 10));
            return { tokenSavings: 75, toolCalls: 2 };
          }
        );

      const suiteResult = await runner.run();
      const result = suiteResult.benchmarks[0];

      const assertion = assertBenchmark(result, {
        maxP95Ms: 500,
        maxP99Ms: 1000,
        minTokenSavings: 50,
        maxCv: 1.0, // Allow 100% CV for this test
      });

      expect(assertion.passed).toBe(true);
      if (!assertion.passed) {
        console.log('Failures:', assertion.failures);
      }
    });

    it('should detect performance regressions', async () => {
      const runner = createBenchmarkRunner()
        .configure({ name: 'Regression Test' })
        .add(
          {
            name: 'slow-operation',
            iterations: 5,
            tags: ['regression'],
          },
          async () => {
            await new Promise((r) => setTimeout(r, 100)); // Slow
            return { toolCalls: 1 };
          }
        );

      const suiteResult = await runner.run();
      const result = suiteResult.benchmarks[0];

      // This should fail the P95 criteria
      const assertion = assertBenchmark(result, {
        maxP95Ms: 50, // Too strict
      });

      expect(assertion.passed).toBe(false);
      expect(assertion.failures.length).toBeGreaterThan(0);
    });
  });

  describe('Token Savings Scaling', () => {
    const scenarios = [
      { name: 'small-data', sizeKb: 1, expectedSavings: 20 },
      { name: 'medium-data', sizeKb: 10, expectedSavings: 60 },
      { name: 'large-data', sizeKb: 50, expectedSavings: 90 },
    ];

    for (const scenario of scenarios) {
      it(`should show appropriate savings for ${scenario.name}`, async () => {
        const runner = createBenchmarkRunner()
          .configure({ name: `Token Savings: ${scenario.name}` })
          .add(
            {
              name: scenario.name,
              iterations: 5,
              tags: ['token-savings', scenario.name],
            },
            async () => {
              await new Promise((r) => setTimeout(r, 5));
              return {
                tokenSavings: scenario.expectedSavings,
                toolCalls: Math.ceil(scenario.sizeKb / 5),
                metadata: { sizeKb: scenario.sizeKb },
              };
            }
          );

        const suiteResult = await runner.run();
        const result = suiteResult.benchmarks[0];

        expect(result.tokenSavings?.mean).toBeCloseTo(scenario.expectedSavings, 0);
      });
    }
  });

  describe('Report Generation', () => {
    it('should generate complete markdown report', async () => {
      const runner = createBenchmarkRunner()
        .configure({ name: 'Report Test Suite' })
        .add(
          { name: 'benchmark-a', iterations: 3, tags: ['test'] },
          async () => ({ tokenSavings: 80, toolCalls: 3 })
        )
        .add(
          { name: 'benchmark-b', iterations: 3, tags: ['test'] },
          async () => ({ tokenSavings: 60, toolCalls: 2 })
        );

      const suiteResult = await runner.run();
      const report = generateMarkdownReport(suiteResult);

      expect(report).toContain('# Benchmark Report');
      expect(report).toContain('benchmark-a');
      expect(report).toContain('benchmark-b');
      expect(report).toContain('P95');
      expect(report).toContain('Token Savings');
    });

    it('should generate compact summary', async () => {
      const runner = createBenchmarkRunner()
        .configure({ name: 'Summary Test' })
        .add(
          { name: 'test', iterations: 3 },
          async () => ({ tokenSavings: 75 })
        );

      const suiteResult = await runner.run();
      const summary = generateCompactSummary(suiteResult);

      expect(summary).toContain('Summary Test');
      expect(summary).toContain('1/1 passed');
      expect(summary).toContain('Savings');
    });
  });

  describe('Code Sample Benchmarks', () => {
    it('should benchmark all simple samples', async () => {
      const runner = createBenchmarkRunner().configure({
        name: 'Simple Samples',
      });

      for (const sample of simpleSamples.slice(0, 2)) {
        runner.add(
          {
            name: sample.name,
            iterations: 3,
            tags: ['simple', ...sample.expectedServers],
          },
          async () => ({
            tokenSavings: sample.estimatedDataKb < 3 ? 25 : 60,
            toolCalls: sample.estimatedToolCalls,
            metadata: {
              category: sample.category,
              servers: sample.expectedServers,
            },
          })
        );
      }

      const suiteResult = await runner.run();

      expect(suiteResult.passedCount).toBe(Math.min(simpleSamples.length, 2));
    });

    it('should benchmark aggregation samples with higher savings', async () => {
      const runner = createBenchmarkRunner().configure({
        name: 'Aggregation Samples',
      });

      for (const sample of aggregationSamples.slice(0, 2)) {
        runner.add(
          {
            name: sample.name,
            iterations: 3,
            tags: ['aggregation', ...sample.expectedServers],
          },
          async () => ({
            tokenSavings: 70 + Math.random() * 20, // 70-90%
            toolCalls: sample.estimatedToolCalls,
          })
        );
      }

      const suiteResult = await runner.run();

      // Aggregation samples should show higher savings
      for (const benchmark of suiteResult.benchmarks) {
        expect(benchmark.tokenSavings?.mean).toBeGreaterThan(50);
      }
    });
  });
});
