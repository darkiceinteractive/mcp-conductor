/**
 * Worker Recycle Policy
 *
 * Determines when a warm Deno worker should be replaced. Three eviction
 * triggers are evaluated in order:
 *   1. Error state — worker crashed or entered an unrecoverable error
 *   2. Age — worker has been alive longer than `maxAgeMs`
 *   3. Job count — worker has processed more than `maxJobsPerWorker` jobs
 *
 * Recycle is designed to be async-safe: the pool spawns a replacement
 * *before* terminating the old worker, ensuring capacity is never reduced
 * during normal operation.
 *
 * @module runtime/pool/recycle
 */

import type { WorkerPoolOptions } from './worker-pool.js';

export interface RecycleCandidate {
  /** Worker unique identifier */
  id: string;
  /**
   * Current state of the worker. Includes 'starting' (B7) because a
   * replacement pushed synchronously into the pool array may be evaluated
   * before its start() promise resolves. A 'starting' worker is not in an
   * error state — it falls through to age/job-count checks and isEligible()
   * returns false (state !== 'idle'), so no jobs are routed to it.
   */
  state: 'starting' | 'idle' | 'busy' | 'recycling' | 'dead';
  /** Epoch ms when the worker was created */
  createdAt: number;
  /** Total jobs run since creation */
  jobsRun: number;
}

export interface RecycleDecision {
  shouldRecycle: boolean;
  reason?: 'error' | 'age' | 'job-count';
}

/**
 * Evaluate whether a worker should be recycled based on the pool policy.
 *
 * Called by the pool after every job completion and after any error event.
 * When `shouldRecycle` is true, the pool spawns a replacement then calls
 * `worker.shutdown(drainFirst=false)` on the old worker.
 */
export function evaluateRecycle(
  candidate: RecycleCandidate,
  opts: Pick<WorkerPoolOptions, 'maxJobsPerWorker' | 'maxAgeMs'>
): RecycleDecision {
  // Error state always recycles
  if (candidate.state === 'dead' || candidate.state === 'recycling') {
    return { shouldRecycle: true, reason: 'error' };
  }

  const now = Date.now();
  const ageMs = now - candidate.createdAt;
  const maxAge = opts.maxAgeMs ?? 600_000;
  const maxJobs = opts.maxJobsPerWorker ?? 100;

  if (ageMs >= maxAge) {
    return { shouldRecycle: true, reason: 'age' };
  }

  if (candidate.jobsRun >= maxJobs) {
    return { shouldRecycle: true, reason: 'job-count' };
  }

  return { shouldRecycle: false };
}

/**
 * Return true if a worker is eligible to receive new jobs
 * (idle and not scheduled for recycle).
 */
export function isEligible(
  candidate: RecycleCandidate,
  opts: Pick<WorkerPoolOptions, 'maxJobsPerWorker' | 'maxAgeMs'>
): boolean {
  if (candidate.state !== 'idle') return false;
  const { shouldRecycle } = evaluateRecycle(candidate, opts);
  return !shouldRecycle;
}
