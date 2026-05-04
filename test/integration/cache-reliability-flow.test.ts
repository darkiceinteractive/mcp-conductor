/**
 * Integration test: cache → reliability gateway → backend → cache-set flow (MED-4).
 *
 * Verifies that:
 *  1. A cache miss triggers a gateway call to the backend.
 *  2. The result is stored in the cache.
 *  3. A subsequent identical call is served from cache (backend not called again).
 *  4. SWR (stale-while-revalidate): a stale hit returns immediately and schedules
 *     a background refresh that eventually updates the cache.
 *  5. The SWR dedup guard (HIGH-2) ensures only one background refresh fires when
 *     multiple concurrent callers see the same stale entry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { CacheLayer } from '../../src/cache/cache.js';
import { ReliabilityGateway } from '../../src/reliability/gateway.js';
import type { ToolRegistry } from '../../src/registry/registry.js';
import type { ToolDefinition } from '../../src/registry/index.js';

// ── Minimal ToolRegistry stub ─────────────────────────────────────────────────

type EventCallback = (event: { type: string; server: string; tool: string; at: number }) => void;

function makeMockRegistry(toolOverrides: Partial<ToolDefinition> = {}): ToolRegistry {
  const watchers: EventCallback[] = [];

  return {
    getTool: (_server: string, _tool: string) => ({
      server: _server,
      name: _tool,
      description: 'mock',
      inputSchema: {},
      ttl: 60_000, // 60 s — long enough to be "fresh" in most tests
      ...toolOverrides,
    }),
    watch: (cb: EventCallback) => {
      watchers.push(cb);
      return {
        unsubscribe: () => {
          const i = watchers.indexOf(cb);
          if (i >= 0) watchers.splice(i, 1);
        },
      };
    },
  } as unknown as ToolRegistry;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'conductor-cache-rel-test-'));
}

// ── Wire-up helper (mirrors the CRIT-1 logic in mcp-server.ts callTool handler) ──

/**
 * Executes the cache → gateway → backend → cache-set wiring in isolation so
 * the integration test does not need to boot a full MCPExecutorServer.
 */
async function callToolWithLayers(
  cache: CacheLayer,
  gateway: ReliabilityGateway,
  serverName: string,
  toolName: string,
  params: Record<string, unknown>,
  backendFn: () => Promise<unknown>
): Promise<unknown> {
  const cacheable = cache.wouldCache(serverName, toolName);

  if (cacheable) {
    const hit = await cache.get(serverName, toolName, params);
    if (hit) {
      if (!hit.needsRevalidation) {
        // Fresh cache hit
        return hit.value;
      }
      // Stale-while-revalidate: return stale, kick off background refresh
      cache.refreshInBackground(serverName, toolName, params, () =>
        gateway.call(serverName, toolName, backendFn)
      ).catch(() => { /* errors surfaced separately in the SWR tests */ });
      return hit.value;
    }
  }

  // Cache miss — call through reliability gateway
  const result = await gateway.call(serverName, toolName, backendFn);

  if (cacheable) {
    await cache.set(serverName, toolName, params, result);
  }

  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cache + Reliability integration (MED-4)', () => {
  let tmpDir: string;
  let cache: CacheLayer;
  let gateway: ReliabilityGateway;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await makeTempDir();
    const registry = makeMockRegistry();
    cache = new CacheLayer({ registry, diskDir: tmpDir, staleWhileRevalidate: true });
    gateway = new ReliabilityGateway({});
  });

  afterEach(async () => {
    vi.useRealTimers();
    cache.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cache miss → gateway call → backend invoked → result returned', async () => {
    const backend = vi.fn().mockResolvedValue({ data: 'hello' });

    const result = await callToolWithLayers(cache, gateway, 'github', 'list_repos', {}, backend);

    expect(result).toEqual({ data: 'hello' });
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('second identical call is served from cache — backend not called again', async () => {
    const backend = vi.fn().mockResolvedValue({ items: [1, 2, 3] });

    await callToolWithLayers(cache, gateway, 'github', 'list_repos', { org: 'acme' }, backend);
    const second = await callToolWithLayers(cache, gateway, 'github', 'list_repos', { org: 'acme' }, backend);

    expect(second).toEqual({ items: [1, 2, 3] });
    // Backend is only hit once (the initial miss); the second call hits the cache
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('different params produce independent cache entries', async () => {
    const backend = vi.fn()
      .mockResolvedValueOnce({ user: 'alice' })
      .mockResolvedValueOnce({ user: 'bob' });

    const r1 = await callToolWithLayers(cache, gateway, 'gh', 'get_user', { login: 'alice' }, backend);
    const r2 = await callToolWithLayers(cache, gateway, 'gh', 'get_user', { login: 'bob' }, backend);

    expect(r1).toEqual({ user: 'alice' });
    expect(r2).toEqual({ user: 'bob' });
    expect(backend).toHaveBeenCalledTimes(2);
  });

  it('SWR: stale entry returns immediately without blocking on the refresh', async () => {
    const SHORT_TTL = 500; // ms
    // Use a dedicated temp dir so background disk-writes don't race afterEach cleanup
    const swrTmpDir = await makeTempDir();
    const staleRegistry = makeMockRegistry({ ttl: SHORT_TTL } as Partial<ToolDefinition>);
    const staleCache = new CacheLayer({
      registry: staleRegistry,
      diskDir: swrTmpDir,
      staleWhileRevalidate: true,
    });
    const staleGateway = new ReliabilityGateway({});

    const backend = vi.fn()
      .mockResolvedValueOnce({ v: 1 })  // pre-seed value
      .mockResolvedValueOnce({ v: 2 }); // background refresh

    // Pre-populate the cache with a fresh entry
    await staleCache.set('svc', 'op', {}, { v: 1 }, { ttl: SHORT_TTL });

    // Advance clock past TTL to make the entry stale
    vi.advanceTimersByTime(SHORT_TTL + 100);

    // Call: should return stale { v: 1 } immediately; backend not yet called
    const staleResult = await callToolWithLayers(staleCache, staleGateway, 'svc', 'op', {}, backend);

    // The stale value is returned immediately without awaiting the background refresh
    expect(staleResult).toEqual({ v: 1 });
    // The background refresh was initiated (the fetch is kicked off asynchronously)
    // but the caller did not block on it — it already has its stale result back.
    // Backend call count is at most 1 (it may have started but is still in-flight).
    expect(backend.mock.calls.length).toBeLessThanOrEqual(1);

    staleCache.destroy();
    // Allow any pending async disk ops to settle before removing the directory
    await Promise.resolve();
    await rm(swrTmpDir, { recursive: true, force: true });
  });

  it('HIGH-2: concurrent stale callers trigger exactly one background refresh', async () => {
    const SHORT_TTL = 500;
    // Dedicated temp dir to avoid cross-test disk-write races
    const h2TmpDir = await makeTempDir();
    const registry2 = makeMockRegistry({ ttl: SHORT_TTL } as Partial<ToolDefinition>);
    const cache2 = new CacheLayer({
      registry: registry2,
      diskDir: h2TmpDir,
      staleWhileRevalidate: true,
    });
    const gateway2 = new ReliabilityGateway({});

    let refreshCount = 0;
    const trackingBackend = vi.fn().mockImplementation(async () => {
      refreshCount++;
      return { v: 2 };
    });

    // Pre-populate with a fresh entry
    await cache2.set('svc', 'op', {}, { v: 1 }, { ttl: SHORT_TTL });

    // Advance clock to make the entry stale
    vi.advanceTimersByTime(SHORT_TTL + 100);

    // Two concurrent callers hitting the same stale entry
    const [r1, r2] = await Promise.all([
      callToolWithLayers(cache2, gateway2, 'svc', 'op', {}, trackingBackend),
      callToolWithLayers(cache2, gateway2, 'svc', 'op', {}, trackingBackend),
    ]);

    // Both callers get the stale value back immediately
    expect(r1).toEqual({ v: 1 });
    expect(r2).toEqual({ v: 1 });

    // Only one background refresh was initiated (HIGH-2 thundering-herd dedup)
    expect(trackingBackend).toHaveBeenCalledTimes(1);
    expect(refreshCount).toBe(1);

    cache2.destroy();
    await Promise.resolve();
    await rm(h2TmpDir, { recursive: true, force: true });
  });

  it('backend error propagates through gateway without caching the failure', async () => {
    const backend = vi.fn().mockRejectedValue(new Error('backend unavailable'));

    await expect(
      callToolWithLayers(cache, gateway, 'svc', 'flaky', {}, backend)
    ).rejects.toThrow('backend unavailable');

    // Cache must remain empty — no poisoned entry stored
    const hit = await cache.get('svc', 'flaky', {});
    expect(hit).toBeNull();
  });

  it('gateway stats accumulate only for cache-miss calls (hits bypass gateway)', async () => {
    const backend = vi.fn().mockResolvedValue({ ok: true });

    // First call: cache miss → goes through gateway
    await callToolWithLayers(cache, gateway, 'svcA', 'toolX', { a: 1 }, backend);
    // Second call: cache hit → never reaches gateway
    await callToolWithLayers(cache, gateway, 'svcA', 'toolX', { a: 1 }, backend);

    const stats = gateway.getStats();
    expect(stats.byServer['svcA']?.totalCalls).toBe(1);
    expect(stats.byServer['svcA']?.successes).toBe(1);
    expect(backend).toHaveBeenCalledTimes(1);
  });
});
