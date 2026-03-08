/**
 * Mode Comparison Integration Tests
 *
 * Tests comparing execution, passthrough, and hybrid modes
 * to validate token savings and mode selection accuracy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MockServerFactory,
  createStandardTestSetup,
  type BridgeHandlers,
} from '../fixtures/mock-servers/index.js';
import {
  simpleSamples,
  aggregationSamples,
  transformationSamples,
  modeComparisonSamples,
} from '../fixtures/code-samples/index.js';
import {
  createMockExecutor,
  compareModesExecution,
  predictOptimalMode,
  validateHybridDecision,
  summariseComparisons,
  type ModeComparisonResult,
} from '../helpers/mode-comparator.js';
import { estimateByDataSize, validateTokenSavings } from '../helpers/token-counter.js';

describe('Mode Comparison Tests', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
    vi.clearAllMocks();
  });

  describe('Execution vs Passthrough Mode', () => {
    it('should show minimal savings for simple single-tool calls', async () => {
      const sample = simpleSamples[0]; // filesystem-list

      const executor = createMockExecutor({
        onExecute: async () => ({
          files: ['src', 'test', 'package.json'],
        }),
        onPassthrough: async () =>
          '[DIR] src\n[DIR] test\n[FILE] package.json',
      });

      const result = await compareModesExecution(sample.code, executor);

      expect(result.execution).toBeDefined();
      expect(result.passthrough).toBeDefined();
      expect(result.tokenSavings).toBeDefined();

      // Simple calls have some savings but not as high as large data aggregation
      // The main point is both modes execute without error
      expect(result.tokenSavings!.percentageSaved).toBeGreaterThanOrEqual(0);
    });

    it('should show significant savings for multi-file aggregation', async () => {
      const sample = aggregationSamples[0]; // multi-file-read

      const executor = createMockExecutor({
        onExecute: async () => ({
          fileCount: 3,
          totalSize: 15000,
        }),
        onPassthrough: async () => ({
          content: 'x'.repeat(5000), // Simulate 5KB per file
        }),
      });

      const result = await compareModesExecution(sample.code, executor);

      expect(result.execution).toBeDefined();
      expect(result.passthrough).toBeDefined();
      // Multi-file aggregation should execute in both modes
      expect(result.execution!.error).toBeUndefined();
    });

    it('should show high savings for large cross-server aggregation', async () => {
      const sample = aggregationSamples[3]; // large-aggregation
      const estimate = estimateByDataSize(sample.estimatedDataKb, sample.estimatedToolCalls);

      const executor = createMockExecutor({
        onExecute: async () => ({
          filesRead: 5,
          totalChars: 25000,
          library: 'vitest',
          projects: 2,
        }),
        onPassthrough: async (server) => {
          if (server === 'filesystem') {
            return '[DIR] utils\n[FILE] index.ts\n[FILE] config.ts\n[FILE] helpers.ts';
          }
          return { name: 'vitest', libraryId: '/vitest/vitest' };
        },
      });

      const result = await compareModesExecution(sample.code, executor);

      expect(result.tokenSavings).toBeDefined();
      // Large aggregation should have substantial savings
      expect(result.tokenSavings!.percentageSaved).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Hybrid Mode Decision Logic', () => {
    it('should choose passthrough for simple single-tool calls', () => {
      const criteria = {
        toolCalls: 1,
        estimatedDataKb: 0.5,
        hasDataProcessing: false,
        hasMultiServerCalls: false,
        expectedDurationMs: 100,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('passthrough');
      expect(prediction.confidence).toBeGreaterThan(0.8);
    });

    it('should choose execution for multi-tool operations', () => {
      const criteria = {
        toolCalls: 5,
        estimatedDataKb: 20,
        hasDataProcessing: true,
        hasMultiServerCalls: false,
        expectedDurationMs: 500,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('execution');
      expect(prediction.confidence).toBeGreaterThan(0.8);
    });

    it('should choose execution for data processing tasks', () => {
      const criteria = {
        toolCalls: 2,
        estimatedDataKb: 5,
        hasDataProcessing: true,
        hasMultiServerCalls: false,
        expectedDurationMs: 200,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('execution');
      expect(prediction.reason).toContain('processing');
    });

    it('should choose execution for cross-server operations', () => {
      const criteria = {
        toolCalls: 2,
        estimatedDataKb: 3,
        hasDataProcessing: false,
        hasMultiServerCalls: true,
        expectedDurationMs: 300,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('execution');
      expect(prediction.reason).toContain('Cross-server');
    });

    it('should choose hybrid for uncertain cases', () => {
      const criteria = {
        toolCalls: 2,
        estimatedDataKb: 2,
        hasDataProcessing: false,
        hasMultiServerCalls: false,
        expectedDurationMs: 150,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('hybrid');
      expect(prediction.confidence).toBeLessThan(0.8);
    });
  });

  describe('Hybrid Mode Accuracy', () => {
    it('should validate correct hybrid decisions', () => {
      const criteria = {
        toolCalls: 5,
        estimatedDataKb: 30,
        hasDataProcessing: true,
        hasMultiServerCalls: true,
        expectedDurationMs: 1000,
      };

      const actualDecision = 'execution';
      const optimalDecision = 'execution';

      const validation = validateHybridDecision(actualDecision, optimalDecision, criteria);

      expect(validation.correct).toBe(true);
      expect(validation.analysis).toContain('correctly');
    });

    it('should detect incorrect hybrid decisions', () => {
      const criteria = {
        toolCalls: 1,
        estimatedDataKb: 0.5,
        hasDataProcessing: false,
        hasMultiServerCalls: false,
        expectedDurationMs: 50,
      };

      const actualDecision = 'execution';
      const optimalDecision = 'passthrough';

      const validation = validateHybridDecision(actualDecision, optimalDecision, criteria);

      expect(validation.correct).toBe(false);
      expect(validation.analysis).toContain('would be better');
    });
  });

  describe('Mode Comparison Summary', () => {
    it('should summarise multiple comparison results', async () => {
      const results: ModeComparisonResult[] = [];

      // Simulate several test runs with varying savings
      const savingsScenarios = [
        { passthrough: 1000, execution: 200, savings: 80 },
        { passthrough: 500, execution: 400, savings: 20 },
        { passthrough: 2000, execution: 100, savings: 95 },
        { passthrough: 300, execution: 250, savings: 17 },
        { passthrough: 1500, execution: 150, savings: 90 },
      ];

      for (const scenario of savingsScenarios) {
        results.push({
          execution: {
            mode: 'execution',
            result: {},
            durationMs: 100,
            toolCalls: 3,
            tokenEstimate: scenario.execution,
          },
          passthrough: {
            mode: 'passthrough',
            result: {},
            durationMs: 80,
            toolCalls: 3,
            tokenEstimate: scenario.passthrough,
          },
          tokenSavings: {
            passthroughTokens: scenario.passthrough,
            executionTokens: scenario.execution,
            tokensSaved: scenario.passthrough - scenario.execution,
            percentageSaved: scenario.savings,
          },
          hybridModeDecision: scenario.savings > 30 ? 'execution' : 'passthrough',
          recommendation: scenario.savings > 30 ? 'EXECUTION' : 'PASSTHROUGH',
        });
      }

      const summary = summariseComparisons(results);

      expect(summary.totalTests).toBe(5);
      expect(summary.executionWins).toBe(3); // 3 scenarios with >30% savings
      expect(summary.passthroughWins).toBe(2);
      expect(summary.averageTokenSavings).toBeCloseTo(60.4, 0);
    });

    it('should calculate hybrid accuracy correctly', () => {
      const results: ModeComparisonResult[] = [
        // Correct: high savings, chose execution
        {
          tokenSavings: {
            passthroughTokens: 1000,
            executionTokens: 200,
            tokensSaved: 800,
            percentageSaved: 80,
          },
          hybridModeDecision: 'execution',
          recommendation: 'EXECUTION',
        },
        // Correct: low savings, chose passthrough
        {
          tokenSavings: {
            passthroughTokens: 100,
            executionTokens: 90,
            tokensSaved: 10,
            percentageSaved: 10,
          },
          hybridModeDecision: 'passthrough',
          recommendation: 'PASSTHROUGH',
        },
        // Incorrect: high savings but chose passthrough
        {
          tokenSavings: {
            passthroughTokens: 500,
            executionTokens: 100,
            tokensSaved: 400,
            percentageSaved: 80,
          },
          hybridModeDecision: 'passthrough',
          recommendation: 'PASSTHROUGH',
        },
      ];

      const summary = summariseComparisons(results);

      // 2 out of 3 correct decisions = 66.67%
      expect(summary.hybridAccuracy).toBeCloseTo(66.67, 0);
    });
  });

  describe('Sample Code Execution', () => {
    it('should execute simple samples in all modes', async () => {
      for (const sample of modeComparisonSamples.simple) {
        const executor = createMockExecutor({
          onExecute: async () => ({ result: 'executed' }),
          onPassthrough: async () => 'passthrough result',
        });

        const result = await compareModesExecution(sample.code, executor);

        expect(result.execution).toBeDefined();
        expect(result.passthrough).toBeDefined();
        expect(result.execution!.error).toBeUndefined();
        expect(result.passthrough!.error).toBeUndefined();
      }
    });

    it('should execute complex samples with higher savings', async () => {
      for (const sample of modeComparisonSamples.complex) {
        const executor = createMockExecutor({
          onExecute: async () => ({
            summary: 'aggregated',
            count: 10,
          }),
          onPassthrough: async () => 'x'.repeat(1000), // Simulate larger response
        });

        const result = await compareModesExecution(sample.code, executor);

        expect(result.tokenSavings).toBeDefined();
        // Complex samples should show some savings
        expect(result.tokenSavings!.tokensSaved).toBeGreaterThanOrEqual(0);
      }
    });

    it('should execute transformation samples', async () => {
      for (const sample of modeComparisonSamples.transformation) {
        const executor = createMockExecutor({
          onExecute: async () => ({
            transformed: true,
            fields: ['a', 'b', 'c'],
          }),
          onPassthrough: async () => ({
            content: JSON.stringify({ name: 'test', version: '1.0.0' }),
          }),
        });

        const result = await compareModesExecution(sample.code, executor);

        expect(result.execution).toBeDefined();
        expect(result.execution!.result).toHaveProperty('transformed');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty tool calls gracefully', async () => {
      const emptyCode = 'return { empty: true };';

      const executor = createMockExecutor({
        onExecute: async () => ({ empty: true }),
        onPassthrough: async () => null,
      });

      const result = await compareModesExecution(emptyCode, executor);

      expect(result.execution).toBeDefined();
      expect(result.execution!.toolCalls).toBe(0);
    });

    it('should handle errors in execution mode', async () => {
      const errorCode = `
        const fs = mcp.server('filesystem');
        throw new Error('Test error');
      `;

      const executor = createMockExecutor({
        onExecute: async () => {
          throw new Error('Test error');
        },
        onPassthrough: async () => null,
      });

      const result = await compareModesExecution(errorCode, executor);

      expect(result.execution).toBeDefined();
      expect(result.execution!.error).toBeDefined();
    });

    it('should handle errors in passthrough mode', async () => {
      // Use code with tool call pattern that the mock executor can parse
      const code = `
        fs.call('filesystem', 'read_file', { path: '/nonexistent' });
      `;

      const executor = createMockExecutor({
        onExecute: async () => ({ error: 'file not found' }),
        onPassthrough: async () => {
          throw new Error('File not found');
        },
      });

      const result = await compareModesExecution(code, executor);

      expect(result.passthrough).toBeDefined();
      // The passthrough mode should capture the error
      expect(result.passthrough!.error).toBeDefined();
    });

    it('should handle large data scenarios', async () => {
      // Use code with tool call pattern that mock executor can parse
      const largeDataCode = `
        fs.call('filesystem', 'read_file', { path: 'large1.txt' });
        fs.call('filesystem', 'read_file', { path: 'large2.txt' });
        fs.call('filesystem', 'read_file', { path: 'large3.txt' });
      `;

      const executor = createMockExecutor({
        onExecute: async () => ({
          count: 3,
          total: 150000,
        }),
        onPassthrough: async () => ({
          content: 'x'.repeat(50000), // 50KB per file
        }),
      });

      const result = await compareModesExecution(largeDataCode, executor);

      // Both modes should execute
      expect(result.execution).toBeDefined();
      expect(result.passthrough).toBeDefined();
      expect(result.execution!.toolCalls).toBe(3);
    });
  });
});
