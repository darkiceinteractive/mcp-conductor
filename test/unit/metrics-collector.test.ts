import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  MetricsCollector,
  getMetricsCollector,
  shutdownMetricsCollector,
  type ExecutionMetrics,
} from '../../src/metrics/index.js';
import type { MetricsConfig } from '../../src/config/index.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let config: MetricsConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      logToFile: false,
      logPath: null,
    };
    collector = new MetricsCollector(config);
  });

  afterEach(() => {
    shutdownMetricsCollector();
  });

  describe('constructor', () => {
    it('should create collector with config', () => {
      expect(collector).toBeInstanceOf(MetricsCollector);
      expect(collector.isEnabled()).toBe(true);
    });

    it('should generate unique session ID', () => {
      const collector2 = new MetricsCollector(config);
      const metrics1 = collector.getSessionMetrics();
      const metrics2 = collector2.getSessionMetrics();
      expect(metrics1.sessionId).not.toBe(metrics2.sessionId);
    });
  });

  describe('estimateCodeTokens', () => {
    it('should estimate tokens for empty string', () => {
      expect(collector.estimateCodeTokens('')).toBe(0);
    });

    it('should estimate tokens for simple code', () => {
      const code = 'const x = 1;';
      const tokens = collector.estimateCodeTokens(code);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(code.length); // Should be compressed
    });

    it('should estimate tokens for complex code', () => {
      const code = `
        async function fetchData() {
          const response = await fetch('/api/data');
          const data = await response.json();
          return data.filter(item => item.active);
        }
      `;
      const tokens = collector.estimateCodeTokens(code);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should account for keywords', () => {
      const withKeywords = 'const let var function async await';
      const withoutKeywords = 'xxxxx yyy zzz xxxxxxxx zzzzz zzzzz';

      // Keywords should be tokenized efficiently
      const keywordTokens = collector.estimateCodeTokens(withKeywords);
      const plainTokens = collector.estimateCodeTokens(withoutKeywords);

      // Both should produce reasonable estimates
      expect(keywordTokens).toBeGreaterThan(0);
      expect(plainTokens).toBeGreaterThan(0);
    });
  });

  describe('estimateJsonTokens', () => {
    it('should estimate tokens for empty string', () => {
      expect(collector.estimateJsonTokens('')).toBe(0);
    });

    it('should estimate tokens from string', () => {
      const json = '{"key": "value", "count": 42}';
      const tokens = collector.estimateJsonTokens(json);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate tokens from object', () => {
      const obj = { key: 'value', nested: { a: 1, b: 2 } };
      const tokens = collector.estimateJsonTokens(obj);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 3, { name: 'test' }];
      const tokens = collector.estimateJsonTokens(arr);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateTextTokens', () => {
    it('should estimate tokens for empty string', () => {
      expect(collector.estimateTextTokens('')).toBe(0);
    });

    it('should estimate tokens for natural language', () => {
      const text = 'This is a sample sentence with multiple words.';
      const tokens = collector.estimateTextTokens(text);
      expect(tokens).toBeGreaterThan(0);
      // Should be roughly 1.3 tokens per word for natural language
      const wordCount = text.split(/\s+/).length;
      expect(tokens).toBeGreaterThanOrEqual(wordCount);
      expect(tokens).toBeLessThan(wordCount * 3); // Sanity check
    });
  });

  describe('estimatePassthroughTokens', () => {
    it('should calculate overhead for tool calls', () => {
      const tokens = collector.estimatePassthroughTokens(5, 0);
      expect(tokens).toBeGreaterThan(0);
      // 5 calls * ~150 overhead = ~750 tokens
      expect(tokens).toBeGreaterThanOrEqual(500);
    });

    it('should calculate data tokens', () => {
      const tokens = collector.estimatePassthroughTokens(0, 10240); // 10KB
      expect(tokens).toBeGreaterThan(0);
      // 10KB * ~256 tokens/KB = ~2560 tokens
      expect(tokens).toBeGreaterThanOrEqual(2000);
    });

    it('should combine tool calls and data', () => {
      const toolOnlyTokens = collector.estimatePassthroughTokens(5, 0);
      const dataOnlyTokens = collector.estimatePassthroughTokens(0, 5120);
      const combinedTokens = collector.estimatePassthroughTokens(5, 5120);

      // Combined should be roughly equal to sum
      expect(combinedTokens).toBeCloseTo(toolOnlyTokens + dataOnlyTokens, -1);
    });
  });

  describe('calculateTokenSavings', () => {
    it('should calculate savings correctly', () => {
      const savings = collector.calculateTokenSavings({
        codeTokens: 50,
        resultTokens: 30,
        toolCalls: 5,
        dataProcessedBytes: 10240, // 10KB
      });

      expect(savings.tokensSaved).toBeGreaterThan(0);
      expect(savings.savingsPercent).toBeGreaterThan(0);
      expect(savings.savingsPercent).toBeLessThanOrEqual(100);
    });

    it('should return zero for no data processed', () => {
      const savings = collector.calculateTokenSavings({
        codeTokens: 50,
        resultTokens: 30,
        toolCalls: 0,
        dataProcessedBytes: 0,
      });

      expect(savings.tokensSaved).toBe(0);
    });

    it('should handle case where execution uses more tokens', () => {
      // If code + result is larger than passthrough would be
      const savings = collector.calculateTokenSavings({
        codeTokens: 5000,
        resultTokens: 3000,
        toolCalls: 1,
        dataProcessedBytes: 100,
      });

      // Should never be negative
      expect(savings.tokensSaved).toBe(0);
    });
  });

  describe('recordExecution', () => {
    it('should record a successful execution', () => {
      const metrics = collector.recordExecution({
        executionId: 'exec_1',
        code: 'return await fs.call("read_file", { path: "/test" });',
        result: { content: 'file data' },
        success: true,
        durationMs: 150,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 50,
        mode: 'execution',
        serversUsed: ['filesystem'],
        toolsUsed: ['read_file'],
      });

      expect(metrics.executionId).toBe('exec_1');
      expect(metrics.success).toBe(true);
      expect(metrics.mode).toBe('execution');
      expect(metrics.codeTokens).toBeGreaterThan(0);
      expect(metrics.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    });

    it('should record a failed execution', () => {
      const metrics = collector.recordExecution({
        executionId: 'exec_2',
        code: 'throw new Error("test");',
        result: null,
        success: false,
        durationMs: 50,
        toolCalls: 0,
        dataProcessedBytes: 0,
        resultSizeBytes: 0,
        mode: 'execution',
        errorType: 'runtime',
      });

      expect(metrics.success).toBe(false);
    });

    it('should emit execution event', () => {
      const handler = vi.fn();
      collector.on('execution', handler);

      collector.recordExecution({
        executionId: 'exec_3',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 10,
        toolCalls: 0,
        dataProcessedBytes: 0,
        resultSizeBytes: 1,
        mode: 'execution',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'exec_3',
          success: true,
        })
      );
    });

    it('should set zero savings for passthrough mode', () => {
      const metrics = collector.recordExecution({
        executionId: 'exec_4',
        code: '',
        result: { data: 'test' },
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 100,
        mode: 'passthrough',
      });

      expect(metrics.estimatedTokensSaved).toBe(0);
      expect(metrics.savingsPercent).toBe(0);
    });
  });

  describe('getSessionMetrics', () => {
    it('should return empty metrics for new session', () => {
      const metrics = collector.getSessionMetrics();
      expect(metrics.totalExecutions).toBe(0);
      expect(metrics.totalTokensSaved).toBe(0);
    });

    it('should aggregate multiple executions', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 2,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['github'],
        toolsUsed: ['list_issues'],
      });

      collector.recordExecution({
        executionId: 'exec_2',
        code: 'return 2;',
        result: 2,
        success: true,
        durationMs: 200,
        toolCalls: 3,
        dataProcessedBytes: 2048,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['filesystem'],
        toolsUsed: ['read_file'],
      });

      const metrics = collector.getSessionMetrics();
      expect(metrics.totalExecutions).toBe(2);
      expect(metrics.successfulExecutions).toBe(2);
      expect(metrics.totalToolCalls).toBe(5);
      expect(metrics.totalDataProcessedBytes).toBe(3072);
      expect(metrics.executionModeCount).toBe(2);
    });

    it('should track server and tool usage', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['github', 'github', 'filesystem'],
        toolsUsed: ['list_issues', 'list_issues', 'read_file'],
      });

      const metrics = collector.getSessionMetrics();
      expect(metrics.toolCallsByServer['github']).toBe(1);
      expect(metrics.toolCallsByServer['filesystem']).toBe(1);
    });

    it('should calculate averages', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 2,
        dataProcessedBytes: 1000,
        resultSizeBytes: 10,
        mode: 'execution',
      });

      collector.recordExecution({
        executionId: 'exec_2',
        code: 'return 2;',
        result: 2,
        success: true,
        durationMs: 200,
        toolCalls: 4,
        dataProcessedBytes: 3000,
        resultSizeBytes: 20,
        mode: 'execution',
      });

      const metrics = collector.getSessionMetrics();
      expect(metrics.averageDurationMs).toBe(150);
      expect(metrics.averageDataPerExecution).toBe(2000);
      expect(metrics.minDurationMs).toBe(100);
      expect(metrics.maxDurationMs).toBe(200);
    });

    it('should track uptime', async () => {
      const startMetrics = collector.getSessionMetrics();
      const initialUptime = startMetrics.uptime;

      // Wait a bit
      await new Promise((r) => setTimeout(r, 50));

      const laterMetrics = collector.getSessionMetrics();
      expect(laterMetrics.uptime).toBeGreaterThan(initialUptime);
    });
  });

  describe('getWindowedMetrics', () => {
    it('should return empty for no executions', () => {
      const windows = collector.getWindowedMetrics();
      expect(windows).toEqual([]);
    });

    it('should group executions by time window', () => {
      // Record multiple executions
      for (let i = 0; i < 5; i++) {
        collector.recordExecution({
          executionId: `exec_${i}`,
          code: 'return 1;',
          result: 1,
          success: true,
          durationMs: 100,
          toolCalls: 1,
          dataProcessedBytes: 1024,
          resultSizeBytes: 10,
          mode: 'execution',
        });
      }

      const windows = collector.getWindowedMetrics(60000); // 1 minute windows
      expect(windows.length).toBeGreaterThan(0);

      // All recent executions should be in the same window
      const totalExecs = windows.reduce((sum, w) => sum + w.executions, 0);
      expect(totalExecs).toBe(5);
    });
  });

  describe('getRecentExecutions', () => {
    it('should return recent executions', () => {
      for (let i = 0; i < 15; i++) {
        collector.recordExecution({
          executionId: `exec_${i}`,
          code: 'return 1;',
          result: 1,
          success: true,
          durationMs: 100,
          toolCalls: 1,
          dataProcessedBytes: 1024,
          resultSizeBytes: 10,
          mode: 'execution',
        });
      }

      const recent = collector.getRecentExecutions(5);
      expect(recent).toHaveLength(5);
      expect(recent[4].executionId).toBe('exec_14');
    });
  });

  describe('getTopServers', () => {
    it('should return top servers by usage', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 3,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['github'],
      });

      collector.recordExecution({
        executionId: 'exec_2',
        code: 'return 2;',
        result: 2,
        success: true,
        durationMs: 100,
        toolCalls: 2,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['filesystem'],
      });

      collector.recordExecution({
        executionId: 'exec_3',
        code: 'return 3;',
        result: 3,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        serversUsed: ['github'],
      });

      const top = collector.getTopServers(2);
      expect(top).toHaveLength(2);
      expect(top[0].server).toBe('github');
      expect(top[0].calls).toBe(2);
    });
  });

  describe('getTopTools', () => {
    it('should return top tools by usage', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        toolsUsed: ['read_file', 'list_directory'],
      });

      collector.recordExecution({
        executionId: 'exec_2',
        code: 'return 2;',
        result: 2,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
        toolsUsed: ['read_file'],
      });

      const top = collector.getTopTools(2);
      expect(top[0].tool).toBe('read_file');
      expect(top[0].calls).toBe(2);
    });
  });

  describe('exportToJson', () => {
    it('should export metrics as JSON', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
      });

      const json = collector.exportToJson();
      const parsed = JSON.parse(json);

      expect(parsed.session).toBeDefined();
      expect(parsed.executions).toBeDefined();
      expect(parsed.executions).toHaveLength(1);
      expect(parsed.windowedMetrics).toBeDefined();
    });
  });

  describe('reset', () => {
    it('should reset all metrics', () => {
      collector.recordExecution({
        executionId: 'exec_1',
        code: 'return 1;',
        result: 1,
        success: true,
        durationMs: 100,
        toolCalls: 1,
        dataProcessedBytes: 1024,
        resultSizeBytes: 10,
        mode: 'execution',
      });

      expect(collector.getSessionMetrics().totalExecutions).toBe(1);

      collector.reset();

      expect(collector.getSessionMetrics().totalExecutions).toBe(0);
    });

    it('should emit reset event', () => {
      const handler = vi.fn();
      collector.on('reset', handler);

      collector.reset();

      expect(handler).toHaveBeenCalled();
    });

    it('should generate new session ID', () => {
      const oldSessionId = collector.getSessionMetrics().sessionId;
      collector.reset();
      const newSessionId = collector.getSessionMetrics().sessionId;
      expect(newSessionId).not.toBe(oldSessionId);
    });
  });
});

describe('File logging', () => {
  let tempDir: string;

  beforeEach(async () => {
    shutdownMetricsCollector();
    tempDir = await mkdtemp(join(tmpdir(), 'metrics-test-'));
  });

  afterEach(async () => {
    shutdownMetricsCollector();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should log to file when enabled', async () => {
    const logPath = join(tempDir, 'metrics.log');
    const collector = new MetricsCollector({
      enabled: true,
      logToFile: true,
      logPath,
    });

    collector.recordExecution({
      executionId: 'exec_1',
      code: 'return 1;',
      result: 1,
      success: true,
      durationMs: 100,
      toolCalls: 1,
      dataProcessedBytes: 1024,
      resultSizeBytes: 10,
      mode: 'execution',
    });

    const content = await readFile(logPath, 'utf-8');
    expect(content).toContain('exec_1');
    expect(content).toContain('"success":true');
  });

  it('should create log directory if needed', async () => {
    const logPath = join(tempDir, 'nested', 'dir', 'metrics.log');
    const collector = new MetricsCollector({
      enabled: true,
      logToFile: true,
      logPath,
    });

    collector.recordExecution({
      executionId: 'exec_1',
      code: 'return 1;',
      result: 1,
      success: true,
      durationMs: 100,
      toolCalls: 1,
      dataProcessedBytes: 1024,
      resultSizeBytes: 10,
      mode: 'execution',
    });

    const content = await readFile(logPath, 'utf-8');
    expect(content).toContain('exec_1');
  });
});

describe('Global metrics collector', () => {
  beforeEach(() => {
    shutdownMetricsCollector();
  });

  afterEach(() => {
    shutdownMetricsCollector();
  });

  it('should require config on first call', () => {
    expect(() => getMetricsCollector()).toThrow('Metrics collector not initialised');
  });

  it('should return singleton instance', () => {
    const config: MetricsConfig = { enabled: true, logToFile: false, logPath: null };
    const collector1 = getMetricsCollector(config);
    const collector2 = getMetricsCollector();
    expect(collector1).toBe(collector2);
  });

  it('should create new instance after shutdown', () => {
    const config: MetricsConfig = { enabled: true, logToFile: false, logPath: null };
    const collector1 = getMetricsCollector(config);
    shutdownMetricsCollector();
    const collector2 = getMetricsCollector(config);
    expect(collector1).not.toBe(collector2);
  });
});
