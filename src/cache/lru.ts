/**
 * In-memory LRU cache tier.
 *
 * Wraps `lru-cache` with byte-aware eviction. TTL is enforced manually via
 * storedAt + ttlMs fields rather than lru-cache's built-in TTL, so that
 * tests using vi.useFakeTimers() work correctly (lru-cache's internal TTL
 * uses the real clock bypassing the fake timer).
 *
 * @module cache/lru
 */

import { LRUCache } from 'lru-cache';
import type { CacheHit } from './index.js';

export interface LruEntry {
  value: unknown;
  storedAt: number;
  ttlMs: number; // 0 = no expiry
}

export interface LruOptions {
  /** Maximum total byte size of all cached values (default: 100 MB). */
  maxMemoryBytes?: number;
}

/** Estimate the serialised byte size of a value. */
function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    return 0;
  }
}

export class MemoryLru {
  private cache: LRUCache<string, LruEntry>;
  private evictions = 0;
  private hits = 0;
  private misses = 0;

  constructor(options: LruOptions = {}) {
    const maxSize = options.maxMemoryBytes ?? 100 * 1024 * 1024; // 100 MB

    this.cache = new LRUCache<string, LruEntry>({
      maxSize,
      sizeCalculation: (entry: LruEntry) => {
        return Math.max(1, estimateBytes(entry.value));
      },
      allowStale: false,
      updateAgeOnGet: true,
      dispose: () => {
        this.evictions++;
      },
    });
  }

  /**
   * Retrieve an entry. Returns null on miss or TTL expiry.
   */
  get(key: string): CacheHit | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Manual TTL check so fake timers work in tests
    const now = Date.now();
    if (entry.ttlMs > 0 && now - entry.storedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return {
      value: entry.value,
      storedAt: entry.storedAt,
      source: 'memory',
      staleness: now - entry.storedAt,
    };
  }

  /**
   * Store a value. ttlMs of 0 means store without TTL expiry.
   */
  set(key: string, value: unknown, ttlMs: number): void {
    const entry: LruEntry = { value, storedAt: Date.now(), ttlMs };
    this.cache.set(key, entry);
  }

  /** Delete a single key. Returns true if the key existed. */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Delete all keys matching a prefix.
   * Returns the count of deleted entries.
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Remove all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Current total byte estimate across all entries. */
  get bytesUsed(): number {
    return this.cache.calculatedSize ?? 0;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.cache.size;
  }

  /** Expose counters for CacheStats aggregation. */
  getCounters(): { hits: number; misses: number; evictions: number } {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions };
  }

  /** Reset hit/miss/eviction counters (useful in tests). */
  resetCounters(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}
