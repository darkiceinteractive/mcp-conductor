/**
 * Metrics — token savings estimation, compression ratio tracking, and
 * session-level statistics exposed via the `get_metrics` tool.
 * @module metrics
 */

export {
  MetricsCollector,
  getMetricsCollector,
  shutdownMetricsCollector,
  type TokenEstimationConfig,
  type ExecutionMetrics,
  type SessionMetrics,
  type WindowedMetrics,
} from './metrics-collector.js';
