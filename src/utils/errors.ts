/**
 * Custom error hierarchy for MCP Conductor.
 *
 * All errors extend {@link ExecutionError}, which carries a discriminated
 * `type` field so callers can pattern-match without `instanceof` checks.
 * The `toJSON()` method produces a serialisable representation suitable
 * for returning in MCP tool error responses.
 *
 * @module utils/errors
 */

/** Discriminated union of all error categories. */
export type ErrorType = 'syntax' | 'runtime' | 'timeout' | 'security' | 'connection' | 'tool_not_found' | 'server_not_found';

/** Base error for all sandbox execution failures. */
export class ExecutionError extends Error {
  public readonly type: ErrorType;
  public readonly line?: number;
  public readonly stack?: string;

  constructor(type: ErrorType, message: string, options?: { line?: number; stack?: string }) {
    super(message);
    this.name = 'ExecutionError';
    this.type = type;
    this.line = options?.line;
    if (options?.stack) {
      this.stack = options.stack;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      message: this.message,
      line: this.line,
      stack: this.stack,
    };
  }
}

/** Raised when user-supplied TypeScript fails to parse. */
export class SyntaxError extends ExecutionError {
  constructor(message: string, line?: number) {
    super('syntax', message, { line });
    this.name = 'SyntaxError';
  }
}

/** Raised when code throws an unhandled exception during execution. */
export class RuntimeError extends ExecutionError {
  constructor(message: string, stack?: string) {
    super('runtime', message, { stack });
    this.name = 'RuntimeError';
  }
}

/** Raised when a sandbox execution exceeds its configured timeout. */
export class TimeoutError extends ExecutionError {
  constructor(timeoutMs: number) {
    super('timeout', `Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Raised when sandbox code attempts a disallowed operation (e.g. net access). */
export class SecurityError extends ExecutionError {
  constructor(message: string) {
    super('security', message);
    this.name = 'SecurityError';
  }
}

/** Raised when a backend MCP server fails to connect or respond. */
export class ConnectionError extends ExecutionError {
  constructor(serverName: string, message: string) {
    super('connection', `Failed to connect to server '${serverName}': ${message}`);
    this.name = 'ConnectionError';
  }
}

/** Raised when sandbox code calls a tool that does not exist on the target server. */
export class ToolNotFoundError extends ExecutionError {
  constructor(serverName: string, toolName: string) {
    super('tool_not_found', `Tool '${toolName}' not found on server '${serverName}'`);
    this.name = 'ToolNotFoundError';
  }
}

/** Raised when sandbox code references a server name not in the conductor config. */
export class ServerNotFoundError extends ExecutionError {
  constructor(serverName: string) {
    super('server_not_found', `Server '${serverName}' not found`);
    this.name = 'ServerNotFoundError';
  }
}
