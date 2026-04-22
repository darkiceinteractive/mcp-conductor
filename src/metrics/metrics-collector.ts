/**
 * Metrics Collector
 *
 * Comprehensive metrics collection and analysis for MCP Executor.
 * Provides detailed tracking of executions, token savings, and performance.
 */

import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/index.js';
import type { MetricsConfig } from '../config/index.js';

/**
 * Token estimation configuration for different content types
 */
export interface TokenEstimationConfig {
  /** Chars per token for code content (typically higher density) */
  codeCharsPerToken: number;
  /** Chars per token for JSON content */
  jsonCharsPerToken: number;
  /** Chars per token for natural language */
  textCharsPerToken: number;
  /** Overhead tokens per tool call */
  toolCallOverheadTokens: number;
  /** Tokens per KB of raw data in context */
  tokensPerKb: number;
}

/**
 * Single execution metrics
 */
export interface ExecutionMetrics {
  executionId: string;
  timestamp: Date;
  durationMs: number;
  success: boolean;
  codeTokens: number;
  resultTokens: number;
  toolCalls: number;
  dataProcessedBytes: number;
  resultSizeBytes: number;
  estimatedTokensSaved: number;
  savingsPercent: number;
  mode: 'execution' | 'passthrough';
  serversUsed: string[];
  toolsUsed: string[];
}

/**
 * Aggregated session metrics
 */
export interface SessionMetrics {
  sessionId: string;
  sessionStart: Date;
  lastActivity: Date;
  uptime: number;

  // Execution counts
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;

  // Tool usage
  totalToolCalls: number;
  toolCallsByServer: Record<string, number>;
  toolCallsByTool: Record<string, number>;

  // Data metrics
  totalDataProcessedBytes: number;
  totalResultBytes: number;
  averageDataPerExecution: number;

  // Token metrics
  totalCodeTokens: number;
  totalResultTokens: number;
  totalEstimatedDirectTokens: number;
  totalTokensSaved: number;
  averageTokensSaved: number;
  averageSavingsPercent: number;

  // Performance
  totalDurationMs: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;

  // Mode breakdown
  executionModeCount: number;
  passthroughModeCount: number;

  // Error tracking
  totalErrors: number;
  errorsByType: Record<string, number>;
}

/**
 * Time-windowed metrics for trend analysis
 */
export interface WindowedMetrics {
  windowStart: Date;
  windowEnd: Date;
  windowDurationMs: number;
  executions: number;
  tokensSaved: number;
  averageDurationMs: number;
  successRate: number;
}

/**
 * Metrics Collector class
 */
export class MetricsCollector extends EventEmitter {
  private config: MetricsConfig;
  private estimationConfig: TokenEstimationConfig;
  private sessionId: string;
  private sessionStart: Date;
  private executions: ExecutionMetrics[] = [];
  private maxStoredExecutions = 100;
  private logPath: string | null = null;

  constructor(config: MetricsConfig, estimationConfig?: Partial<TokenEstimationConfig>) {
    super();
    this.config = config;
    this.sessionId = this.generateSessionId();
    this.sessionStart = new Date();

    // Default token estimation config - tuned for Claude's tokenizer
    this.estimationConfig = {
      codeCharsPerToken: 3.5, // Code is denser
      jsonCharsPerToken: 3.8, // JSON has structure overhead
      textCharsPerToken: 4.0, // Natural language average
      toolCallOverheadTokens: 150, // Request + response overhead per call
      tokensPerKb: 256, // ~4 bytes per token
      ...estimationConfig,
    };

    // Set up file logging if enabled
    if (config.logToFile && config.logPath) {
      this.logPath = config.logPath;
      this.ensureLogDirectory();
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    if (this.logPath) {
      const dir = dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Estimate tokens for code content
   */
  estimateCodeTokens(code: string): number {
    if (!code) return 0;

    // Account for common code patterns that affect tokenization
    let adjustedLength = code.length;

    // Count special constructs that typically become single tokens
    const singleTokenPatterns = [
      /\b(const|let|var|function|async|await|return|import|export|class|interface|type)\b/g,
      /[{}[\]()]/g, // Brackets often become single tokens
      /\s+/g, // Whitespace is often compressed
    ];

    for (const pattern of singleTokenPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        // These are typically 1 token regardless of exact character count
        adjustedLength -= matches.reduce((sum, m) => sum + m.length - 1, 0);
      }
    }

    return Math.ceil(adjustedLength / this.estimationConfig.codeCharsPerToken);
  }

  /**
   * Estimate tokens for JSON content
   */
  estimateJsonTokens(json: string | unknown): number {
    const str = typeof json === 'string' ? json : JSON.stringify(json);
    if (!str) return 0;

    // JSON has structural overhead - keys, quotes, brackets
    let adjustedLength = str.length;

    // Account for string keys being tokenized as units
    const keyMatches = str.match(/"[^"]+"\s*:/g);
    if (keyMatches) {
      // Keys are often 1-2 tokens
      adjustedLength -= keyMatches.reduce((sum, k) => sum + Math.max(0, k.length - 4), 0);
    }

    return Math.ceil(adjustedLength / this.estimationConfig.jsonCharsPerToken);
  }

  /**
   * Estimate tokens for general text content
   */
  estimateTextTokens(text: string): number {
    if (!text) return 0;

    // Count words as a cross-check (average ~1.3 tokens per word)
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    const charBasedEstimate = Math.ceil(text.length / this.estimationConfig.textCharsPerToken);
    const wordBasedEstimate = Math.ceil(words * 1.3);

    // Use the average of both methods
    return Math.ceil((charBasedEstimate + wordBasedEstimate) / 2);
  }

  /**
   * Estimate tokens from byte size
   */
  estimateTokensFromBytes(bytes: number): number {
    return Math.ceil(bytes / 4);
  }

  /**
   * Estimate tokens that would be used in passthrough mode
   */
  estimatePassthroughTokens(toolCalls: number, dataBytes: number): number {
    const overhead = toolCalls * this.estimationConfig.toolCallOverheadTokens;
    const dataTokens = dataBytes / 1024 * this.estimationConfig.tokensPerKb;
    return Math.ceil(overhead + dataTokens);
  }

  /**
   * Calculate token savings from execution mode
   */
  calculateTokenSavings(params: {
    codeTokens: number;
    resultTokens: number;
    toolCalls: number;
    dataProcessedBytes: number;
  }): { tokensSaved: number; savingsPercent: number } {
    const { codeTokens, resultTokens, toolCalls, dataProcessedBytes } = params;

    // What execution mode actually used
    const executionModeTokens = codeTokens + resultTokens;

    // What passthrough mode would have used
    const passthroughModeTokens = this.estimatePassthroughTokens(toolCalls, dataProcessedBytes);

    // Calculate savings
    const tokensSaved = Math.max(0, passthroughModeTokens - executionModeTokens);
    const savingsPercent = passthroughModeTokens > 0
      ? Math.round((tokensSaved / passthroughModeTokens) * 100)
      : 0;

    return { tokensSaved, savingsPercent };
  }

  /**
   * Record an execution
   */
  recordExecution(params: {
    executionId: string;
    code: string;
    result: unknown;
    success: boolean;
    durationMs: number;
    toolCalls: number;
    dataProcessedBytes: number;
    resultSizeBytes: number;
    mode: 'execution' | 'passthrough';
    serversUsed?: string[];
    toolsUsed?: string[];
    errorType?: string;
  }): ExecutionMetrics {
    const {
      executionId,
      code,
      result,
      success,
      durationMs,
      toolCalls,
      dataProcessedBytes,
      resultSizeBytes,
      mode,
      serversUsed = [],
      toolsUsed = [],
      errorType,
    } = params;

    // Calculate token usage
    const codeTokens = this.estimateCodeTokens(code);
    const resultTokens = result ? this.estimateJsonTokens(result) : 0;

    // Calculate savings (only meaningful for execution mode)
    const savings = mode === 'execution'
      ? this.calculateTokenSavings({ codeTokens, resultTokens, toolCalls, dataProcessedBytes })
      : { tokensSaved: 0, savingsPercent: 0 };

    const metrics: ExecutionMetrics = {
      executionId,
      timestamp: new Date(),
      durationMs,
      success,
      codeTokens,
      resultTokens,
      toolCalls,
      dataProcessedBytes,
      resultSizeBytes,
      estimatedTokensSaved: savings.tokensSaved,
      savingsPercent: savings.savingsPercent,
      mode,
      serversUsed,
      toolsUsed,
    };

    // Store execution
    this.executions.push(metrics);

    // Trim old executions if needed
    if (this.executions.length > this.maxStoredExecutions) {
      this.executions = this.executions.slice(-this.maxStoredExecutions);
    }

    // Emit event
    this.emit('execution', metrics);

    // Log to file if enabled
    if (this.config.logToFile && this.logPath) {
      this.logToFile(metrics, errorType);
    }

    logger.debug('Execution recorded', {
      executionId,
      tokensSaved: savings.tokensSaved,
      savingsPercent: savings.savingsPercent,
      mode,
    });

    return metrics;
  }

  /**
   * Log metrics to file
   */
  private logToFile(metrics: ExecutionMetrics, errorType?: string): void {
    if (!this.logPath) return;

    const logEntry = {
      ...metrics,
      errorType,
      timestamp: metrics.timestamp.toISOString(),
    };

    const line = JSON.stringify(logEntry) + '\n';

    try {
      appendFileSync(this.logPath, line);
    } catch (error) {
      logger.error('Failed to write metrics to file', { error, path: this.logPath });
    }
  }

  /**
   * Get aggregated session metrics
   */
  getSessionMetrics(): SessionMetrics {
    const now = new Date();
    const uptime = now.getTime() - this.sessionStart.getTime();

    // Initialize aggregates
    const toolCallsByServer: Record<string, number> = {};
    const toolCallsByTool: Record<string, number> = {};
    const errorsByType: Record<string, number> = {};

    let totalDataProcessedBytes = 0;
    let totalResultBytes = 0;
    let totalCodeTokens = 0;
    let totalResultTokens = 0;
    let totalTokensSaved = 0;
    let totalDurationMs = 0;
    let minDurationMs = Number.MAX_SAFE_INTEGER;
    let maxDurationMs = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;
    let totalToolCalls = 0;
    let executionModeCount = 0;
    let passthroughModeCount = 0;
    let totalErrors = 0;
    let totalSavingsPercent = 0;

    let lastActivity = this.sessionStart;

    for (const exec of this.executions) {
      // Update last activity
      if (exec.timestamp > lastActivity) {
        lastActivity = exec.timestamp;
      }

      // Count successes/failures
      if (exec.success) {
        successfulExecutions++;
      } else {
        failedExecutions++;
        totalErrors++;
      }

      // Aggregate data
      totalDataProcessedBytes += exec.dataProcessedBytes;
      totalResultBytes += exec.resultSizeBytes;
      totalCodeTokens += exec.codeTokens;
      totalResultTokens += exec.resultTokens;
      totalTokensSaved += exec.estimatedTokensSaved;
      totalDurationMs += exec.durationMs;
      totalSavingsPercent += exec.savingsPercent;

      // Duration tracking
      if (exec.durationMs < minDurationMs) minDurationMs = exec.durationMs;
      if (exec.durationMs > maxDurationMs) maxDurationMs = exec.durationMs;

      // Tool call tracking
      totalToolCalls += exec.toolCalls;

      // Count unique servers used per execution
      const uniqueServers = new Set(exec.serversUsed);
      for (const server of uniqueServers) {
        toolCallsByServer[server] = (toolCallsByServer[server] || 0) + 1;
      }

      // Count unique tools used per execution
      const uniqueTools = new Set(exec.toolsUsed);
      for (const tool of uniqueTools) {
        toolCallsByTool[tool] = (toolCallsByTool[tool] || 0) + 1;
      }

      // Mode tracking
      if (exec.mode === 'execution') {
        executionModeCount++;
      } else {
        passthroughModeCount++;
      }
    }

    const totalExecutions = this.executions.length;
    const avgDuration = totalExecutions > 0 ? totalDurationMs / totalExecutions : 0;
    const avgTokensSaved = totalExecutions > 0 ? totalTokensSaved / totalExecutions : 0;
    const avgSavingsPercent = totalExecutions > 0 ? totalSavingsPercent / totalExecutions : 0;
    const avgDataPerExecution = totalExecutions > 0 ? totalDataProcessedBytes / totalExecutions : 0;

    // Estimate what direct mode would have used
    const totalEstimatedDirectTokens = this.executions.reduce((sum, exec) => {
      return sum + this.estimatePassthroughTokens(exec.toolCalls, exec.dataProcessedBytes);
    }, 0);

    return {
      sessionId: this.sessionId,
      sessionStart: this.sessionStart,
      lastActivity,
      uptime,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      totalToolCalls,
      toolCallsByServer,
      toolCallsByTool,
      totalDataProcessedBytes,
      totalResultBytes,
      averageDataPerExecution: avgDataPerExecution,
      totalCodeTokens,
      totalResultTokens,
      totalEstimatedDirectTokens,
      totalTokensSaved,
      averageTokensSaved: avgTokensSaved,
      averageSavingsPercent: avgSavingsPercent,
      totalDurationMs,
      averageDurationMs: avgDuration,
      minDurationMs: totalExecutions > 0 ? minDurationMs : 0,
      maxDurationMs,
      executionModeCount,
      passthroughModeCount,
      totalErrors,
      errorsByType,
    };
  }

  /**
   * Get windowed metrics for trend analysis
   */
  getWindowedMetrics(windowMs: number = 60000): WindowedMetrics[] {
    if (this.executions.length === 0) return [];

    const windows: WindowedMetrics[] = [];
    const now = new Date();

    // Group executions by time window
    const windowGroups = new Map<number, ExecutionMetrics[]>();

    for (const exec of this.executions) {
      const windowKey = Math.floor(exec.timestamp.getTime() / windowMs) * windowMs;
      if (!windowGroups.has(windowKey)) {
        windowGroups.set(windowKey, []);
      }
      windowGroups.get(windowKey)!.push(exec);
    }

    // Calculate metrics for each window
    for (const [windowStart, execs] of windowGroups.entries()) {
      const tokensSaved = execs.reduce((sum, e) => sum + e.estimatedTokensSaved, 0);
      const totalDuration = execs.reduce((sum, e) => sum + e.durationMs, 0);
      const successCount = execs.filter(e => e.success).length;

      windows.push({
        windowStart: new Date(windowStart),
        windowEnd: new Date(windowStart + windowMs),
        windowDurationMs: windowMs,
        executions: execs.length,
        tokensSaved,
        averageDurationMs: execs.length > 0 ? totalDuration / execs.length : 0,
        successRate: execs.length > 0 ? (successCount / execs.length) * 100 : 0,
      });
    }

    return windows.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
  }

  /**
   * Get recent executions
   */
  getRecentExecutions(limit: number = 10): ExecutionMetrics[] {
    return this.executions.slice(-limit);
  }

  /**
   * Get top servers by usage
   */
  getTopServers(limit: number = 5): Array<{ server: string; calls: number }> {
    const metrics = this.getSessionMetrics();
    return Object.entries(metrics.toolCallsByServer)
      .map(([server, calls]) => ({ server, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
  }

  /**
   * Get top tools by usage
   */
  getTopTools(limit: number = 5): Array<{ tool: string; calls: number }> {
    const metrics = this.getSessionMetrics();
    return Object.entries(metrics.toolCallsByTool)
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
  }

  /**
   * Export metrics to JSON
   */
  exportToJson(): string {
    return JSON.stringify({
      session: this.getSessionMetrics(),
      executions: this.executions,
      windowedMetrics: this.getWindowedMetrics(),
    }, null, 2);
  }

  /**
   * Save metrics snapshot to file
   */
  saveSnapshot(path: string): void {
    const data = this.exportToJson();
    writeFileSync(path, data);
    logger.info('Metrics snapshot saved', { path });
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.sessionId = this.generateSessionId();
    this.sessionStart = new Date();
    this.executions = [];
    this.emit('reset');
  }

  /**
   * Check if metrics collection is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Global metrics collector instance
let globalMetricsCollector: MetricsCollector | null = null;

/**
 * Get or create the global metrics collector
 */
export function getMetricsCollector(config?: MetricsConfig): MetricsCollector {
  if (!globalMetricsCollector && !config) {
    throw new Error('Metrics collector not initialised. Provide config on first call.');
  }
  if (!globalMetricsCollector && config) {
    globalMetricsCollector = new MetricsCollector(config);
  }
  return globalMetricsCollector!;
}

/**
 * Shutdown the global metrics collector
 */
export function shutdownMetricsCollector(): void {
  if (globalMetricsCollector) {
    globalMetricsCollector.removeAllListeners();
    globalMetricsCollector = null;
  }
}
