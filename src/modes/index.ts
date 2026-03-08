/**
 * Execution modes — `execution` (sandbox-first), `passthrough` (direct tool
 * calls), and `hybrid` (automatic switching based on complexity heuristics).
 * @module modes
 */

export {
  ModeHandler,
  getModeHandler,
  shutdownModeHandler,
  type ModeMetrics,
  type PassthroughToolCall,
  type HybridDecision,
  type ModeHandlerConfig,
} from './mode-handler.js';
