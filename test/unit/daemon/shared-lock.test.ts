/**
 * Unit tests for SharedLock — in-process mutex per key.
 */

import { describe, it, expect } from 'vitest';
import { SharedLock, LockTimeoutError } from '../../../src/daemon/shared-lock.js';

describe('SharedLock', () => {
  // ---------------------------------------------------------------------------
  // Basic acquire / release
  // ---------------------------------------------------------------------------

  describe('mutual exclusion under concurrent acquire', () => {
    it('serialises two concurrent acquirers — second waits for first to release', async () => {
      const lock = new SharedLock();
      const log: string[] = [];

      const first = lock.acquire('key').then(async (h) => {
        log.push('first:in');
        await new Promise((r) => setTimeout(r, 20));
        log.push('first:out');
        await h.release();
      });

      // Give first a head start.
      await new Promise((r) => setTimeout(r, 5));

      const second = lock.acquire('key').then(async (h) => {
        log.push('second:in');
        await h.release();
      });

      await Promise.all([first, second]);
      expect(log).toEqual(['first:in', 'first:out', 'second:in']);
    });

    it('different keys do not block each other', async () => {
      const lock = new SharedLock();
      const log: string[] = [];

      const h1 = await lock.acquire('alpha');
      const h2 = await lock.acquire('beta'); // Should not block.
      log.push('both acquired');
      await h1.release();
      await h2.release();

      expect(log).toEqual(['both acquired']);
    });
  });

  describe('release allows next acquirer', () => {
    it('next waiter proceeds immediately after release', async () => {
      const lock = new SharedLock();
      const h1 = await lock.acquire('key');

      let secondDone = false;
      const secondPromise = lock.acquire('key').then(async (h) => {
        secondDone = true;
        await h.release();
      });

      expect(secondDone).toBe(false);
      await h1.release();
      await secondPromise;
      expect(secondDone).toBe(true);
    });
  });

  describe('timeout returns LockTimeoutError', () => {
    it('throws when lock is held past timeout', async () => {
      const lock = new SharedLock();
      const h = await lock.acquire('held');

      await expect(
        lock.acquire('held', { timeoutMs: 30 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);

      await h.release();
    });

    it('does not throw when acquired within timeout', async () => {
      const lock = new SharedLock();
      const h1 = await lock.acquire('quick');

      const waiter = lock.acquire('quick', { timeoutMs: 200 });
      setTimeout(() => h1.release(), 30);

      const h2 = await waiter;
      await h2.release();
    });
  });

  describe('100 concurrent: serial execution', () => {
    it('100 concurrent acquirers on the same key execute in series', async () => {
      const lock = new SharedLock();
      let counter = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 100 }, async () => {
        const h = await lock.acquire('shared');
        counter++;
        maxConcurrent = Math.max(maxConcurrent, counter);
        await new Promise((r) => setTimeout(r, 1));
        counter--;
        await h.release();
      });

      await Promise.all(tasks);
      // If truly serialised, counter never exceeds 1.
      expect(maxConcurrent).toBe(1);
    });
  });

  describe('withLock helper', () => {
    it('executes fn while holding the lock', async () => {
      const lock = new SharedLock();
      const result = await lock.withLock('key', async () => 'done');
      expect(result).toBe('done');
    });

    it('releases even when fn throws', async () => {
      const lock = new SharedLock();
      await expect(
        lock.withLock('key', async () => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');

      // Lock should be released — the next acquire should not hang.
      const h = await lock.acquire('key', { timeoutMs: 100 });
      await h.release();
    });
  });

  describe('double-release is safe', () => {
    it('second release is a no-op', async () => {
      const lock = new SharedLock();
      const h = await lock.acquire('key');
      await h.release();
      await expect(h.release()).resolves.not.toThrow();
    });
  });

  describe('waiters counter', () => {
    it('tracks waiters correctly', async () => {
      const lock = new SharedLock();
      expect(lock.waiters('key')).toBe(0);

      const h1 = await lock.acquire('key');
      expect(lock.waiters('key')).toBe(1);

      // Don't await yet — fire a second acquire that will wait.
      const second = lock.acquire('key');
      // Give the event loop a tick to register the second waiter.
      await new Promise((r) => setTimeout(r, 0));
      expect(lock.waiters('key')).toBe(2);

      await h1.release();
      const h2 = await second;
      await h2.release();
      expect(lock.waiters('key')).toBe(0);
    });
  });
});
