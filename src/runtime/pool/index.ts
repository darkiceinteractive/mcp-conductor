/**
 * Runtime pool — warm Deno worker pool for low-latency code execution.
 * @module runtime/pool
 */

export { WorkerPool } from './worker-pool.js';
export type { WorkerPoolOptions, PoolExecuteOptions } from './worker-pool.js';

export { PooledWorker } from './worker.js';
export type { WorkerOptions, WorkerJob, WorkerResult, WorkerState } from './worker.js';

export { evaluateRecycle, isEligible } from './recycle.js';
export type { RecycleCandidate, RecycleDecision } from './recycle.js';
