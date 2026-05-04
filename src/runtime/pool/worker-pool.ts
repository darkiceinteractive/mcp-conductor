/**
 * Warm Deno Worker Pool
 *
 * Maintains a fixed pool of pre-warmed Deno workers so that the first
 * execute_code call after startup hits an already-running sandbox.
 *
 * Lifecycle:
 *   1. `new WorkerPool(opts)` — configure
 *   2. `await pool.warmUp()` — spawn `size` workers concurrently
 *   3. `await pool.execute(job)` — pick idle worker, run, release
 *   4. `await pool.shutdown()` — drain in-flight jobs, terminate all workers
 *
 * Recycle policy (see recycle.ts):
 *   - After `maxJobsPerWorker` jobs the worker is replaced before termination
 *   - After `maxAgeMs` age the worker is replaced after its current job finishes
 *   - After any uncaught error the worker is replaced immediately
 *
 * Phase 5 plug-in: pass `preloadHelpers` to `WorkerPoolOptions` and the
 * bootstrap script inside `worker.ts` will `await import()` each path before
 * entering the job loop.
 *
 * @module runtime/pool/worker-pool
 */

import { logger } from '../../utils/index.js';
import { PooledWorker } from './worker.js';
import { evaluateRecycle } from './recycle.js';
import type { WorkerJob, WorkerResult, WorkerOptions } from './worker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerPoolOptions {
  /** Number of warm workers to maintain (default: 4) */
  size?: number;
  /** Recycle a worker after this many jobs (default: 100) */
  maxJobsPerWorker?: number;
  /** Recycle a worker after this age in ms (default: 600000 = 10 min) */
  maxAgeMs?: number;
  /** Directory of generated .d.ts files from the registry (Agent A output) */
  preloadTypesDir: string;
  /**
   * Additional helper scripts to preload in each worker.
   * Phase 5 (Agent E) passes compact/summarize/delta helpers here.
   * Default: [] (no additional preloads).
   */
  preloadHelpers?: string[];
  /** Max Deno memory per worker in MB (default: 128) */
  maxMemoryMb?: number;
  /** Bridge URL injected into the sandbox (default: http://127.0.0.1:9847) */
  bridgeUrl?: string;
}

export interface PoolExecuteOptions {
  signal?: AbortSignal;
  /** Timeout in ms for waiting to acquire an idle worker (default: 5000) */
  acquireTimeoutMs?: number;
}

interface QueuedJob {
  job: WorkerJob;
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
  timeoutTimer: NodeJS.Timeout;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkerPool
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SIZE = 4;
const DEFAULT_MAX_JOBS = 100;
const DEFAULT_MAX_AGE_MS = 600_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;

export class WorkerPool {
  private readonly opts: Required<WorkerPoolOptions>;
  private workers: PooledWorker[] = [];
  private queue: QueuedJob[] = [];
  private isShuttingDown = false;
  private isWarmedUp = false;

  constructor(options: WorkerPoolOptions) {
    this.opts = {
      size: options.size ?? DEFAULT_SIZE,
      maxJobsPerWorker: options.maxJobsPerWorker ?? DEFAULT_MAX_JOBS,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      preloadTypesDir: options.preloadTypesDir,
      preloadHelpers: options.preloadHelpers ?? [],
      maxMemoryMb: options.maxMemoryMb ?? 128,
      bridgeUrl: options.bridgeUrl ?? 'http://127.0.0.1:9847',
    };
  }

  /** Pre-spawn all workers. Must be called before `execute()`. */
  async warmUp(): Promise<void> {
    if (this.isWarmedUp) return;

    const workerOpts: WorkerOptions = {
      preloadTypesDir: this.opts.preloadTypesDir,
      preloadHelpers: this.opts.preloadHelpers,
      maxMemoryMb: this.opts.maxMemoryMb,
      bridgeUrl: this.opts.bridgeUrl,
    };

    const spawns = Array.from({ length: this.opts.size }, async () => {
      const w = new PooledWorker(workerOpts);
      await w.start();
      this.workers.push(w);
    });

    await Promise.allSettled(spawns);

    const alive = this.workers.filter((w) => w.currentState !== 'dead').length;
    logger.info('WorkerPool warmed up', { requested: this.opts.size, alive });
    this.isWarmedUp = true;
  }

  /**
   * Execute a job on an idle worker.
   *
   * If no idle worker is available, the job is queued until one becomes
   * free or the acquire timeout elapses.
   */
  async execute<T = unknown>(
    job: Omit<WorkerJob, 'signal'>,
    execOpts: PoolExecuteOptions = {}
  ): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error('WorkerPool is shutting down');
    }

    const fullJob: WorkerJob = {
      ...job,
      signal: execOpts.signal,
    };

    const worker = this._findIdle();
    if (worker) {
      return this._runOnWorker(worker, fullJob) as Promise<T>;
    }

    // Queue the job
    const acquireTimeoutMs = execOpts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        const idx = this.queue.findIndex((q) => q.job.id === fullJob.id);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error(`WorkerPool: acquire timeout after ${acquireTimeoutMs}ms`));
      }, acquireTimeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();

      this.queue.push({
        job: fullJob,
        resolve: resolve as (r: WorkerResult) => void,
        reject,
        timeoutTimer,
      });
    });
  }

  size(): number {
    return this.workers.filter((w) => w.currentState !== 'dead').length;
  }

  busyCount(): number {
    return this.workers.filter((w) => w.currentState === 'busy').length;
  }

  idleCount(): number {
    return this.workers.filter((w) => w.currentState === 'idle').length;
  }

  /** Gracefully drain all in-flight jobs then terminate all workers. */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Reject queued jobs that haven't started
    for (const queued of this.queue) {
      clearTimeout(queued.timeoutTimer);
      queued.reject(new Error('WorkerPool shut down'));
    }
    this.queue.length = 0;

    // Drain busy workers (wait for current jobs to finish, then terminate)
    await Promise.allSettled(this.workers.map((w) => w.shutdown(true)));
    this.workers.length = 0;
    logger.info('WorkerPool: shutdown complete');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private _findIdle(): PooledWorker | undefined {
    return this.workers.find((w) => w.isIdle && w.currentState === 'idle');
  }

  private async _runOnWorker(worker: PooledWorker, job: WorkerJob): Promise<unknown> {
    let result: WorkerResult;
    try {
      result = await worker.execute(job);
    } catch (err) {
      // Worker errored — mark for recycle and propagate
      await this._maybeRecycle(worker);
      throw err;
    }

    // Post-job recycle check (age / job-count triggers)
    await this._maybeRecycle(worker);

    // Drain one queued job onto the (now idle) worker or next available idle
    this._drainQueue();

    if (!result.success && result.error) {
      throw new Error(result.error.message);
    }

    return result.result;
  }

  private async _maybeRecycle(worker: PooledWorker): Promise<void> {
    const decision = evaluateRecycle(
      {
        id: worker.id,
        state: worker.currentState,
        createdAt: worker.createdAt,
        jobsRun: worker.jobsRun,
      },
      { maxJobsPerWorker: this.opts.maxJobsPerWorker, maxAgeMs: this.opts.maxAgeMs }
    );

    if (!decision.shouldRecycle) return;

    logger.debug('WorkerPool: recycling worker', { workerId: worker.id, reason: decision.reason });

    // Spawn replacement first to maintain capacity
    const workerOpts: WorkerOptions = {
      preloadTypesDir: this.opts.preloadTypesDir,
      preloadHelpers: this.opts.preloadHelpers,
      maxMemoryMb: this.opts.maxMemoryMb,
      bridgeUrl: this.opts.bridgeUrl,
    };

    if (!this.isShuttingDown) {
      const replacement = new PooledWorker(workerOpts);

      // B7: Push the replacement into this.workers synchronously while it is
      // still in 'starting' state. This closes the recycle window where the
      // old (dead) worker was still in the array between shutdown() and the
      // async .then() callback. _findIdle() requires state === 'idle', so the
      // replacement is invisible to job routing until start() resolves and
      // PooledWorker transitions its state to 'idle' internally.
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) {
        this.workers.splice(idx, 1, replacement);
      } else {
        this.workers.push(replacement);
      }

      replacement.start().then(() => {
        // Replacement is now 'idle' (state set inside PooledWorker.start()).
        // Drain any queued jobs that accumulated while it was starting.
        this._drainQueue();
        logger.debug('WorkerPool: replacement worker ready', { workerId: replacement.id });
      }).catch((err) => {
        logger.error('WorkerPool: replacement spawn failed', { err: String(err) });
        // Remove the failed replacement — it never became idle.
        this._removeWorker(replacement);
      });
    }

    // Terminate old worker (drainFirst=false: it's already idle or dead)
    await worker.shutdown(false);

    if (this.isShuttingDown) {
      this._removeWorker(worker);
    }
  }

  private _removeWorker(worker: PooledWorker): void {
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
  }

  private _drainQueue(): void {
    while (this.queue.length > 0) {
      const idle = this._findIdle();
      if (!idle) break;

      const queued = this.queue.shift()!;
      clearTimeout(queued.timeoutTimer);

      this._runOnWorker(idle, queued.job)
        .then((result) => queued.resolve(result as WorkerResult))
        .catch((err: Error) => queued.reject(err));
    }
  }
}
