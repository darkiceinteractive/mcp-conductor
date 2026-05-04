/**
 * src/reliability — public API
 *
 * Everything a consumer needs is re-exported here. Internal modules should be
 * imported directly only within the reliability package.
 *
 * @module reliability
 */

// Profile types + helpers
export type { ReliabilityProfile, CircuitState } from './profile.js';
export { DEFAULT_PROFILE, resolveProfile, isMutation, applyMutationDefault } from './profile.js';

// Structured error classes
export {
  MCPToolError,
  TimeoutError,
  RetryExhaustedError,
  CircuitOpenError,
  extractErrorCode,
  isRetryable,
} from './errors.js';

// Circuit breaker
export type { BreakerStats } from './breaker.js';
export { CircuitBreaker } from './breaker.js';

// Retry
export type { RetryOptions } from './retry.js';
export { withRetry } from './retry.js';

// Timeout
export type { TimeoutOptions } from './timeout.js';
export { withTimeout, withTimeoutSimple } from './timeout.js';

// Gateway (primary consumer surface)
export type {
  GatewayOptions,
  ReliabilityStats,
  ServerStats,
  ToolLookup,
} from './gateway.js';
export { ReliabilityGateway } from './gateway.js';
