/**
 * Public API for the MCP Conductor cache layer.
 * Three-tier cache: in-memory LRU → persistent CBOR disk → delta encoding.
 * @module cache
 */

export interface CacheKey {
  server: string;
  tool: string;
  argsHash: string;
}

export interface CacheHit {
  value: unknown;
  storedAt: number;
  source: 'memory' | 'disk';
  staleness: number;
}

export interface CacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  evictions: number;
  bytesInMemory: number;
  bytesOnDisk: number;
}

export interface DeltaResult {
  unchanged: boolean;
  added?: unknown[];
  removed?: unknown[];
  modified?: Array<{ before: unknown; after: unknown }>;
  full?: unknown;
}

export interface CacheLayerOptions {
  registry: import('../registry/registry.js').ToolRegistry;
  diskDir?: string;
  maxMemoryBytes?: number;
  maxDiskBytes?: number;
  staleWhileRevalidate?: boolean;
  policies?: import('./policy.js').ServerPolicies;
}

export { CacheLayer } from './cache.js';
export type { ExtendedCacheHit } from './cache.js';
export { MemoryLru } from './lru.js';
export type { LruOptions, LruEntry } from './lru.js';
export { DiskCache } from './disk.js';
export type { DiskCacheOptions, DiskEntry, DiskCacheHit } from './disk.js';
export { stableJsonStringify, hashArgs, buildCacheKey, cacheKeyToString, parseCacheKey } from './key.js';
export { resolveTtl, isCacheable, defaultTtlForName, DEFAULT_TTL_MS } from './policy.js';
export type { ServerPolicies } from './policy.js';
export { computeDelta, deepEqual } from './delta.js';
