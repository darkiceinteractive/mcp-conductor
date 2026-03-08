/**
 * Mode Handler
 *
 * Manages operation modes for the MCP Executor:
 * - execution: All requests go through code execution (maximum token savings)
 * - passthrough: Direct tool exposure from connected MCP servers
 * - hybrid: Automatic selection based on task complexity
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/index.js';
import type { ExecutionMode } from '../config/index.js';

export interface ModeMetrics {
  executionCalls: number;
  passthroughCalls: number;
  hybridAutoExecutions: number;
  hybridAutoPassthroughs: number;
  tokensSavedEstimate: number;
}

export interface PassthroughToolCall {
  server: string;
  tool: string;
  params: Record<string, unknown>;
  timestamp: Date;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export interface HybridDecision {
  task: string;
  decision: 'execution' | 'passthrough';
  reason: string;
  confidence: number;
}

export interface ModeHandlerConfig {
  /** Default operation mode */
  defaultMode: ExecutionMode;
  /** Hybrid mode threshold - tool calls above this use execution mode */
  hybridToolCallThreshold: number;
  /** Hybrid mode threshold - data above this KB uses execution mode */
  hybridDataThreshold: number;
}

/**
 * Handles operation mode logic and tracking
 */
export class ModeHandler extends EventEmitter {
  private currentMode: ExecutionMode;
  private config: ModeHandlerConfig;
  private metrics: ModeMetrics;
  private recentPassthroughCalls: PassthroughToolCall[] = [];
  private maxRecentCalls = 100;

  constructor(config: Partial<ModeHandlerConfig> = {}) {
    super();
    this.config = {
      defaultMode: 'execution',
      hybridToolCallThreshold: 3,
      hybridDataThreshold: 5,
      ...config,
    };
    this.currentMode = this.config.defaultMode;
    this.metrics = {
      executionCalls: 0,
      passthroughCalls: 0,
      hybridAutoExecutions: 0,
      hybridAutoPassthroughs: 0,
      tokensSavedEstimate: 0,
    };
  }

  /**
   * Get current operation mode
   */
  getMode(): ExecutionMode {
    return this.currentMode;
  }

  /**
   * Set operation mode
   */
  setMode(mode: ExecutionMode): ExecutionMode {
    const previousMode = this.currentMode;
    this.currentMode = mode;

    if (previousMode !== mode) {
      logger.info('Operation mode changed', { from: previousMode, to: mode });
      this.emit('modeChanged', { previousMode, currentMode: mode });
    }

    return previousMode;
  }

  /**
   * Check if passthrough mode is active
   */
  isPassthroughMode(): boolean {
    return this.currentMode === 'passthrough';
  }

  /**
   * Check if execution mode is active
   */
  isExecutionMode(): boolean {
    return this.currentMode === 'execution';
  }

  /**
   * Check if hybrid mode is active
   */
  isHybridMode(): boolean {
    return this.currentMode === 'hybrid';
  }

  /**
   * Decide which mode to use for a task (hybrid mode logic)
   */
  decideMode(task: {
    description?: string;
    estimatedToolCalls?: number;
    estimatedDataKb?: number;
    toolNames?: string[];
  }): HybridDecision {
    const { estimatedToolCalls = 1, estimatedDataKb = 0, description = '' } = task;

    // Simple heuristics for hybrid mode
    let decision: 'execution' | 'passthrough' = 'passthrough';
    let reason = '';
    let confidence = 0.5;

    // Check tool call count
    if (estimatedToolCalls > this.config.hybridToolCallThreshold) {
      decision = 'execution';
      reason = `Multiple tool calls expected (${estimatedToolCalls})`;
      confidence = 0.8;
    }
    // Check data volume
    else if (estimatedDataKb > this.config.hybridDataThreshold) {
      decision = 'execution';
      reason = `Large data volume expected (${estimatedDataKb}KB)`;
      confidence = 0.75;
    }
    // Check for data processing keywords
    else if (this.containsProcessingKeywords(description)) {
      decision = 'execution';
      reason = 'Task involves data processing';
      confidence = 0.7;
    }
    // Default to passthrough for simple tasks
    else {
      decision = 'passthrough';
      reason = 'Simple task suitable for direct tool calls';
      confidence = 0.6;
    }

    // Update metrics
    if (decision === 'execution') {
      this.metrics.hybridAutoExecutions++;
    } else {
      this.metrics.hybridAutoPassthroughs++;
    }

    const result: HybridDecision = {
      task: description || 'Unknown task',
      decision,
      reason,
      confidence,
    };

    this.emit('hybridDecision', result);
    return result;
  }

  /**
   * Check if description contains data processing keywords
   */
  private containsProcessingKeywords(description: string): boolean {
    const keywords = [
      'filter',
      'aggregate',
      'summarise',
      'summarize',
      'analyse',
      'analyze',
      'process',
      'transform',
      'combine',
      'merge',
      'calculate',
      'compute',
      'iterate',
      'loop',
      'multiple',
      'batch',
      'bulk',
    ];
    const lower = description.toLowerCase();
    return keywords.some((k) => lower.includes(k));
  }

  /**
   * Record an execution mode call
   */
  recordExecutionCall(tokensSaved: number = 0): void {
    this.metrics.executionCalls++;
    this.metrics.tokensSavedEstimate += tokensSaved;
  }

  /**
   * Record a passthrough mode call
   */
  recordPassthroughCall(call: Omit<PassthroughToolCall, 'timestamp'>): void {
    this.metrics.passthroughCalls++;

    const record: PassthroughToolCall = {
      ...call,
      timestamp: new Date(),
    };

    this.recentPassthroughCalls.push(record);

    // Trim old calls
    if (this.recentPassthroughCalls.length > this.maxRecentCalls) {
      this.recentPassthroughCalls.shift();
    }

    this.emit('passthroughCall', record);
  }

  /**
   * Get mode metrics
   */
  getMetrics(): ModeMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      executionCalls: 0,
      passthroughCalls: 0,
      hybridAutoExecutions: 0,
      hybridAutoPassthroughs: 0,
      tokensSavedEstimate: 0,
    };
    this.recentPassthroughCalls = [];
  }

  /**
   * Get recent passthrough calls
   */
  getRecentPassthroughCalls(): PassthroughToolCall[] {
    return [...this.recentPassthroughCalls];
  }

  /**
   * Generate tool prefix for passthrough mode
   */
  generatePassthroughToolName(serverName: string, toolName: string): string {
    return `${serverName}__${toolName}`;
  }

  /**
   * Parse a passthrough tool name back to server and tool
   */
  parsePassthroughToolName(combinedName: string): { server: string; tool: string } | null {
    const parts = combinedName.split('__');
    if (parts.length !== 2) return null;
    const server = parts[0];
    const tool = parts[1];
    if (!server || !tool) return null;
    return { server, tool };
  }

  /**
   * Get effective mode for a request (handles hybrid auto-selection)
   */
  getEffectiveMode(task?: {
    description?: string;
    estimatedToolCalls?: number;
    estimatedDataKb?: number;
  }): 'execution' | 'passthrough' {
    if (this.currentMode === 'execution') return 'execution';
    if (this.currentMode === 'passthrough') return 'passthrough';

    // Hybrid mode - decide automatically
    if (task) {
      const decision = this.decideMode(task);
      return decision.decision;
    }

    // Default to execution for hybrid without task info
    return 'execution';
  }
}

// Global mode handler instance
let globalModeHandler: ModeHandler | null = null;

/**
 * Get or create the global mode handler
 */
export function getModeHandler(config?: Partial<ModeHandlerConfig>): ModeHandler {
  if (!globalModeHandler) {
    globalModeHandler = new ModeHandler(config);
  }
  return globalModeHandler;
}

/**
 * Shutdown the global mode handler
 */
export function shutdownModeHandler(): void {
  if (globalModeHandler) {
    globalModeHandler.removeAllListeners();
    globalModeHandler = null;
  }
}
