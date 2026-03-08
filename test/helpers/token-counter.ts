/**
 * Token Counter Utilities
 *
 * Utilities for estimating and validating token savings in MCP Conductor.
 */

/**
 * Approximate token count using character-based estimation
 * Claude uses ~4 characters per token on average for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for an object (JSON stringified)
 */
export function estimateObjectTokens(obj: unknown): number {
  const json = JSON.stringify(obj, null, 2);
  return estimateTokens(json);
}

/**
 * Token estimation for tool calls
 */
export interface ToolCallTokens {
  /** Tokens for the tool call request */
  request: number;
  /** Tokens for the tool call response */
  response: number;
  /** Total tokens */
  total: number;
}

/**
 * Estimate tokens for a tool call
 */
export function estimateToolCallTokens(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>,
  response: unknown
): ToolCallTokens {
  const requestText = JSON.stringify({
    server: serverName,
    tool: toolName,
    params,
  });

  const responseText = typeof response === 'string' ? response : JSON.stringify(response);

  const request = estimateTokens(requestText);
  const response_tokens = estimateTokens(responseText);

  return {
    request,
    response: response_tokens,
    total: request + response_tokens,
  };
}

/**
 * Token savings calculation
 */
export interface TokenSavingsResult {
  /** Estimated tokens in passthrough mode */
  passthroughTokens: number;
  /** Estimated tokens in execution mode */
  executionTokens: number;
  /** Tokens saved */
  tokensSaved: number;
  /** Percentage saved (0-100) */
  percentageSaved: number;
}

/**
 * Calculate token savings between passthrough and execution modes
 */
export function calculateTokenSavings(
  toolCalls: Array<{ request: string; response: string }>,
  executionResult: unknown
): TokenSavingsResult {
  // Passthrough mode: all tool calls visible in context
  const passthroughTokens = toolCalls.reduce((sum, call) => {
    return sum + estimateTokens(call.request) + estimateTokens(call.response);
  }, 0);

  // Execution mode: only the final result visible
  const executionTokens = estimateObjectTokens(executionResult);

  const tokensSaved = Math.max(0, passthroughTokens - executionTokens);
  const percentageSaved = passthroughTokens > 0 ? (tokensSaved / passthroughTokens) * 100 : 0;

  return {
    passthroughTokens,
    executionTokens,
    tokensSaved,
    percentageSaved,
  };
}

/**
 * Token savings estimator based on data size
 */
export interface DataSizeEstimate {
  /** Data size in KB */
  sizeKb: number;
  /** Number of tool calls */
  toolCalls: number;
  /** Estimated passthrough tokens */
  passthroughTokens: number;
  /** Estimated execution tokens */
  executionTokens: number;
  /** Expected savings percentage range */
  expectedSavingsRange: [number, number];
}

/**
 * Estimate token savings based on data size and tool calls
 *
 * Based on real-world testing:
 * - <1KB data: 0-30% savings
 * - 1-10KB data: 50-70% savings
 * - 10-50KB data: 80-90% savings
 * - >50KB data: 95-98% savings
 */
export function estimateByDataSize(sizeKb: number, toolCalls: number): DataSizeEstimate {
  // Estimate passthrough tokens (all data in context)
  const dataTokens = Math.ceil((sizeKb * 1024) / 4);
  const overheadTokens = toolCalls * 50; // ~50 tokens overhead per tool call
  const passthroughTokens = dataTokens + overheadTokens;

  // Estimate execution tokens (just the summary result)
  // Assume result is ~5% of input data for aggregation tasks
  const resultSizeKb = Math.max(0.5, sizeKb * 0.05);
  const executionTokens = Math.ceil((resultSizeKb * 1024) / 4) + 20; // +20 for structure

  // Expected savings range based on data size
  let expectedSavingsRange: [number, number];
  if (sizeKb < 1) {
    expectedSavingsRange = [0, 30];
  } else if (sizeKb < 10) {
    expectedSavingsRange = [50, 70];
  } else if (sizeKb < 50) {
    expectedSavingsRange = [80, 90];
  } else {
    expectedSavingsRange = [95, 98];
  }

  return {
    sizeKb,
    toolCalls,
    passthroughTokens,
    executionTokens,
    expectedSavingsRange,
  };
}

/**
 * Validate that actual savings fall within expected range
 */
export function validateTokenSavings(
  actual: TokenSavingsResult,
  expected: DataSizeEstimate,
  tolerancePercent: number = 25
): { valid: boolean; message: string } {
  const [minExpected, maxExpected] = expected.expectedSavingsRange;

  // Apply tolerance
  const minWithTolerance = Math.max(0, minExpected - tolerancePercent);
  const maxWithTolerance = Math.min(100, maxExpected + tolerancePercent);

  const valid =
    actual.percentageSaved >= minWithTolerance && actual.percentageSaved <= maxWithTolerance;

  const message = valid
    ? `Token savings ${actual.percentageSaved.toFixed(1)}% within expected range [${minWithTolerance}-${maxWithTolerance}%]`
    : `Token savings ${actual.percentageSaved.toFixed(1)}% outside expected range [${minWithTolerance}-${maxWithTolerance}%]`;

  return { valid, message };
}

/**
 * Token metrics for a test run
 */
export interface TokenMetrics {
  /** Total tokens used */
  totalTokens: number;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Tokens saved vs passthrough */
  tokensSaved: number;
  /** Savings percentage */
  savingsPercent: number;
  /** Cost estimate (USD, rough) */
  estimatedCostUsd: number;
}

/**
 * Calculate token metrics from execution data
 */
export function calculateMetrics(
  inputData: unknown,
  outputData: unknown,
  passthroughEquivalent: number
): TokenMetrics {
  const inputTokens = estimateObjectTokens(inputData);
  const outputTokens = estimateObjectTokens(outputData);
  const totalTokens = inputTokens + outputTokens;

  const tokensSaved = Math.max(0, passthroughEquivalent - totalTokens);
  const savingsPercent = passthroughEquivalent > 0 ? (tokensSaved / passthroughEquivalent) * 100 : 0;

  // Rough cost estimate based on Claude API pricing
  // Input: ~$3/million tokens, Output: ~$15/million tokens
  const estimatedCostUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    tokensSaved,
    savingsPercent,
    estimatedCostUsd,
  };
}

/**
 * Format token count for display
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Format percentage for display
 */
export function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/**
 * Create a summary of token savings
 */
export function createSavingsSummary(results: TokenSavingsResult[]): {
  totalPassthrough: number;
  totalExecution: number;
  totalSaved: number;
  averageSavings: number;
  summary: string;
} {
  const totalPassthrough = results.reduce((sum, r) => sum + r.passthroughTokens, 0);
  const totalExecution = results.reduce((sum, r) => sum + r.executionTokens, 0);
  const totalSaved = results.reduce((sum, r) => sum + r.tokensSaved, 0);
  const averageSavings =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.percentageSaved, 0) / results.length
      : 0;

  const summary = `
Token Savings Summary:
- Total Passthrough Tokens: ${formatTokens(totalPassthrough)}
- Total Execution Tokens: ${formatTokens(totalExecution)}
- Total Tokens Saved: ${formatTokens(totalSaved)}
- Average Savings: ${formatPercent(averageSavings)}
  `.trim();

  return {
    totalPassthrough,
    totalExecution,
    totalSaved,
    averageSavings,
    summary,
  };
}
