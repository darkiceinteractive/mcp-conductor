/**
 * Mode Comparator Utilities
 *
 * Utilities for comparing execution modes in MCP Conductor.
 */

import { measureTime } from './test-utils.js';
import {
  calculateTokenSavings,
  estimateTokens,
  type TokenSavingsResult,
} from './token-counter.js';

export type ExecutionMode = 'execution' | 'passthrough' | 'hybrid';

/**
 * Result of executing code in a specific mode
 */
export interface ModeExecutionResult {
  mode: ExecutionMode;
  result: unknown;
  durationMs: number;
  error?: string;
  toolCalls: number;
  tokenEstimate: number;
}

/**
 * Comparison result between modes
 */
export interface ModeComparisonResult {
  execution?: ModeExecutionResult;
  passthrough?: ModeExecutionResult;
  hybrid?: ModeExecutionResult;
  tokenSavings?: TokenSavingsResult;
  hybridModeDecision?: ExecutionMode;
  recommendation: string;
}

/**
 * Mock executor for testing mode comparisons
 */
export interface MockExecutor {
  execute: (code: string, mode: ExecutionMode) => Promise<ModeExecutionResult>;
  getHybridDecision: (code: string) => ExecutionMode;
}

/**
 * Create a mock executor for testing
 */
export function createMockExecutor(handlers: {
  onExecute: (code: string) => Promise<unknown>;
  onPassthrough: (serverName: string, toolName: string, params: unknown) => Promise<unknown>;
}): MockExecutor {
  return {
    execute: async (code: string, mode: ExecutionMode): Promise<ModeExecutionResult> => {
      const start = performance.now();
      let result: unknown;
      let toolCalls = 0;
      let error: string | undefined;

      try {
        if (mode === 'passthrough') {
          // Simulate passthrough mode - direct tool calls
          // Parse simple tool calls from code (simplified for testing)
          const toolCallMatches = code.matchAll(/\.call\(['"](\w+)['"],\s*['"](\w+)['"],?\s*(\{[^}]*\})?/g);
          const calls = [...toolCallMatches];
          toolCalls = calls.length;

          // Execute each tool call
          const results = [];
          for (const [, server, tool, params] of calls) {
            const parsed = params ? JSON.parse(params.replace(/'/g, '"')) : {};
            const r = await handlers.onPassthrough(server, tool, parsed);
            results.push(r);
          }
          result = results.length === 1 ? results[0] : results;
        } else {
          // Execution or hybrid mode - run in sandbox
          result = await handlers.onExecute(code);
          // Estimate tool calls from code patterns
          toolCalls = (code.match(/\.call\(/g) || []).length;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        result = null;
      }

      const durationMs = performance.now() - start;
      const tokenEstimate = estimateTokens(JSON.stringify(result));

      return {
        mode,
        result,
        durationMs,
        error,
        toolCalls,
        tokenEstimate,
      };
    },

    getHybridDecision: (code: string): ExecutionMode => {
      // Simple heuristics for hybrid mode decision
      const toolCalls = (code.match(/\.call\(/g) || []).length;
      const hasDataProcessing =
        code.includes('.filter(') ||
        code.includes('.map(') ||
        code.includes('.reduce(') ||
        code.includes('Promise.all');

      // Use passthrough for simple single-tool calls
      if (toolCalls <= 1 && !hasDataProcessing) {
        return 'passthrough';
      }

      // Use execution for complex operations
      return 'execution';
    },
  };
}

/**
 * Compare execution results across modes
 */
export async function compareModesExecution(
  code: string,
  executor: MockExecutor,
  modes: ExecutionMode[] = ['execution', 'passthrough', 'hybrid']
): Promise<ModeComparisonResult> {
  const results: ModeComparisonResult = {
    recommendation: '',
  };

  // Execute in each mode
  for (const mode of modes) {
    const modeResult = await executor.execute(code, mode);

    if (mode === 'execution') {
      results.execution = modeResult;
    } else if (mode === 'passthrough') {
      results.passthrough = modeResult;
    } else if (mode === 'hybrid') {
      results.hybrid = modeResult;
      results.hybridModeDecision = executor.getHybridDecision(code);
    }
  }

  // Calculate token savings if we have both modes
  if (results.execution && results.passthrough) {
    const passthroughTokens = results.passthrough.tokenEstimate;
    const executionTokens = results.execution.tokenEstimate;
    const tokensSaved = Math.max(0, passthroughTokens - executionTokens);
    const percentageSaved = passthroughTokens > 0 ? (tokensSaved / passthroughTokens) * 100 : 0;

    results.tokenSavings = {
      passthroughTokens,
      executionTokens,
      tokensSaved,
      percentageSaved,
    };
  }

  // Generate recommendation
  results.recommendation = generateRecommendation(results);

  return results;
}

/**
 * Generate recommendation based on comparison results
 */
function generateRecommendation(results: ModeComparisonResult): string {
  const { execution, passthrough, tokenSavings, hybridModeDecision } = results;

  if (!execution || !passthrough) {
    return 'Insufficient data for recommendation';
  }

  const savingsThreshold = 30; // 30% savings to recommend execution mode

  if (tokenSavings && tokenSavings.percentageSaved > savingsThreshold) {
    return `Recommend EXECUTION mode: ${tokenSavings.percentageSaved.toFixed(1)}% token savings`;
  }

  if (passthrough.durationMs < execution.durationMs * 0.8) {
    return `Recommend PASSTHROUGH mode: ${((1 - passthrough.durationMs / execution.durationMs) * 100).toFixed(1)}% faster`;
  }

  if (hybridModeDecision) {
    return `Recommend HYBRID mode: Auto-selected ${hybridModeDecision} for this task`;
  }

  return 'No clear recommendation - modes perform similarly';
}

/**
 * Mode decision criteria
 */
export interface ModeDecisionCriteria {
  toolCalls: number;
  estimatedDataKb: number;
  hasDataProcessing: boolean;
  hasMultiServerCalls: boolean;
  expectedDurationMs: number;
}

/**
 * Predict optimal mode based on criteria
 */
export function predictOptimalMode(criteria: ModeDecisionCriteria): {
  mode: ExecutionMode;
  confidence: number;
  reason: string;
} {
  const { toolCalls, estimatedDataKb, hasDataProcessing, hasMultiServerCalls } = criteria;

  // Simple single-tool calls -> passthrough
  if (toolCalls === 1 && !hasDataProcessing && estimatedDataKb < 1) {
    return {
      mode: 'passthrough',
      confidence: 0.9,
      reason: 'Simple single-tool call with minimal data',
    };
  }

  // Large data aggregation -> execution
  if (estimatedDataKb > 10 || toolCalls > 3) {
    return {
      mode: 'execution',
      confidence: 0.95,
      reason: `High token savings expected (${estimatedDataKb}KB data, ${toolCalls} tools)`,
    };
  }

  // Data processing -> execution
  if (hasDataProcessing) {
    return {
      mode: 'execution',
      confidence: 0.85,
      reason: 'Data processing benefits from sandbox execution',
    };
  }

  // Multi-server calls -> execution
  if (hasMultiServerCalls) {
    return {
      mode: 'execution',
      confidence: 0.8,
      reason: 'Cross-server aggregation benefits from execution mode',
    };
  }

  // Default to hybrid for uncertain cases
  return {
    mode: 'hybrid',
    confidence: 0.6,
    reason: 'Uncertain - let hybrid mode decide at runtime',
  };
}

/**
 * Validate hybrid mode decision accuracy
 */
export function validateHybridDecision(
  actual: ExecutionMode,
  optimal: ExecutionMode,
  criteria: ModeDecisionCriteria
): { correct: boolean; analysis: string } {
  const correct = actual === optimal;

  let analysis: string;
  if (correct) {
    analysis = `Hybrid correctly chose ${actual} for this task`;
  } else {
    analysis = `Hybrid chose ${actual} but ${optimal} would be better. `;
    analysis += `Criteria: ${criteria.toolCalls} tools, ${criteria.estimatedDataKb}KB data`;
  }

  return { correct, analysis };
}

/**
 * Mode comparison summary
 */
export interface ModeComparisonSummary {
  totalTests: number;
  executionWins: number;
  passthroughWins: number;
  hybridAccuracy: number;
  averageTokenSavings: number;
  recommendations: Record<ExecutionMode, number>;
}

/**
 * Summarise multiple mode comparisons
 */
export function summariseComparisons(results: ModeComparisonResult[]): ModeComparisonSummary {
  let executionWins = 0;
  let passthroughWins = 0;
  let correctHybridDecisions = 0;
  let totalTokenSavings = 0;
  const recommendations: Record<ExecutionMode, number> = {
    execution: 0,
    passthrough: 0,
    hybrid: 0,
  };

  for (const result of results) {
    // Count wins based on token savings
    if (result.tokenSavings) {
      totalTokenSavings += result.tokenSavings.percentageSaved;
      if (result.tokenSavings.percentageSaved > 30) {
        executionWins++;
      } else {
        passthroughWins++;
      }
    }

    // Count hybrid accuracy
    if (result.hybridModeDecision && result.tokenSavings) {
      const shouldUseExecution = result.tokenSavings.percentageSaved > 30;
      const hybridChoseExecution = result.hybridModeDecision === 'execution';
      if (shouldUseExecution === hybridChoseExecution) {
        correctHybridDecisions++;
      }
    }

    // Count recommendations
    if (result.recommendation.includes('EXECUTION')) {
      recommendations.execution++;
    } else if (result.recommendation.includes('PASSTHROUGH')) {
      recommendations.passthrough++;
    } else if (result.recommendation.includes('HYBRID')) {
      recommendations.hybrid++;
    }
  }

  return {
    totalTests: results.length,
    executionWins,
    passthroughWins,
    hybridAccuracy: results.length > 0 ? (correctHybridDecisions / results.length) * 100 : 0,
    averageTokenSavings: results.length > 0 ? totalTokenSavings / results.length : 0,
    recommendations,
  };
}
