/**
 * Metrics — token savings estimation, compression ratio tracking, and
 * session-level statistics exposed via the `get_metrics` tool.
 * @module metrics
 */

export {
  MetricsCollector,
  getMetricsCollector,
  shutdownMetricsCollector,
  computeTokenSavings,
  TOOL_CALL_OVERHEAD_TOKENS,
  TOKENS_PER_KB,
  CODE_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  type TokenEstimationConfig,
  type ExecutionMetrics,
  type SessionMetrics,
  type WindowedMetrics,
  type TokenSavingsInput,
  type TokenSavings,
  type ToolSavingsBucket,
  type SessionTokenSavings,
} from './metrics-collector.js';
