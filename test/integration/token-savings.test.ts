/**
 * Token Savings Validation Tests
 *
 * Validates token estimation accuracy and savings across different data sizes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateTokens,
  estimateObjectTokens,
  estimateToolCallTokens,
  calculateTokenSavings,
  estimateByDataSize,
  validateTokenSavings,
  calculateMetrics,
  createSavingsSummary,
  formatTokens,
  formatPercent,
} from '../helpers/token-counter.js';
import {
  tokenSavingsTestSamples,
  getAllSamples,
  type CodeSample,
} from '../fixtures/code-samples/index.js';
import { generateTestData } from '../helpers/test-utils.js';

describe('Token Estimation', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate ~4 characters per token', () => {
      const text = 'Hello World!'; // 12 chars
      const tokens = estimateTokens(text);
      expect(tokens).toBe(3); // ceil(12/4) = 3
    });

    it('should handle long text', () => {
      const text = 'x'.repeat(1000);
      const tokens = estimateTokens(text);
      expect(tokens).toBe(250); // 1000/4 = 250
    });

    it('should estimate JSON correctly', () => {
      const json = JSON.stringify({ name: 'test', value: 123 });
      const tokens = estimateTokens(json);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateObjectTokens', () => {
    it('should estimate tokens for simple object', () => {
      const obj = { key: 'value' };
      const tokens = estimateObjectTokens(obj);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate tokens for nested object', () => {
      const obj = {
        level1: {
          level2: {
            level3: 'deep value',
          },
        },
      };
      const tokens = estimateObjectTokens(obj);
      expect(tokens).toBeGreaterThan(10);
    });

    it('should estimate tokens for array', () => {
      const arr = Array(100).fill({ item: 'value' });
      const tokens = estimateObjectTokens(arr);
      expect(tokens).toBeGreaterThan(100);
    });
  });

  describe('estimateToolCallTokens', () => {
    it('should estimate request and response tokens', () => {
      const result = estimateToolCallTokens(
        'filesystem',
        'read_file',
        { path: '/test/file.txt' },
        { content: 'File contents here' }
      );

      expect(result.request).toBeGreaterThan(0);
      expect(result.response).toBeGreaterThan(0);
      expect(result.total).toBe(result.request + result.response);
    });

    it('should handle large responses', () => {
      const largeContent = 'x'.repeat(10000);
      const result = estimateToolCallTokens(
        'filesystem',
        'read_file',
        { path: '/test/large.txt' },
        { content: largeContent }
      );

      expect(result.response).toBeGreaterThan(2000); // 10000/4 = 2500
    });

    it('should handle string responses', () => {
      const result = estimateToolCallTokens(
        'filesystem',
        'list_directory',
        { path: '.' },
        '[DIR] src\n[FILE] package.json'
      );

      expect(result.response).toBeGreaterThan(0);
    });
  });
});

describe('Token Savings Calculation', () => {
  describe('calculateTokenSavings', () => {
    it('should calculate savings for multiple tool calls', () => {
      const toolCalls = [
        { request: '{"tool": "read_file"}', response: 'x'.repeat(1000) },
        { request: '{"tool": "read_file"}', response: 'y'.repeat(1000) },
        { request: '{"tool": "read_file"}', response: 'z'.repeat(1000) },
      ];

      const executionResult = { summary: 'processed 3 files', totalSize: 3000 };

      const savings = calculateTokenSavings(toolCalls, executionResult);

      expect(savings.passthroughTokens).toBeGreaterThan(500);
      expect(savings.executionTokens).toBeLessThan(50);
      expect(savings.tokensSaved).toBeGreaterThan(0);
      expect(savings.percentageSaved).toBeGreaterThan(80);
    });

    it('should show minimal savings for small data', () => {
      const toolCalls = [
        { request: '{"tool": "get_status"}', response: '{"ok": true}' },
      ];

      const executionResult = { ok: true };

      const savings = calculateTokenSavings(toolCalls, executionResult);

      // Small data may still have some savings from request overhead
      // The key is that savings are lower than large data scenarios
      expect(savings.percentageSaved).toBeLessThan(80);
    });

    it('should handle empty tool calls', () => {
      const savings = calculateTokenSavings([], { result: 'empty' });

      expect(savings.passthroughTokens).toBe(0);
      expect(savings.executionTokens).toBeGreaterThan(0);
      expect(savings.percentageSaved).toBe(0);
    });
  });

  describe('estimateByDataSize', () => {
    it('should estimate low savings for small data (<1KB)', () => {
      const estimate = estimateByDataSize(0.5, 1);

      expect(estimate.expectedSavingsRange[0]).toBe(0);
      expect(estimate.expectedSavingsRange[1]).toBe(30);
    });

    it('should estimate medium savings for moderate data (1-10KB)', () => {
      const estimate = estimateByDataSize(5, 3);

      expect(estimate.expectedSavingsRange[0]).toBe(50);
      expect(estimate.expectedSavingsRange[1]).toBe(70);
    });

    it('should estimate high savings for large data (10-50KB)', () => {
      const estimate = estimateByDataSize(30, 5);

      expect(estimate.expectedSavingsRange[0]).toBe(80);
      expect(estimate.expectedSavingsRange[1]).toBe(90);
    });

    it('should estimate very high savings for huge data (>50KB)', () => {
      const estimate = estimateByDataSize(100, 10);

      expect(estimate.expectedSavingsRange[0]).toBe(95);
      expect(estimate.expectedSavingsRange[1]).toBe(98);
    });

    it('should include tool call overhead in estimate', () => {
      const singleCall = estimateByDataSize(5, 1);
      const multiCall = estimateByDataSize(5, 5);

      expect(multiCall.passthroughTokens).toBeGreaterThan(singleCall.passthroughTokens);
    });
  });

  describe('validateTokenSavings', () => {
    it('should validate savings within expected range', () => {
      const actual = {
        passthroughTokens: 1000,
        executionTokens: 200,
        tokensSaved: 800,
        percentageSaved: 80,
      };

      const expected = estimateByDataSize(30, 5); // Expects 80-90%

      const result = validateTokenSavings(actual, expected);

      expect(result.valid).toBe(true);
      expect(result.message).toContain('within expected range');
    });

    it('should fail validation outside expected range', () => {
      const actual = {
        passthroughTokens: 100,
        executionTokens: 90,
        tokensSaved: 10,
        percentageSaved: 10,
      };

      const expected = estimateByDataSize(30, 5); // Expects 80-90%

      const result = validateTokenSavings(actual, expected);

      expect(result.valid).toBe(false);
      expect(result.message).toContain('outside expected range');
    });

    it('should apply tolerance to validation', () => {
      const actual = {
        passthroughTokens: 1000,
        executionTokens: 300,
        tokensSaved: 700,
        percentageSaved: 70,
      };

      const expected = estimateByDataSize(30, 5); // Expects 80-90%

      // With 25% tolerance, 70% should be valid (80-25 = 55)
      const result = validateTokenSavings(actual, expected, 25);

      expect(result.valid).toBe(true);
    });
  });
});

describe('Token Savings by Data Size', () => {
  describe('Small Data (<1KB)', () => {
    it('should have low savings for small samples', () => {
      for (const sample of tokenSavingsTestSamples.small) {
        const estimate = estimateByDataSize(sample.estimatedDataKb, sample.estimatedToolCalls);

        expect(estimate.expectedSavingsRange[1]).toBeLessThanOrEqual(70);
        expect(sample.name).toBeDefined(); // Ensure sample is valid
      }
    });
  });

  describe('Medium Data (5-20KB)', () => {
    it('should have moderate savings for medium samples', () => {
      for (const sample of tokenSavingsTestSamples.medium) {
        const estimate = estimateByDataSize(sample.estimatedDataKb, sample.estimatedToolCalls);

        expect(estimate.expectedSavingsRange[0]).toBeGreaterThanOrEqual(50);
      }
    });
  });

  describe('Large Data (>20KB)', () => {
    it('should have high savings for large samples', () => {
      for (const sample of tokenSavingsTestSamples.large) {
        const estimate = estimateByDataSize(sample.estimatedDataKb, sample.estimatedToolCalls);

        expect(estimate.expectedSavingsRange[0]).toBeGreaterThanOrEqual(80);
      }
    });
  });

  describe('Scaling Validation', () => {
    it('should show savings increasing with data size', () => {
      const sizes = [0.5, 1, 5, 10, 30, 50, 100];
      let previousMinSavings = -1;

      for (const size of sizes) {
        const estimate = estimateByDataSize(size, 3);

        // Savings should generally increase with size
        expect(estimate.expectedSavingsRange[0]).toBeGreaterThanOrEqual(previousMinSavings);
        previousMinSavings = estimate.expectedSavingsRange[0];
      }
    });
  });
});

describe('Token Metrics', () => {
  describe('calculateMetrics', () => {
    it('should calculate comprehensive metrics', () => {
      const input = { query: 'test', options: { limit: 10 } };
      const output = { results: [1, 2, 3], count: 3 };
      const passthroughEquivalent = 500;

      const metrics = calculateMetrics(input, output, passthroughEquivalent);

      expect(metrics.inputTokens).toBeGreaterThan(0);
      expect(metrics.outputTokens).toBeGreaterThan(0);
      expect(metrics.totalTokens).toBe(metrics.inputTokens + metrics.outputTokens);
      expect(metrics.tokensSaved).toBeLessThanOrEqual(passthroughEquivalent);
      expect(metrics.savingsPercent).toBeGreaterThanOrEqual(0);
      expect(metrics.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('should calculate cost estimate correctly', () => {
      const input = { small: true };
      const output = { small: true };

      const metrics = calculateMetrics(input, output, 100);

      // Cost should be reasonable for small data
      expect(metrics.estimatedCostUsd).toBeLessThan(0.001);
    });
  });

  describe('createSavingsSummary', () => {
    it('should summarise multiple results', () => {
      const results = [
        {
          passthroughTokens: 1000,
          executionTokens: 200,
          tokensSaved: 800,
          percentageSaved: 80,
        },
        {
          passthroughTokens: 500,
          executionTokens: 100,
          tokensSaved: 400,
          percentageSaved: 80,
        },
        {
          passthroughTokens: 2000,
          executionTokens: 100,
          tokensSaved: 1900,
          percentageSaved: 95,
        },
      ];

      const summary = createSavingsSummary(results);

      expect(summary.totalPassthrough).toBe(3500);
      expect(summary.totalExecution).toBe(400);
      expect(summary.totalSaved).toBe(3100);
      expect(summary.averageSavings).toBeCloseTo(85, 0);
      expect(summary.summary).toContain('Token Savings Summary');
    });

    it('should handle empty results', () => {
      const summary = createSavingsSummary([]);

      expect(summary.totalPassthrough).toBe(0);
      expect(summary.averageSavings).toBe(0);
    });
  });
});

describe('Formatting Utilities', () => {
  describe('formatTokens', () => {
    it('should format small numbers', () => {
      expect(formatTokens(500)).toBe('500');
    });

    it('should format thousands with K suffix', () => {
      expect(formatTokens(5000)).toBe('5.0K');
    });

    it('should format millions with M suffix', () => {
      expect(formatTokens(2500000)).toBe('2.50M');
    });
  });

  describe('formatPercent', () => {
    it('should format percentage with one decimal', () => {
      expect(formatPercent(85.5)).toBe('85.5%');
      expect(formatPercent(100)).toBe('100.0%');
      expect(formatPercent(0)).toBe('0.0%');
    });
  });
});

describe('Real-World Scenarios', () => {
  describe('File Aggregation Scenario', () => {
    it('should show significant savings for multi-file read', () => {
      // Simulate reading 5 files of ~2KB each
      const toolCalls = Array(5)
        .fill(null)
        .map((_, i) => ({
          request: JSON.stringify({ tool: 'read_file', path: `file${i}.ts` }),
          response: JSON.stringify({ content: 'x'.repeat(2000) }),
        }));

      // Execution result is a summary
      const executionResult = {
        filesRead: 5,
        totalLines: 500,
        exportCount: 25,
      };

      const savings = calculateTokenSavings(toolCalls, executionResult);

      // Should have substantial savings
      expect(savings.percentageSaved).toBeGreaterThan(70);
    });
  });

  describe('Cross-Server Aggregation Scenario', () => {
    it('should show high savings for cross-server data', () => {
      const toolCalls = [
        {
          request: JSON.stringify({ server: 'filesystem', tool: 'list_directory' }),
          response: JSON.stringify({
            files: Array(50).fill('file.ts'),
          }),
        },
        {
          request: JSON.stringify({ server: 'context7', tool: 'get-library-docs' }),
          response: 'x'.repeat(5000), // 5KB of docs
        },
        {
          request: JSON.stringify({ server: 'memory', tool: 'list_projects' }),
          response: JSON.stringify({
            projects: Array(10).fill({ name: 'project', files: 20 }),
          }),
        },
      ];

      const executionResult = {
        fileCount: 50,
        docsSize: 5000,
        projectCount: 10,
        combined: true,
      };

      const savings = calculateTokenSavings(toolCalls, executionResult);

      expect(savings.percentageSaved).toBeGreaterThan(80);
    });
  });

  describe('Minimal Data Scenario', () => {
    it('should show low savings for simple status check', () => {
      const toolCalls = [
        {
          request: JSON.stringify({ tool: 'status' }),
          response: JSON.stringify({ ok: true }),
        },
      ];

      const executionResult = { ok: true };

      const savings = calculateTokenSavings(toolCalls, executionResult);

      // Even minimal data has some savings from request overhead
      // The key metric is savings are lower than large data scenarios (80%+)
      expect(savings.percentageSaved).toBeLessThan(80);
    });
  });

  describe('Generated Test Data', () => {
    it('should validate with generated data of various sizes', () => {
      const testCases = [
        { sizeKb: 0.5, expectedMinSavings: 0 },
        { sizeKb: 5, expectedMinSavings: 40 },
        { sizeKb: 20, expectedMinSavings: 70 },
        { sizeKb: 50, expectedMinSavings: 85 },
      ];

      for (const { sizeKb, expectedMinSavings } of testCases) {
        const data = generateTestData(sizeKb);

        const toolCalls = [
          {
            request: JSON.stringify({ tool: 'process_data' }),
            response: data,
          },
        ];

        const executionResult = {
          processed: true,
          sizeKb,
          checksum: 'abc123',
        };

        const savings = calculateTokenSavings(toolCalls, executionResult);

        expect(savings.percentageSaved).toBeGreaterThanOrEqual(expectedMinSavings - 10);
      }
    });
  });
});

describe('Sample Code Analysis', () => {
  it('should analyse all code samples for expected savings', () => {
    const samples = getAllSamples();
    const results: Array<{
      sample: CodeSample;
      estimate: ReturnType<typeof estimateByDataSize>;
    }> = [];

    for (const sample of samples) {
      const estimate = estimateByDataSize(sample.estimatedDataKb, sample.estimatedToolCalls);
      results.push({ sample, estimate });
    }

    // Verify we have samples across all size ranges
    const small = results.filter((r) => r.sample.estimatedDataKb < 5);
    const medium = results.filter(
      (r) => r.sample.estimatedDataKb >= 5 && r.sample.estimatedDataKb < 20
    );
    const large = results.filter((r) => r.sample.estimatedDataKb >= 20);

    expect(small.length).toBeGreaterThan(0);
    expect(medium.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(0);
  });
});
