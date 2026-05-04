/**
 * CacheLayer — three-tier cache composition (memory LRU + disk CBOR + delta).
 *
 * Call flow:
 *   get(server, tool, args)
 *     → memory LRU hit?  → return CacheHit (source: 'memory')
 *     → disk hit?        → promote to memory, return CacheHit (source: 'disk')
 *     → miss             → return null (caller must fetch from backend)
 *
 * Stale-while-revalidate (SWR):
 *   All staleness decisions are made here, not in DiskCache, so that
 *   vi.useFakeTimers() in tests correctly affects TTL checks at all tiers.
 *
 * Bridge wiring order (per spec):
 *   cache check → cache miss → reliability gateway (Agent C) → backend
 *
 * @module cache/cache
 */

import { MemoryLru } from './lru.js';
import { DiskCache } from './disk.js';
import { buildCacheKey, cacheKeyToString } from './key.js';
import { resolveTtl, isCacheable } from './policy.js';
import { computeDelta } from './delta.js';
import { logger } from '../utils/index.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { RegistryEvent } from '../registry/events.js';
import type { CacheHit, CacheStats, CacheLayerOptions, DeltaResult } from './index.js';

export interface ExtendedCacheHit extends CacheHit {
  needsRevalidation?: boolean;
}

export class CacheLayer {
  private lru: MemoryLru;
  private disk: DiskCache;
  private registry: ToolRegistry;
  private options: Required<CacheLayerOptions>;
  private unsubscribe: (() => void) | null = null;
  private diskMisses = 0;
  private ttlMap = new Map<string, number>();
  /** Keys currently being background-revalidated; prevents SWR thundering herd. */
  private revalidating = new Set<string>();

  constructor(options: CacheLayerOptions) {
    this.options = {
      diskDir: `${process.env['HOME'] ?? '/tmp'}/.mcp-conductor/cache`,
      maxMemoryBytes: 100 * 1024 * 1024,
      maxDiskBytes: 2 * 1024 * 1024 * 1024,
      staleWhileRevalidate: true,
      policies: {},
      ...options,
    };
    this.registry = options.registry;
    this.lru = new MemoryLru({ maxMemoryBytes: this.options.maxMemoryBytes });
    this.disk = new DiskCache({
      diskDir: this.options.diskDir,
      maxDiskBytes: this.options.maxDiskBytes,
    });

    const sub = this.registry.watch((event: RegistryEvent) => {
      if (event.type === 'tool-updated') {
        const prefix = `${event.server}:${event.tool}:`;
        this.lru.invalidateByPrefix(prefix);
        this.disk.invalidateByPrefix(prefix).catch((err) =>
          logger.warn('CacheLayer: disk invalidation error', { error: String(err) })
        );
        logger.debug('CacheLayer: invalidated on tool-updated', {
          server: event.server,
          tool: event.tool,
        });
      }
    });
    this.unsubscribe = sub.unsubscribe;
  }

  async get(server: string, tool: string, args: unknown): Promise<ExtendedCacheHit | null> {
    const cacheKey = buildCacheKey(server, tool, args);
    const keyStr = cacheKeyToString(cacheKey);
    const now = Date.now();

    // 1. Memory LRU — MemoryLru.get() enforces TTL via manual storedAt check
    const memHit = this.lru.get(keyStr);
    if (memHit) {
      const ttlMs = this.ttlMap.get(keyStr) ?? 0;
      const isStale = ttlMs > 0 && now - memHit.storedAt > ttlMs;
      if (!isStale) {
        return { ...memHit, staleness: now - memHit.storedAt };
      }
      if (this.options.staleWhileRevalidate) {
        // Suppress duplicate SWR triggers: if already revalidating, return stale without the flag
        const needsRevalidation = !this.revalidating.has(keyStr);
        return { ...memHit, staleness: now - memHit.storedAt, needsRevalidation };
      }
      this.lru.delete(keyStr);
      // fall through to disk
    }

    // 2. Disk — DiskCache.get() does NOT enforce TTL; we decide staleness here
    const diskHit = await this.disk.get(cacheKey.argsHash);
    if (diskHit) {
      const entryTtl = diskHit.ttlMs > 0 ? diskHit.ttlMs : (this.ttlMap.get(keyStr) ?? 0);
      const staleness = now - diskHit.storedAt;
      const isStale = entryTtl > 0 && staleness > entryTtl;

      if (!isStale) {
        const remaining = entryTtl > 0 ? Math.max(1, entryTtl - staleness) : 0;
        this.lru.set(keyStr, diskHit.value, remaining);
        this.ttlMap.set(keyStr, entryTtl);
        return { value: diskHit.value, storedAt: diskHit.storedAt, source: 'disk', staleness };
      }

      if (this.options.staleWhileRevalidate) {
        const remaining = Math.max(1, entryTtl);
        this.lru.set(keyStr, diskHit.value, remaining);
        this.ttlMap.set(keyStr, entryTtl);
        // Suppress duplicate SWR triggers: if already revalidating, return stale without the flag
        const needsRevalidation = !this.revalidating.has(keyStr);
        return {
          value: diskHit.value,
          storedAt: diskHit.storedAt,
          source: 'disk',
          staleness,
          needsRevalidation,
        };
      }

      await this.disk.delete(cacheKey.argsHash);
    }

    this.diskMisses++;
    return null;
  }

  async set(
    server: string,
    tool: string,
    args: unknown,
    result: unknown,
    options?: { ttl?: number }
  ): Promise<void> {
    const toolDef = this.registry.getTool(server, tool);
    const ttlMs = options?.ttl ?? resolveTtl(toolDef, this.options.policies);
    if (ttlMs === 0) return;

    const cacheKey = buildCacheKey(server, tool, args);
    const keyStr = cacheKeyToString(cacheKey);
    this.lru.set(keyStr, result, ttlMs);
    this.ttlMap.set(keyStr, ttlMs);
    await this.disk.set(cacheKey.argsHash, {
      value: result,
      storedAt: Date.now(),
      ttlMs,
      server,
      tool,
    });
  }

  async invalidate(server: string, pattern?: string): Promise<number> {
    const prefix = pattern ? `${server}:${pattern}` : `${server}:`;
    const memCount = this.lru.invalidateByPrefix(prefix);
    const diskCount = await this.disk.invalidateByPrefix(prefix);
    return memCount + diskCount;
  }

  async delta(server: string, tool: string, args: unknown, current: unknown): Promise<DeltaResult> {
    const hit = await this.get(server, tool, args);
    if (!hit) return { unchanged: false, full: current };
    return computeDelta(hit.value, current);
  }

  stats(): CacheStats {
    const lruCounters = this.lru.getCounters();
    const diskCounters = this.disk.getCounters();
    return {
      memoryHits: lruCounters.hits,
      diskHits: diskCounters.hits,
      misses: this.diskMisses,
      evictions: lruCounters.evictions,
      bytesInMemory: this.lru.bytesUsed,
      bytesOnDisk: this.disk.approximateBytesOnDisk,
    };
  }

  async clear(): Promise<void> {
    this.lru.clear();
    this.lru.resetCounters();
    this.ttlMap.clear();
    this.diskMisses = 0;
    await this.disk.clear();
  }

  wouldCache(server: string, tool: string): boolean {
    const toolDef = this.registry.getTool(server, tool);
    return isCacheable(toolDef, this.options.policies);
  }

  /**
   * Deduplicated background revalidation helper for stale-while-revalidate.
   *
   * Marks the cache key as being revalidated so subsequent concurrent `get()`
   * calls that would also see `needsRevalidation: true` get `false` instead,
   * preventing a thundering herd of parallel refreshes.
   *
   * The key is removed from the revalidating set on completion (success or
   * failure), allowing a future `get()` to schedule a fresh revalidation if
   * the entry is still stale at that point.
   *
   * @param server   MCP server name.
   * @param tool     Tool name.
   * @param args     Original call arguments (used to build the cache key).
   * @param fetchFn  Async function that calls the backend and returns the fresh result.
   * @returns        A promise that resolves when the background refresh completes.
   *                 Callers should `.catch()` the returned promise to handle errors.
   */
  refreshInBackground(
    server: string,
    tool: string,
    args: unknown,
    fetchFn: () => Promise<unknown>
  ): Promise<void> {
    const cacheKey = buildCacheKey(server, tool, args);
    const keyStr = cacheKeyToString(cacheKey);

    // Already in-flight — skip
    if (this.revalidating.has(keyStr)) {
      return Promise.resolve();
    }

    this.revalidating.add(keyStr);

    return (async () => {
      try {
        const freshResult = await fetchFn();
        await this.set(server, tool, args, freshResult);
      } finally {
        this.revalidating.delete(keyStr);
      }
    })();
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
