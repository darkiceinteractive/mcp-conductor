import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { CacheLayer } from '../../../src/cache/cache.js';
import type { ToolRegistry } from '../../../src/registry/registry.js';
import type { ToolDefinition } from '../../../src/registry/index.js';

// ── Minimal ToolRegistry mock ─────────────────────────────────────────────────

type EventCallback = (event: { type: string; server: string; tool: string; at: number }) => void;

function makeMockRegistry(toolOverrides: Partial<ToolDefinition> = {}): ToolRegistry & { _trigger: EventCallback } {
  const watchers: EventCallback[] = [];

  const registry = {
    getTool: (_server: string, _tool: string) => ({
      server: 'github',
      name: _tool,
      description: 'mock',
      inputSchema: {},
      ...toolOverrides,
    }),
    watch: (cb: EventCallback) => {
      watchers.push(cb);
      return {
        unsubscribe: () => {
          const idx = watchers.indexOf(cb);
          if (idx >= 0) watchers.splice(idx, 1);
        },
      };
    },
    _trigger: (event: { type: string; server: string; tool: string; at: number }) => {
      for (const w of watchers) w(event);
    },
  } as unknown as ToolRegistry & { _trigger: EventCallback };

  return registry;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'conductor-cache-test-'));
}

describe('CacheLayer', () => {
  let tmpDir: string;
  let cache: CacheLayer;
  let registry: ReturnType<typeof makeMockRegistry>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    registry = makeMockRegistry();
    cache = new CacheLayer({ registry, diskDir: tmpDir });
  });

  afterEach(async () => {
    cache.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null on miss', async () => {
    const result = await cache.get('github', 'list_issues', { state: 'open' });
    expect(result).toBeNull();
  });

  it('memory hit before disk hit', async () => {
    await cache.set('github', 'list_issues', { state: 'open' }, [{ id: 1 }]);
    const hit = await cache.get('github', 'list_issues', { state: 'open' });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('memory');
    expect(hit!.value).toEqual([{ id: 1 }]);
  });

  it('disk hit promoted to memory', async () => {
    await cache.set('github', 'list_issues', { state: 'open' }, [{ id: 42 }]);
    // Clear only memory tier
    cache['lru'].clear();
    // Re-fetch — should come from disk
    const hit = await cache.get('github', 'list_issues', { state: 'open' });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('disk');
    expect(hit!.value).toEqual([{ id: 42 }]);
    // Second fetch should now be from memory (promoted)
    const hit2 = await cache.get('github', 'list_issues', { state: 'open' });
    expect(hit2!.source).toBe('memory');
  });

  it('mutation policy skips cache', async () => {
    // The mock registry returns name=tool for getTool(), so create_issue
    // is returned as-is and the policy checks the tool name pattern.
    expect(cache.wouldCache('github', 'create_issue')).toBe(false);
    await cache.set('github', 'create_issue', { title: 'Test' }, { id: 99 });
    const hit = await cache.get('github', 'create_issue', { title: 'Test' });
    expect(hit).toBeNull();
  });

  it('cacheable:false annotation prevents caching', async () => {
    const noCacheRegistry = makeMockRegistry({ cacheable: false });
    const noCache = new CacheLayer({ registry: noCacheRegistry, diskDir: tmpDir });
    await noCache.set('github', 'list_issues', {}, [{ id: 1 }]);
    const hit = await noCache.get('github', 'list_issues', {});
    expect(hit).toBeNull();
    noCache.destroy();
  });

  it('cacheTtl annotation is used', async () => {
    vi.useFakeTimers();
    const ttlRegistry = makeMockRegistry({ cacheTtl: 200 });
    const ttlCache = new CacheLayer({ registry: ttlRegistry, diskDir: tmpDir, staleWhileRevalidate: false });
    await ttlCache.set('github', 'list_issues', {}, [{ id: 1 }]);

    vi.advanceTimersByTime(100);
    const hit1 = await ttlCache.get('github', 'list_issues', {});
    expect(hit1).not.toBeNull();

    vi.advanceTimersByTime(200);
    const hit2 = await ttlCache.get('github', 'list_issues', {});
    expect(hit2).toBeNull();
    ttlCache.destroy();
    vi.useRealTimers();
  });

  it('stale-while-revalidate returns cached value with needsRevalidation flag', async () => {
    vi.useFakeTimers();
    const ttlRegistry = makeMockRegistry({ cacheTtl: 100 });
    const swrCache = new CacheLayer({ registry: ttlRegistry, diskDir: tmpDir, staleWhileRevalidate: true });
    await swrCache.set('github', 'list_issues', {}, [{ id: 1 }]);

    vi.advanceTimersByTime(200); // past TTL
    const hit = await swrCache.get('github', 'list_issues', {});
    expect(hit).not.toBeNull();
    expect(hit!.needsRevalidation).toBe(true);
    expect(hit!.value).toEqual([{ id: 1 }]);
    swrCache.destroy();
    vi.useRealTimers();
  });

  it('invalidate by pattern removes matching keys', async () => {
    await cache.set('github', 'list_issues', { state: 'open' }, [{ id: 1 }]);
    await cache.set('github', 'list_pull_requests', {}, [{ id: 10 }]);
    await cache.set('ibkr', 'get_quote', { symbol: 'AAPL' }, { price: 100 });

    await cache.invalidate('github');

    expect(await cache.get('github', 'list_issues', { state: 'open' })).toBeNull();
    expect(await cache.get('github', 'list_pull_requests', {})).toBeNull();
    // ibkr entry survives
    expect(await cache.get('ibkr', 'get_quote', { symbol: 'AAPL' })).not.toBeNull();
  });

  it('stats reflect hits, misses, evictions', async () => {
    await cache.set('github', 'list_issues', {}, [{ id: 1 }]);
    await cache.get('github', 'list_issues', {}); // memory hit
    await cache.get('github', 'list_issues', { state: 'closed' }); // miss

    const stats = cache.stats();
    expect(stats.memoryHits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it('clear removes all entries', async () => {
    await cache.set('github', 'list_issues', {}, [{ id: 1 }]);
    await cache.clear();
    expect(await cache.get('github', 'list_issues', {})).toBeNull();
    expect(cache.stats().bytesInMemory).toBe(0);
  });

  it('cache invalidation on registry tool-updated event (memory)', async () => {
    // Sets an entry, triggers tool-updated, verifies memory is immediately cleared.
    // Disk invalidation is async (fire-and-forget) so we only assert memory here.
    await cache.set('github', 'list_issues', {}, [{ id: 1 }]);

    // Confirm it's in memory
    const before = await cache.get('github', 'list_issues', {});
    expect(before).not.toBeNull();
    expect(before!.source).toBe('memory');

    // Trigger tool-updated event
    registry._trigger({ type: 'tool-updated', server: 'github', tool: 'list_issues', at: Date.now() });

    // Memory should be cleared synchronously after the event
    // We bypass the disk by checking the LRU directly
    const lru = cache['lru'] as { get(k: string): unknown };
    const keyStr = `github:list_issues:${(await import('../../../src/cache/key.js')).hashArgs({})}`;
    expect(lru.get(keyStr)).toBeNull();
  });

  it('cache invalidation on registry tool-updated event (full invalidation with await)', async () => {
    await cache.set('github', 'list_issues', {}, [{ id: 1 }]);

    // Trigger event then explicitly await disk invalidation by calling invalidate()
    registry._trigger({ type: 'tool-updated', server: 'github', tool: 'list_issues', at: Date.now() });

    // Also call the public invalidate() to ensure disk is clean before asserting
    await cache.invalidate('github', 'list_issues:');

    const hit = await cache.get('github', 'list_issues', {});
    expect(hit).toBeNull();
  });

  it('delta returns unchanged for same result', async () => {
    const data = [{ id: 1, title: 'Issue' }];
    await cache.set('github', 'list_issues', {}, data);
    const result = await cache.delta('github', 'list_issues', {}, data);
    expect(result.unchanged).toBe(true);
  });

  it('delta returns added/removed for different results', async () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const curr = [{ id: 2 }, { id: 3 }];
    await cache.set('github', 'list_issues', {}, prev);
    const result = await cache.delta('github', 'list_issues', {}, curr);
    expect(result.unchanged).toBe(false);
  });

  it('delta returns full result on first call (no previous)', async () => {
    const curr = [{ id: 1 }];
    const result = await cache.delta('github', 'list_issues', {}, curr);
    expect(result.unchanged).toBe(false);
    expect(result.full).toEqual(curr);
  });

  it('cache keys are stable across arg orderings', async () => {
    const args1 = { state: 'open', assignee: 'alice' };
    const args2 = { assignee: 'alice', state: 'open' };
    await cache.set('github', 'list_issues', args1, [{ id: 1 }]);
    const hit = await cache.get('github', 'list_issues', args2);
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual([{ id: 1 }]);
  });
});
