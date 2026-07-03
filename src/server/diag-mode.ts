/**
 * Diagnostic-trailer mode for mcp-conductor.
 *
 * When enabled, every execute_code and passthrough call result gets a
 * structured telemetry block appended showing wall time, byte counts, and
 * estimated token savings. Mirrors the existing set_compare_mode pattern.
 *
 * Three modes:
 *   - off (default): zero overhead, early return in renderDiagTrailer
 *   - summary: single-line trailer (~80 tokens/call)
 *   - verbose: multi-line breakdown (~250 tokens/call)
 *
 * Process-local; resets to 'off' on restart.
 *
 * @module server/diag-mode
 */

// ---------------------------------------------------------------------------
// Constants — shared with metrics-collector.ts
// ---------------------------------------------------------------------------

/** Per-call overhead tokens (request + response envelope) */
const TOOL_CALL_OVERHEAD_TOKENS = 150;

/** Tokens per KB of raw passthrough data */
const TOKENS_PER_KB = 256;

/** Characters per token for TypeScript/JavaScript code */
const CODE_CHARS_PER_TOKEN = 3.5;

/** Characters per token for JSON result payloads */
const JSON_CHARS_PER_TOKEN = 3.8;

// ---------------------------------------------------------------------------
// Mode state
// ---------------------------------------------------------------------------

export type DiagMode = 'off' | 'summary' | 'verbose';

let currentMode: DiagMode = 'off';

/**
 * Set the process-local diagnostic mode. Returns the new mode.
 */
export function setDiagMode(mode: DiagMode): DiagMode {
  currentMode = mode;
  return currentMode;
}

/**
 * Get the current diagnostic mode.
 */
export function getDiagMode(): DiagMode {
  return currentMode;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** Per-child-call trace (execute_code verbose, future work). */
export interface ChildCallTrace {
  server: string;
  tool: string;
  wallMs: number;
  rawBytes: number;
}

/**
 * Payload collected at the call site and passed to renderDiagTrailer.
 * All optional fields are omitted from the trailer when absent.
 */
export interface DiagPayload {
  /** Which conductor handler produced this call. */
  callType: 'execute_code' | 'passthrough' | 'passthrough_tool';
  /** Human-readable name: tool name for passthrough, "execute_code" for execute. */
  toolName: string;
  /** Total wall time for the call (ms). */
  wallMs: number;
  /** Sandbox boot time (ms), execute_code only. */
  sandboxBootMs?: number;
  /** Result-trim time (ms), execute_code only. */
  resultTrimMs?: number;
  /** Per-child call timings (deferred to follow-up; omit when empty). */
  childCalls?: ChildCallTrace[];
  /** Bytes of raw backend data that would have been in context if passthrough. */
  rawBytesIn: number;
  /** Bytes in the final result returned to the model. */
  outBytesToModel: number;
  /** Character count of the submitted code (execute_code only). */
  scriptChars?: number;
  /** Value of MCP_CONDUCTOR_CLIENT_MODEL at render time (from env). */
  clientModel?: string;
  /** Value of MCP_CONDUCTOR_CLIENT_EFFORT at render time (from env). */
  clientEffort?: string;
}

// ---------------------------------------------------------------------------
// Token formula helpers
// ---------------------------------------------------------------------------

/**
 * Estimated passthrough token cost for rawBytesIn.
 * formula: ceil((rawBytesIn / 1024) * 256) + (childCallCount || 1) * 150
 */
function estimatePassthroughTokens(rawBytesIn: number, childCallCount: number): number {
  const dataTokens = Math.ceil((rawBytesIn / 1024) * TOKENS_PER_KB);
  const callOverhead = Math.max(childCallCount, 1) * TOOL_CALL_OVERHEAD_TOKENS;
  return dataTokens + callOverhead;
}

/**
 * Estimated execution token cost.
 * formula: ceil(scriptChars / 3.5) + ceil(outBytesToModel / 3.8)
 * When scriptChars is unknown: ceil(outBytesToModel / 3.8) + 150
 */
function estimateExecutionTokens(outBytesToModel: number, scriptChars?: number): number {
  const resultTokens = Math.ceil(outBytesToModel / JSON_CHARS_PER_TOKEN);
  if (scriptChars !== undefined) {
    return Math.ceil(scriptChars / CODE_CHARS_PER_TOKEN) + resultTokens;
  }
  return resultTokens + TOOL_CALL_OVERHEAD_TOKENS;
}

/**
 * Savings percentage, clamped to [0, 99.9]. Guards div-by-zero → 0.
 */
function computeSavingsPct(passthroughTokens: number, executionTokens: number): number {
  if (passthroughTokens <= 0) return 0;
  const raw = (1 - executionTokens / passthroughTokens) * 100;
  return Math.min(99.9, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render the diagnostic trailer for a call.
 *
 * Returns '' when mode is 'off' (zero overhead, early return).
 *
 * @param payload  Telemetry collected at the call site.
 * @param mode     Current diag mode (caller should pass getDiagMode()).
 * @returns        Formatted trailer string, or '' when mode is 'off'.
 */
export function renderDiagTrailer(payload: DiagPayload, mode: DiagMode): string {
  if (mode === 'off') return '';

  // Read env hints at render time (set once per install, not per call)
  const clientModel =
    payload.clientModel ?? process.env['MCP_CONDUCTOR_CLIENT_MODEL'];
  const clientEffort =
    payload.clientEffort ?? process.env['MCP_CONDUCTOR_CLIENT_EFFORT'];

  const childCount = payload.childCalls?.length ?? 0;
  const passthroughTokens = estimatePassthroughTokens(payload.rawBytesIn, childCount);
  const executionTokens = estimateExecutionTokens(payload.outBytesToModel, payload.scriptChars);
  const savingsPct = computeSavingsPct(passthroughTokens, executionTokens);

  if (mode === 'summary') {
    let line =
      `─ [diag] wall=${payload.wallMs}ms · ` +
      `raw=${payload.rawBytesIn}b → out=${payload.outBytesToModel}b · ` +
      `est_passthrough≈${passthroughTokens}t · ` +
      `est_execution≈${executionTokens}t · ` +
      `savings≈${savingsPct.toFixed(1)}%`;

    if (clientModel) line += ` · model=${clientModel}`;
    if (clientEffort) line += ` · effort=${clientEffort}`;

    return line;
  }

  // verbose
  const lines: string[] = [`─ [diag] ${payload.callType}`];

  // wall time line — include sub-timings when present
  const wallParts: string[] = [`${payload.wallMs}ms`];
  if (payload.sandboxBootMs !== undefined) wallParts.push(`sandbox ${payload.sandboxBootMs}ms`);
  if (payload.resultTrimMs !== undefined) wallParts.push(`trim ${payload.resultTrimMs}ms`);
  lines.push(`  wall:        ${wallParts.join(' · ')}`);

  // child calls section (only when present)
  if (payload.childCalls && payload.childCalls.length > 0) {
    lines.push(`  child calls:`);
    for (const c of payload.childCalls) {
      const serverTool = `${c.server}.${c.tool}`;
      lines.push(`    ${serverTool.padEnd(24)}${String(c.wallMs).padStart(5)}ms  ${c.rawBytes}b`);
    }
  }

  // bytes line
  const reductionPct = payload.rawBytesIn > 0
    ? Math.round((1 - payload.outBytesToModel / payload.rawBytesIn) * 100)
    : 0;
  lines.push(
    `  bytes:       raw ${payload.rawBytesIn} → out ${payload.outBytesToModel} (${reductionPct}% reduction)`,
  );

  // token estimates line
  lines.push(
    `  tokens est:  passthrough≈${passthroughTokens} · execute_code≈${executionTokens} · savings≈${savingsPct.toFixed(1)}%`,
  );

  // client section (only when any env hint is set)
  if (clientModel || clientEffort) {
    const clientParts: string[] = [];
    if (clientModel) clientParts.push(`model=${clientModel}`);
    if (clientEffort) clientParts.push(`effort=${clientEffort}`);
    lines.push(`  client:      ${clientParts.join(' ')}`);
  }

  return lines.join('\n');
}
