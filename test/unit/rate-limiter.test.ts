/**
 * Unit tests for RateLimiter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../src/utils/rate-limiter.js';
import type { RateLimitConfig } from '../../src/config/schema.js';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  afterEach(() => {
    if (rateLimiter) {
      rateLimiter.destroy();
    }
  });

  describe('constructor', () => {
    it('creates with default values', () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
      };

      rateLimiter = new RateLimiter(config, 'test-server');
      const stats = rateLimiter.getStats();

      expect(stats.serverName).toBe('test-server');
      expect(stats.requestsPerSecond).toBe(5);
      expect(stats.maxTokens).toBe(5); // defaults to requestsPerSecond
      expect(stats.availableTokens).toBe(5); // starts full
      expect(stats.queueLength).toBe(0);
    });

    it('uses custom burstSize when provided', () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
        burstSize: 10,
      };

      rateLimiter = new RateLimiter(config, 'test-server');
      const stats = rateLimiter.getStats();

      expect(stats.maxTokens).toBe(10);
      expect(stats.availableTokens).toBe(10);
    });
  });

  describe('acquire - immediate success', () => {
    it('acquires token immediately when available', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      await expect(rateLimiter.acquire()).resolves.toBeUndefined();

      const stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(9);
      expect(stats.totalRequests).toBe(1);
    });

    it('can acquire burst of tokens', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
        burstSize: 5,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Acquire all 5 tokens
      for (let i = 0; i < 5; i++) {
        await expect(rateLimiter.acquire()).resolves.toBeUndefined();
      }

      const stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(0);
      expect(stats.totalRequests).toBe(5);
    });
  });

  describe('acquire - reject mode', () => {
    it('rejects immediately when no tokens available', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 2,
        burstSize: 2,
        onLimitExceeded: 'reject',
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Use up all tokens
      await rateLimiter.acquire();
      await rateLimiter.acquire();

      // Third should reject
      await expect(rateLimiter.acquire()).rejects.toThrow(/Rate limit exceeded/);

      const stats = rateLimiter.getStats();
      expect(stats.totalRejected).toBe(1);
    });
  });

  describe('acquire - queue mode', () => {
    it('queues request and waits for token refill', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10, // 1 token per 100ms
        burstSize: 1,
        onLimitExceeded: 'queue',
        maxQueueTimeMs: 5000,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Use up the only token
      await rateLimiter.acquire();

      const stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(0);

      // Next request should queue and resolve when token refills
      const startTime = Date.now();
      await rateLimiter.acquire();
      const elapsed = Date.now() - startTime;

      // Should wait roughly 100ms (give or take for timing variations)
      expect(elapsed).toBeGreaterThan(50);
      expect(elapsed).toBeLessThan(300);

      const finalStats = rateLimiter.getStats();
      expect(finalStats.totalWaited).toBe(1);
    });

    it('rejects after queue timeout', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 0.1, // Very slow: 1 token per 10 seconds
        burstSize: 1,
        onLimitExceeded: 'queue',
        maxQueueTimeMs: 100, // But timeout after 100ms
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Use up the only token
      await rateLimiter.acquire();

      // Next request should queue but timeout
      await expect(rateLimiter.acquire()).rejects.toThrow(/queue timeout/);

      const stats = rateLimiter.getStats();
      expect(stats.totalRejected).toBe(1);
    });
  });

  describe('release', () => {
    it('returns token to bucket', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
        burstSize: 5,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      await rateLimiter.acquire();
      let stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(4);

      rateLimiter.release();
      stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(5);
    });

    it('does not exceed maxTokens on release', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
        burstSize: 5,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Release without acquiring first
      rateLimiter.release();
      rateLimiter.release();

      const stats = rateLimiter.getStats();
      expect(stats.availableTokens).toBe(5); // Should not exceed max
    });
  });

  describe('getStats', () => {
    it('returns accurate statistics', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
        onLimitExceeded: 'queue',
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Make some requests
      await rateLimiter.acquire();
      await rateLimiter.acquire();
      await rateLimiter.acquire();

      const stats = rateLimiter.getStats();

      expect(stats.serverName).toBe('test-server');
      expect(stats.availableTokens).toBe(7);
      expect(stats.maxTokens).toBe(10);
      expect(stats.requestsPerSecond).toBe(10);
      expect(stats.queueLength).toBe(0);
      expect(stats.totalRequests).toBe(3);
    });
  });

  describe('destroy', () => {
    it('cleans up resources', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 1,
        onLimitExceeded: 'queue',
        maxQueueTimeMs: 10000,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Use up token
      await rateLimiter.acquire();

      // Queue a request
      const pendingPromise = rateLimiter.acquire();

      // Destroy should reject queued requests
      rateLimiter.destroy();

      await expect(pendingPromise).rejects.toThrow(/destroyed/);
    });
  });

  describe('events', () => {
    it('emits acquired event on immediate acquisition', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 5,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      const acquiredHandler = vi.fn();
      rateLimiter.on('acquired', acquiredHandler);

      await rateLimiter.acquire();

      expect(acquiredHandler).toHaveBeenCalledWith({
        serverName: 'test-server',
        waitedMs: 0,
      });
    });

    it('emits waiting event when queued', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10, // Fast enough to not timeout
        burstSize: 1,
        onLimitExceeded: 'queue',
        maxQueueTimeMs: 5000,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      const waitingHandler = vi.fn();
      rateLimiter.on('waiting', waitingHandler);

      // Use up token
      await rateLimiter.acquire();

      // Queue a request
      await rateLimiter.acquire();

      expect(waitingHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'test-server',
          queuePosition: 1,
        })
      );
    });

    it('emits rejected event in reject mode', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 1,
        onLimitExceeded: 'reject',
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      const rejectedHandler = vi.fn();
      rateLimiter.on('rejected', rejectedHandler);

      // Use up token
      await rateLimiter.acquire();

      // Try to acquire another (should reject)
      try {
        await rateLimiter.acquire();
      } catch {
        // Expected
      }

      expect(rejectedHandler).toHaveBeenCalledWith({
        serverName: 'test-server',
        reason: 'no tokens available',
      });
    });
  });

  describe('concurrent requests', () => {
    it('handles multiple concurrent requests with queuing', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 20, // Fast refill
        burstSize: 2,
        onLimitExceeded: 'queue',
        maxQueueTimeMs: 5000,
      };

      rateLimiter = new RateLimiter(config, 'test-server');

      // Fire 5 concurrent requests (only 2 burst allowed)
      const promises = Array(5).fill(null).map(() => rateLimiter.acquire());

      // All should eventually resolve
      await expect(Promise.all(promises)).resolves.toBeDefined();

      const stats = rateLimiter.getStats();
      expect(stats.totalRequests).toBe(5);
    });
  });
});
