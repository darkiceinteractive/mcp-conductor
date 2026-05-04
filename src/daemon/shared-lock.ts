/**
 * Shared Lock Primitive for MCP Conductor Daemon.
 *
 * Implements an in-process mutex per key using a promise chain. Callers
 * `acquire` a lock, receive a `release` function, and must call `release`
 * when their critical section completes.
 *
 * Cross-daemon distributed locking is deferred to v3.1; this module handles
 * the single-daemon (single-process) case which covers the v3.0 requirement
 * of serialising concurrent writers within one daemon instance.
 *
 * @module daemon/shared-lock
 */

import { logger } from '../utils/logger.js';

/** Handle returned by {@link SharedLock.acquire}. */
export interface LockHandle {
  /** Release the lock so the next waiter can proceed. */
  release: () => Promise<void>;
  /** Key this lock was acquired for. */
  key: string;
}

/** Options for {@link SharedLock.acquire}. */
export interface LockAcquireOptions {
  /**
   * Maximum time to wait for the lock in milliseconds.
   * If the lock is not acquired within this window, the call throws.
   * Defaults to 30 000 ms.
   */
  timeoutMs?: number;
}

/**
 * Error thrown when a lock acquisition times out.
 */
export class LockTimeoutError extends Error {
  constructor(key: string, timeoutMs: number) {
    super(`Lock acquisition timed out for key "${key}" after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

/** Internal per-key mutex state. */
interface MutexState {
  /** Promise that resolves when the lock becomes available. */
  chain: Promise<void>;
  /** Number of waiters (including current holder). */
  waiters: number;
}

/**
 * In-process mutex registry keyed by arbitrary string keys.
 *
 * Each key gets its own independent promise chain. The chain starts as a
 * resolved promise; each caller appends to it by storing a new promise that
 * resolves only after the previous holder calls `release`.
 */
export class SharedLock {
  private readonly locks = new Map<string, MutexState>();

  /**
   * Acquire the lock for `key`.
   *
   * Returns a {@link LockHandle} with a `release` function.  The caller MUST
   * call `release()` — ideally in a `finally` block — to unblock the next
   * waiter. Forgetting to release will deadlock all subsequent acquirers.
   *
   * @throws {LockTimeoutError} if the lock is not acquired within `timeoutMs`.
   */
  async acquire(key: string, options?: LockAcquireOptions): Promise<LockHandle> {
    const timeoutMs = options?.timeoutMs ?? 30_000;

    // Get or create the per-key chain.
    const current = this.locks.get(key) ?? { chain: Promise.resolve(), waiters: 0 };
    current.waiters++;
    this.locks.set(key, current);

    // `releaseNext` is the function that the new holder will call to advance
    // the chain for the subsequent waiter.
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => { releaseNext = resolve; });

    // Wait for the previous holder to release, with a timeout.
    const previousChain = current.chain;
    // Advance the chain pointer so the next caller waits on our `next`.
    current.chain = next;

    await this.waitWithTimeout(previousChain, timeoutMs, key);

    logger.debug('SharedLock: acquired', { key, waiters: current.waiters });

    const released = { done: false };

    return {
      key,
      release: async (): Promise<void> => {
        if (released.done) {
          logger.warn('SharedLock: release called more than once', { key });
          return;
        }
        released.done = true;
        current.waiters--;
        logger.debug('SharedLock: released', { key, remainingWaiters: current.waiters });

        // Clean up the key entry if no one else is waiting.
        if (current.waiters === 0) {
          this.locks.delete(key);
        }
        releaseNext();
      },
    };
  }

  /**
   * Execute `fn` while holding the lock for `key`.
   * The lock is always released after `fn` completes (even on throw).
   */
  async withLock<T>(key: string, fn: () => Promise<T>, options?: LockAcquireOptions): Promise<T> {
    const handle = await this.acquire(key, options);
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  }

  /**
   * Number of active waiters (including the current holder) for a given key.
   * Returns 0 if the key has no lock contention.
   */
  waiters(key: string): number {
    return this.locks.get(key)?.waiters ?? 0;
  }

  /**
   * True if any key currently has at least one waiter.
   */
  get hasActiveLocks(): boolean {
    return this.locks.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async waitWithTimeout(
    promise: Promise<void>,
    timeoutMs: number,
    key: string,
  ): Promise<void> {
    let timer!: ReturnType<typeof setTimeout>;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LockTimeoutError(key, timeoutMs)),
        timeoutMs,
      );
    });

    try {
      await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
