/**
 * B13 Token-Savings Reporter — Unit Tests
 *
 * Covers:
 *   - computeTokenSavings() pure function (all PRD §5.4 unit cases)
 *   - MetricsCollector.getTokenSavings() session aggregate (Mode B)
 *   - MetricsCollector.recordToolCall() per-tool bucketing
 *   - Snapshot cross-check against Google Drive → Salesforce fixture
 *   - metrics.alwaysShowTokenSavings config flag (Mode C)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeTokenSavings,
  MetricsCollector,
  shutdownMetricsCollector,
  TOOL_CALL_OVERHEAD_TOKENS,
  TOKENS_PER_KB,
  CODE_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  type TokenSavingsInput,
} from '../../src/metrics/index.js';
import type { MetricsConfig } from '../../src/config/index.js';
import {
  GOOGLE_DRIVE_TO_SALESFORCE_FIXTURE,
  EXTRACTION_SCRIPT_CHARS,
  EXTRACTION_RESULT_JSON,
  PASSTHROUGH_TOOL_CALLS,
  TOTAL_PASSTHROUGH_BYTES,
} from '../fixtures/google-drive-to-salesforce.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MetricsConfig> = {}): MetricsConfig {
  return {
    enabled: true,
    logToFile: false,
    logPath: null,
    alwaysShowTokenSavings: false,
    ...overrides,
  };
}

function makeCollector(overrides: Partial<MetricsConfig> = {}): MetricsCollector {
  return new MetricsCollector(makeConfig(overrides));
}

// ─── computeTokenSavings — pure function ─────────────────────────────────────

describe('computeTokenSavings()', () => {
  describe('zero-activity / overhead-only path', () => {
    it('returns savings ≈ 0% for overhead-only call (0 tool calls, 0 bytes)', () => {
      const input: TokenSavingsInput = {
        toolCalls: 0,
        dataProcessedBytes: 0,
        codeChars: 50,
        resultBytes: 20,
      };
      const savings = computeTokenSavings(input);

      // With no tool calls and no data, passthrough tokens = 0.
      // The note field signals "not applicable".
      expect(savings.estimatedPassthroughTokens).toBe(0);
      expect(savings.tokensSaved).toBe(0);
      expect(savings.savingsPercent).toBe(0);
      expect(savings.note).toMatch(/passthrough.*not applicable/i);
    });

    it('tokensSaved is clamped to 0 when execution tokens > passthrough tokens', () => {
      // A single tiny call with minimal data but large code.
      const input: TokenSavingsInput = {
        toolCalls: 1,
        dataProcessedBytes: 10,   // tiny data ⇒ passthrough ≈ 150 + (10/1024×256) ≈ 152
        codeChars: 5000,          // large code ⇒ execution = ceil(5000/3.5) = 1429
        resultBytes: 50,
      };
      const savings = computeTokenSavings(input);
      expect(savings.tokensSaved).toBeGreaterThanOrEqual(0);
      expect(savings.savingsPercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('realistic large-data path', () => {
    it('returns >99% savings for 3 tool calls, 500KB data, 100B result, 200-char code', () => {
      const input: TokenSavingsInput = {
        toolCalls: 3,
        dataProcessedBytes: 500 * 1024,  // 500 KB
        codeChars: 200,
        resultBytes: 100,
      };
      const savings = computeTokenSavings(input);

      // passthrough = (3 × 150) + (500 × 256) = 450 + 128000 = 128450
      // execution  = ceil(200/3.5) + ceil(100/3.8) = 58 + 27 = 85
      // savings%   = (128450 - 85) / 128450 × 100 ≈ 99.9%
      expect(savings.estimatedPassthroughTokens).toBeGreaterThan(100000);
      expect(savings.actualExecutionTokens).toBeLessThan(200);
      expect(savings.tokensSaved).toBeGreaterThan(100000);
      expect(savings.savingsPercent).toBeGreaterThan(99);
      expect(savings.note).toBeUndefined();
    });

    it('savings% is rounded to one decimal place', () => {
      const input: TokenSavingsInput = {
        toolCalls: 3,
        dataProcessedBytes: 500 * 1024,
        codeChars: 200,
        resultBytes: 100,
      };
      const { savingsPercent } = computeTokenSavings(input);
      // One decimal: e.g. 99.9, not 99.93281...
      expect(savingsPercent).toBe(Math.round(savingsPercent * 10) / 10);
    });
  });

  describe('formula constants', () => {
    it('uses the canonical formula values', () => {
      expect(TOOL_CALL_OVERHEAD_TOKENS).toBe(150);
      expect(TOKENS_PER_KB).toBe(256);
      expect(CODE_CHARS_PER_TOKEN).toBe(3.5);
      expect(JSON_CHARS_PER_TOKEN).toBe(3.8);
    });

    it('passthrough tokens match formula exactly', () => {
      const toolCalls = 5;
      const dataProcessedBytes = 100 * 1024; // 100 KB
      const input: TokenSavingsInput = { toolCalls, dataProcessedBytes, codeChars: 0, resultBytes: 0 };
      const { estimatedPassthroughTokens } = computeTokenSavings(input);

      const expected = Math.ceil(
        toolCalls * TOOL_CALL_OVERHEAD_TOKENS + (dataProcessedBytes / 1024) * TOKENS_PER_KB,
      );
      expect(estimatedPassthroughTokens).toBe(expected);
    });

    it('execution tokens match formula exactly', () => {
      const codeChars = 700;
      const resultBytes = 380;
      const input: TokenSavingsInput = { toolCalls: 1, dataProcessedBytes: 0, codeChars, resultBytes };
      const { actualExecutionTokens } = computeTokenSavings(input);

      const expected =
        Math.ceil(codeChars / CODE_CHARS_PER_TOKEN) + Math.ceil(resultBytes / JSON_CHARS_PER_TOKEN);
      expect(actualExecutionTokens).toBe(expected);
    });
  });

  describe('passthrough-mode tool note', () => {
    it('sets "not applicable" note when toolCalls=0 and dataProcessedBytes=0', () => {
      const savings = computeTokenSavings({ toolCalls: 0, dataProcessedBytes: 0, codeChars: 100, resultBytes: 50 });
      expect(savings.note).toMatch(/passthrough.*not applicable/i);
      expect(savings.tokensSaved).toBe(0);
      expect(savings.savingsPercent).toBe(0);
    });

    it('does NOT set note when toolCalls > 0', () => {
      const savings = computeTokenSavings({ toolCalls: 1, dataProcessedBytes: 0, codeChars: 100, resultBytes: 50 });
      expect(savings.note).toBeUndefined();
    });

    it('does NOT set note when dataProcessedBytes > 0', () => {
      const savings = computeTokenSavings({ toolCalls: 0, dataProcessedBytes: 1024, codeChars: 100, resultBytes: 50 });
      expect(savings.note).toBeUndefined();
    });
  });
});

// ─── Snapshot cross-check: Google Drive → Salesforce fixture ─────────────────

describe('computeTokenSavings() — Google Drive→Salesforce fixture snapshot', () => {
  it('independently calculates >=99.7% savings matching the Anthropic benchmark', () => {
    const savings = computeTokenSavings({
      toolCalls: PASSTHROUGH_TOOL_CALLS,
      dataProcessedBytes: TOTAL_PASSTHROUGH_BYTES,
      codeChars: EXTRACTION_SCRIPT_CHARS,
      resultBytes: EXTRACTION_RESULT_JSON.length,
    });

    // The fixture itself asserts >= 98% (Anthropic's published claim).
    // The reporter should independently reach the same figure.
    expect(savings.savingsPercent).toBeGreaterThanOrEqual(99.7);

    // Cross-check passthrough token estimate against fixture's own calculation.
    expect(savings.estimatedPassthroughTokens).toBeGreaterThanOrEqual(
      GOOGLE_DRIVE_TO_SALESFORCE_FIXTURE.passthroughTokens * 0.99,
    );
    expect(savings.estimatedPassthroughTokens).toBeLessThanOrEqual(
      GOOGLE_DRIVE_TO_SALESFORCE_FIXTURE.passthroughTokens * 1.01,
    );
  });
});

// ─── MetricsCollector — recordToolCall + getTokenSavings (Mode B) ────────────

describe('MetricsCollector.recordToolCall() + getTokenSavings()', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = makeCollector();
  });

  afterEach(() => {
    shutdownMetricsCollector();
  });

  it('starts with empty perTool array', () => {
    const ts = collector.getTokenSavings();
    expect(ts.perTool).toHaveLength(0);
    expect(ts.sessionActual).toBe(0);
    expect(ts.sessionEstimatedDirect).toBe(0);
    expect(ts.sessionSavingsPercent).toBe(0);
  });

  it('accumulates per-tool buckets correctly', () => {
    collector.recordToolCall('google-drive', 'export_file', 1450, false);
    collector.recordToolCall('google-drive', 'export_file', 1450, false);
    collector.recordToolCall('salesforce', 'upsert_records', 200, false);

    const ts = collector.getTokenSavings();
    expect(ts.perTool).toHaveLength(2);

    const driveBucket = ts.perTool.find(b => b.server === 'google-drive' && b.tool === 'export_file');
    expect(driveBucket).toBeDefined();
    expect(driveBucket!.calls).toBe(2);

    const sfBucket = ts.perTool.find(b => b.server === 'salesforce' && b.tool === 'upsert_records');
    expect(sfBucket).toBeDefined();
    expect(sfBucket!.calls).toBe(1);
  });

  it('marks passthrough-mode tools with a note', () => {
    collector.recordToolCall('filesystem', 'read_file', 500, true);

    const ts = collector.getTokenSavings();
    const bucket = ts.perTool.find(b => b.server === 'filesystem');
    expect(bucket).toBeDefined();
    expect(bucket!.note).toMatch(/passthrough.*not applicable/i);
  });

  it('sessionSavingsPercent rounds to one decimal', () => {
    // Record an execution to get non-zero session totals.
    collector.recordExecution({
      executionId: 'test-exec-1',
      code: 'const x = await mcp.filesystem.call("read_file", { path: "/a" }); return x;',
      result: { content: 'hello world' },
      success: true,
      durationMs: 123,
      toolCalls: 2,
      dataProcessedBytes: 50 * 1024,
      resultSizeBytes: 50,
      mode: 'execution',
      serversUsed: ['filesystem'],
      toolsUsed: ['read_file'],
    });

    const { sessionSavingsPercent } = collector.getTokenSavings();
    expect(sessionSavingsPercent).toBe(Math.round(sessionSavingsPercent * 10) / 10);
  });
});

// ─── metrics.alwaysShowTokenSavings config flag (Mode C) ─────────────────────

describe('metrics.alwaysShowTokenSavings', () => {
  it('config field defaults to false', () => {
    const config = makeConfig();
    expect(config.alwaysShowTokenSavings).toBe(false);
  });

  it('config field can be set to true', () => {
    const config = makeConfig({ alwaysShowTokenSavings: true });
    expect(config.alwaysShowTokenSavings).toBe(true);
  });

  it('MetricsCollector can be constructed with alwaysShowTokenSavings=true without error', () => {
    const collector = makeCollector({ alwaysShowTokenSavings: true });
    expect(collector.isEnabled()).toBe(true);
    // getTokenSavings() should work fine with the flag present
    const ts = collector.getTokenSavings();
    expect(ts).toHaveProperty('sessionActual');
    expect(ts).toHaveProperty('sessionEstimatedDirect');
    expect(ts).toHaveProperty('sessionSavingsPercent');
    expect(ts).toHaveProperty('perTool');
  });
});
