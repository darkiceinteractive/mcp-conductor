/**
 * Structured error classes for the reliability layer.
 *
 * All reliability errors carry `server`, `tool`, and `attempts` so the
 * caller (hub, sandbox) can surface actionable context without string-parsing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// MCPToolError — wraps upstream backend errors (amendment from consolidated plan)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured wrapper for any error thrown by a backend MCP tool call.
 *
 * Hub.callTool re-throws every upstream error as MCPToolError so the sandbox
 * can catch by class and inspect structured fields without string-parsing.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await mcp.ibkr.get_portfolio({});
 * } catch (e) {
 *   if (e instanceof MCPToolError && e.code === 'contract_not_found') {
 *     // handle known error code
 *   }
 * }
 * ```
 */
export class MCPToolError extends Error {
  override readonly name = 'MCPToolError';

  constructor(
    /** Upstream error code string, if available. Falls back to 'UNKNOWN'. */
    public readonly code: string,
    /** Backend server name (e.g. 'ibkr', 'github') */
    public readonly server: string,
    /** Tool name (e.g. 'get_portfolio') */
    public readonly tool: string,
    /** Original error object — preserve full upstream context */
    public readonly upstream: unknown
  ) {
    super(`[${server}.${tool}] ${code}`);
    // Maintain proper prototype chain for instanceof checks across module boundaries
    Object.setPrototypeOf(this, MCPToolError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TimeoutError
// ─────────────────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(
    public readonly server: string,
    public readonly tool: string,
    public readonly timeoutMs: number,
    public readonly attempts: number
  ) {
    super(`[${server}.${tool}] timed out after ${timeoutMs}ms (attempt ${attempts})`);
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RetryExhaustedError
// ─────────────────────────────────────────────────────────────────────────────

export class RetryExhaustedError extends Error {
  override readonly name = 'RetryExhaustedError';

  constructor(
    public readonly server: string,
    public readonly tool: string,
    public readonly attempts: number,
    public readonly lastError: unknown
  ) {
    const cause =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(`[${server}.${tool}] exhausted ${attempts} attempt(s): ${cause}`);
    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CircuitOpenError
// ─────────────────────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';

  constructor(
    public readonly server: string,
    public readonly tool: string,
    public readonly attempts: number = 0
  ) {
    super(`[${server}.${tool}] circuit open — failing fast`);
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract an error code string from an unknown thrown value.
 * Used by hub.callTool when constructing MCPToolError.
 */
export function extractErrorCode(err: unknown): string {
  if (err instanceof MCPToolError) return err.code;
  if (err instanceof TimeoutError) return 'TIMEOUT';
  if (err instanceof CircuitOpenError) return 'CIRCUIT_OPEN';
  if (err instanceof RetryExhaustedError) return 'RETRY_EXHAUSTED';
  if (err && typeof err === 'object') {
    // MCP SDK errors often carry a `code` field
    const obj = err as Record<string, unknown>;
    if (typeof obj['code'] === 'string') return obj['code'];
    if (typeof obj['code'] === 'number') return String(obj['code']);
  }
  if (err instanceof Error) return err.message || 'ERROR';
  return 'UNKNOWN';
}

/**
 * Returns true for errors that are safe to retry (transient failures).
 * Mutations always receive retries=0 at the profile level, so this only
 * matters for read operations.
 */
export function isRetryable(err: unknown): boolean {
  // Never retry if the circuit is already open — it's a fast-fail, not a transient error
  if (err instanceof CircuitOpenError) return false;
  // Never double-wrap MCPToolErrors — let them propagate
  if (err instanceof MCPToolError) return false;
  // Timeouts are retryable
  if (err instanceof TimeoutError) return true;
  // Generic network-level errors are retryable
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout') ||
      msg.includes('socket') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused')
    );
  }
  return false;
}
