import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryLru } from '../../../src/cache/lru.js';

describe('MemoryLru', () => {
  let lru: MemoryLru;

  beforeEach(() => {
    lru = new MemoryLru({ maxMemoryBytes: 10 * 1024 * 1024 }); // 10 MB
  });

  it('get returns null on miss', () => {
    expect(lru.get('missing-key')).toBeNull();
  });

  it('set then get returns value', () => {
    lru.set('key1', { result: 42 }, 60_000);
    const hit = lru.get('key1');
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual({ result: 42 });
    expect(hit!.source).toBe('memory');
    expect(hit!.staleness).toBeGreaterThanOrEqual(0);
    expect(hit!.storedAt).toBeGreaterThan(0);
  });

  it('TTL expiry returns null', async () => {
    vi.useFakeTimers();
    lru.set('expiring', 'data', 100); // 100ms TTL
    vi.advanceTimersByTime(200);
    const hit = lru.get('expiring');
    expect(hit).toBeNull();
    vi.useRealTimers();
  });

  it('LRU evicts oldest when over capacity', () => {
    // Each entry is ~1 KB; limit to 3 KB so 4th entry evicts the first
    const tinyLru = new MemoryLru({ maxMemoryBytes: 3 * 1024 });
    const value = 'x'.repeat(900); // ~900 bytes per entry
    tinyLru.set('k1', value, 60_000);
    tinyLru.set('k2', value, 60_000);
    tinyLru.set('k3', value, 60_000);
    tinyLru.set('k4', value, 60_000); // triggers eviction
    const counters = tinyLru.getCounters();
    expect(counters.evictions).toBeGreaterThan(0);
  });

  it('delete removes a key', () => {
    lru.set('del-me', 'value', 60_000);
    expect(lru.delete('del-me')).toBe(true);
    expect(lru.get('del-me')).toBeNull();
  });

  it('invalidateByPrefix removes matching keys', () => {
    lru.set('github:list_issues:abc', { issues: [] }, 60_000);
    lru.set('github:list_issues:def', { issues: [] }, 60_000);
    lru.set('ibkr:get_quote:xyz', { price: 100 }, 60_000);

    const count = lru.invalidateByPrefix('github:list_issues:');
    expect(count).toBe(2);
    expect(lru.get('github:list_issues:abc')).toBeNull();
    expect(lru.get('github:list_issues:def')).toBeNull();
    expect(lru.get('ibkr:get_quote:xyz')).not.toBeNull();
  });

  it('clear removes all entries', () => {
    lru.set('a', 1, 60_000);
    lru.set('b', 2, 60_000);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get('a')).toBeNull();
  });

  it('tracks hits and misses', () => {
    lru.set('hit-me', 'val', 60_000);
    lru.get('hit-me');
    lru.get('miss-me');
    const { hits, misses } = lru.getCounters();
    expect(hits).toBe(1);
    expect(misses).toBe(1);
  });

  it('bytesUsed increases after sets', () => {
    const before = lru.bytesUsed;
    lru.set('large', 'x'.repeat(1000), 60_000);
    expect(lru.bytesUsed).toBeGreaterThan(before);
  });
});
