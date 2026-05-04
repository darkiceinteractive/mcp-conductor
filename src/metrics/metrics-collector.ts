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

// ─── Token Savings constants (public, shared with fixtures and benchmarks) ────

/** Per-call overhead tokens (request + response envelope) */
export const TOOL_CALL_OVERHEAD_TOKENS = 150;

/** Tokens per KB of raw passthrough data (~4 bytes per token) */
export const TOKENS_PER_KB = 256;

/** Characters per token for TypeScript/JavaScript code */
export const CODE_CHARS_PER_TOKEN = 3.5;

/** Characters per token for JSON result payloads */
export const JSON_CHARS_PER_TOKEN = 3.8;

// ─── TokenSavings types ───────────────────────────────────────────────────────

/**
 * Input parameters for the token savings computation.
 * All four values must come from the same execute_code call.
 */
export interface TokenSavingsInput {
  /** Number of MCP tool calls made inside the sandbox */
  toolCalls: number;
  /** Total bytes of raw data processed (would be in context in passthrough) */
  dataProcessedBytes: number;
  /** Character count of the user code submitted to execute_code */
  codeChars: number;
  /** Byte length of the JSON-serialised result returned from the sandbox */
  resultBytes: number;
}

/**
 * Token savings block returned by computeTokenSavings() and attached to
 * execute_code responses when show_token_savings is true.
 */
export interface TokenSavings {
  /** Estimated tokens if every tool call result had been placed in context */
  estimatedPassthroughTokens: number;
  /** Actual tokens consumed by execution mode (code + result) */
  actualExecutionTokens: number;
  /** Tokens saved: passthrough - execution (clamped to >= 0) */
  tokensSaved: number;
  /** Percentage savings, rounded to one decimal place */
  savingsPercent: number;
  /**
   * Human-readable note. Populated for passthrough-mode tools to signal
   * the savings estimate is not applicable.
   */
  note?: string;
}

/**
 * Per-tool aggregation bucket used by the session-level reporter.
 * @internal
 */
export interface ToolSavingsBucket {
  server: string;
  tool: string;
  calls: number;
  totalActualTokens: number;
  totalEstimatedPassthroughTokens: number;
  isPassthrough: boolean;
}

/**
 * Session-level token savings block returned by getTokenSavings().
 */
export interface SessionTokenSavings {
  /** Total actual tokens across all execute_code calls this session */
  sessionActual: number;
  /** Total estimated passthrough tokens across all calls this session */
  sessionEstimatedDirect: number;
  /** Overall savings percentage this session */
  sessionSavingsPercent: number;
  /** Per-tool breakdown (server x tool) */
  perTool: Array<{
    server: string;
    tool: string;
    calls: number;
    actualTokens: number;
    estimatedPassthroughTokens: number;
    savingsPercent: number;
    note?: string;
  }>;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute token savings for a single execute_code invocation.
 *
 * This is a **pure function** — it does not mutate any collector state and can
 * be called independently without an active MetricsCollector instance.
 *
 * Formula (mirrors MetricsCollector.estimatePassthroughTokens / calculateTokenSavings):
 *   passthroughTokens = (toolCalls x 150) + (dataProcessedBytes / 1024 x 256)
 *   executionTokens   = ceil(codeChars / 3.5) + ceil(resultBytes / 3.8)
 *
 * Caveats:
 *   - 256 tokens/KB is an observed average; actual tokeniser output varies.
 *   - Per-call overhead (150 tokens) dominates for tiny responses; savings may
 *     appear negative when overhead > data tokens. tokensSaved is clamped to 0.
 *   - For passthrough-mode tools set toolCalls=0, dataProcessedBytes=0;
 *     the note field will indicate savings are not applicable.
 *   - For mutation tools (write, upsert) the number is informational only.
 *
 * @param input - The four metrics from an execute_code call
 * @returns A TokenSavings block suitable for embedding in a tool response
 */
export function computeTokenSavings(input: TokenSavingsInput): TokenSavings {
  const { toolCalls, dataProcessedBytes, codeChars, resultBytes } = input;

  const estimatedPassthroughTokens = Math.ceil(
    toolCalls * TOOL_CALL_OVERHEAD_TOKENS + (dataProcessedBytes / 1024) * TOKENS_PER_KB,
  );

  const actualExecutionTokens =
    Math.ceil(codeChars / CODE_CHARS_PER_TOKEN) +
    Math.ceil(resultBytes / JSON_CHARS_PER_TOKEN);

  const tokensSaved = Math.max(0, estimatedPassthroughTokens - actualExecutionTokens);

  const savingsPercent =
    estimatedPassthroughTokens > 0
      ? Math.round((tokensSaved / estimatedPassthroughTokens) * 1000) / 10
      : 0;

  // Passthrough-mode tool: no tool calls and no data — savings not applicable.
  if (toolCalls === 0 && dataProcessedBytes === 0) {
    return {
      estimatedPassthroughTokens,
      actualExecutionTokens,
      tokensSaved: 0,
      savingsPercent: 0,
      note: 'This tool is passthrough — execute_code routing not applicable.',
    };
  }

  return {
    estimatedPassthroughTokens,
    actualExecutionTokens,
    tokensSaved,
    savingsPercent,
  };
}

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
  /** Per-tool aggregation for the token savings reporter (Mode B). */
  private toolSavingsBuckets: Map<string, ToolSavingsBucket> = new Map();

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
   * Record a single MCP tool call for per-tool savings aggregation (Mode B).
   *
   * Call this once per tool call that passes through the hub. The server and
   * tool names form the bucket key; responseBytes is the raw JSON response size
   * that would have been placed in the context window in passthrough mode.
   *
   * @param server        - MCP server name (e.g. "google-drive")
   * @param tool          - Tool name (e.g. "export_file")
   * @param responseBytes - Byte length of the tool response payload
   * @param isPassthrough - True when this server/tool routes as passthrough
   */
  recordToolCall(
    server: string,
    tool: string,
    responseBytes: number,
    isPassthrough: boolean,
  ): void {
    const key = `${server}::${tool}`;
    const existing = this.toolSavingsBuckets.get(key);

    // Compute the per-call token cost for this tool call in each mode.
    const passthroughTokens = Math.ceil(
      TOOL_CALL_OVERHEAD_TOKENS + (responseBytes / 1024) * TOKENS_PER_KB,
    );
    // Execution mode has no per-call cost for individual tools — the overhead
    // is already captured in the code+result tokens of the execute_code call.
    // We record 0 so the per-tool diff correctly reflects passthrough cost.
    const executionTokens = 0;

    if (existing) {
      existing.calls += 1;
      existing.totalEstimatedPassthroughTokens += passthroughTokens;
      existing.totalActualTokens += executionTokens;
    } else {
      this.toolSavingsBuckets.set(key, {
        server,
        tool,
        calls: 1,
        totalEstimatedPassthroughTokens: passthroughTokens,
        totalActualTokens: executionTokens,
        isPassthrough,
      });
    }
  }

  /**
   * Return the session-level token savings block for the get_metrics reporter
   * (Mode B). Aggregates across all recordExecution() calls.
   *
   * The session totals are derived from the existing executions array (which
   * already tracks estimatedTokensSaved and the direct-mode estimate) so they
   * are always consistent with getSessionMetrics().
   */
  getTokenSavings(): SessionTokenSavings {
    const sessionMetrics = this.getSessionMetrics();

    const sessionActual =
      sessionMetrics.totalCodeTokens + sessionMetrics.totalResultTokens;
    const sessionEstimatedDirect = sessionMetrics.totalEstimatedDirectTokens;
    const totalSaved = Math.max(0, sessionEstimatedDirect - sessionActual);
    const sessionSavingsPercent =
      sessionEstimatedDirect > 0
        ? Math.round((totalSaved / sessionEstimatedDirect) * 1000) / 10
        : 0;

    const perTool = Array.from(this.toolSavingsBuckets.values()).map((bucket) => {
      const saved = Math.max(
        0,
        bucket.totalEstimatedPassthroughTokens - bucket.totalActualTokens,
      );
      const pct =
        bucket.totalEstimatedPassthroughTokens > 0
          ? Math.round((saved / bucket.totalEstimatedPassthroughTokens) * 1000) / 10
          : 0;
      return {
        server: bucket.server,
        tool: bucket.tool,
        calls: bucket.calls,
        actualTokens: bucket.totalActualTokens,
        estimatedPassthroughTokens: bucket.totalEstimatedPassthroughTokens,
        savingsPercent: pct,
        ...(bucket.isPassthrough
          ? { note: 'This tool is passthrough — execute_code routing not applicable.' }
          : {}),
      };
    });

    return {
      sessionActual,
      sessionEstimatedDirect,
      sessionSavingsPercent,
      perTool,
    };
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
