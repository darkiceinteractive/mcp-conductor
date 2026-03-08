/**
 * Token bucket rate limiter for MCP servers
 */

import { EventEmitter } from 'node:events';
import type { RateLimitConfig } from '../config/schema.js';
import { logger } from './logger.js';

export interface RateLimiterStats {
  serverName: string;
  availableTokens: number;
  maxTokens: number;
  requestsPerSecond: number;
  queueLength: number;
  totalRequests: number;
  totalWaited: number;
  totalRejected: number;
}

export interface RateLimiterEvents {
  waiting: { serverName: string; queuePosition: number; estimatedWaitMs: number };
  acquired: { serverName: string; waitedMs: number };
  rejected: { serverName: string; reason: string };
}

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  enqueuedAt: number;
}

/**
 * Token bucket rate limiter with queue and reject modes
 */
export class RateLimiter extends EventEmitter {
  private readonly serverName: string;
  private readonly requestsPerSecond: number;
  private readonly maxTokens: number;
  private readonly mode: 'queue' | 'reject';
  private readonly maxQueueTimeMs: number;

  private tokens: number;
  private lastRefill: number;
  private queue: QueuedRequest[] = [];
  private refillInterval: NodeJS.Timeout | null = null;

  // Stats
  private totalRequests = 0;
  private totalWaited = 0;
  private totalRejected = 0;

  constructor(config: RateLimitConfig, serverName: string) {
    super();
    this.serverName = serverName;
    this.requestsPerSecond = config.requestsPerSecond;
    this.maxTokens = config.burstSize ?? config.requestsPerSecond;
    this.mode = config.onLimitExceeded ?? 'queue';
    this.maxQueueTimeMs = config.maxQueueTimeMs ?? 30000;

    // Start with full bucket
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();

    // Start background token refill
    this.startRefillTimer();

    logger.debug(`RateLimiter created for ${serverName}`, {
      requestsPerSecond: this.requestsPerSecond,
      maxTokens: this.maxTokens,
      mode: this.mode,
    });
  }

  /**
   * Acquire a token before making a request
   * In queue mode: waits until a token is available
   * In reject mode: throws immediately if no token available
   */
  async acquire(): Promise<void> {
    this.totalRequests++;

    // Try to get a token immediately
    if (this.tryAcquire()) {
      this.emit('acquired', { serverName: this.serverName, waitedMs: 0 });
      return;
    }

    // No token available
    if (this.mode === 'reject') {
      this.totalRejected++;
      const error = new Error(
        `Rate limit exceeded for ${this.serverName}: ${this.requestsPerSecond} req/s`
      );
      this.emit('rejected', { serverName: this.serverName, reason: 'no tokens available' });
      throw error;
    }

    // Queue mode: wait for a token
    return this.enqueue();
  }

  /**
   * Release a token back (for cancelled requests before they actually execute)
   */
  release(): void {
    this.tokens = Math.min(this.tokens + 1, this.maxTokens);
  }

  /**
   * Get current rate limiter stats
   */
  getStats(): RateLimiterStats {
    return {
      serverName: this.serverName,
      availableTokens: this.tokens,
      maxTokens: this.maxTokens,
      requestsPerSecond: this.requestsPerSecond,
      queueLength: this.queue.length,
      totalRequests: this.totalRequests,
      totalWaited: this.totalWaited,
      totalRejected: this.totalRejected,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.refillInterval) {
      clearInterval(this.refillInterval);
      this.refillInterval = null;
    }

    // Reject all queued requests
    for (const request of this.queue) {
      clearTimeout(request.timeout);
      request.reject(new Error(`RateLimiter for ${this.serverName} destroyed`));
    }
    this.queue = [];

    logger.debug(`RateLimiter destroyed for ${this.serverName}`);
  }

  /**
   * Try to acquire a token without waiting
   */
  private tryAcquire(): boolean {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }

  /**
   * Enqueue a request to wait for a token
   */
  private enqueue(): Promise<void> {
    return new Promise((resolve, reject) => {
      const queuePosition = this.queue.length + 1;
      const estimatedWaitMs = Math.ceil((queuePosition / this.requestsPerSecond) * 1000);

      this.emit('waiting', {
        serverName: this.serverName,
        queuePosition,
        estimatedWaitMs,
      });

      logger.debug(`Request queued for ${this.serverName}`, {
        queuePosition,
        estimatedWaitMs,
      });

      const timeout = setTimeout(() => {
        // Remove from queue
        const index = this.queue.findIndex((r) => r.timeout === timeout);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }

        this.totalRejected++;
        const error = new Error(
          `Rate limit queue timeout for ${this.serverName} after ${this.maxQueueTimeMs}ms`
        );
        this.emit('rejected', { serverName: this.serverName, reason: 'queue timeout' });
        reject(error);
      }, this.maxQueueTimeMs);

      this.queue.push({
        resolve,
        reject,
        timeout,
        enqueuedAt: Date.now(),
      });
    });
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    // Calculate tokens to add based on elapsed time
    const tokensToAdd = (elapsed / 1000) * this.requestsPerSecond;

    if (tokensToAdd >= 1) {
      this.tokens = Math.min(this.tokens + Math.floor(tokensToAdd), this.maxTokens);
      this.lastRefill = now;
    }
  }

  /**
   * Start background timer to process queued requests
   */
  private startRefillTimer(): void {
    // Check queue every 50ms
    this.refillInterval = setInterval(() => {
      this.processQueue();
    }, 50);
  }

  /**
   * Process queued requests when tokens become available
   */
  private processQueue(): void {
    this.refillTokens();

    while (this.queue.length > 0 && this.tokens >= 1) {
      const request = this.queue.shift();
      if (request) {
        clearTimeout(request.timeout);
        this.tokens--;
        this.totalWaited++;

        const waitedMs = Date.now() - request.enqueuedAt;
        this.emit('acquired', { serverName: this.serverName, waitedMs });

        logger.debug(`Request dequeued for ${this.serverName}`, { waitedMs });
        request.resolve();
      }
    }
  }
}
