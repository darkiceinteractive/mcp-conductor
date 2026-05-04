import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DiskCache } from '../../../src/cache/disk.js';
import type { DiskEntry } from '../../../src/cache/disk.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'conductor-disk-cache-test-'));
}

function makeEntry(overrides: Partial<DiskEntry> = {}): DiskEntry {
  return {
    value: { issues: [{ id: 1, title: 'Test' }] },
    storedAt: Date.now(),
    ttlMs: 60_000,
    server: 'github',
    tool: 'list_issues',
    ...overrides,
  };
}

describe('DiskCache', () => {
  let tmpDir: string;
  let cache: DiskCache;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    cache = new DiskCache({ diskDir: tmpDir });
  });

  const cleanup = async () => {
    await rm(tmpDir, { recursive: true, force: true });
  };

  it('get returns null on miss', async () => {
    const result = await cache.get('a'.repeat(64));
    expect(result).toBeNull();
    await cleanup();
  });

  it('CBOR encoding round-trips lossless', async () => {
    const entry = makeEntry({ value: { nested: { arr: [1, 2, 3], flag: true } } });
    const hash = 'a'.repeat(64);
    await cache.set(hash, entry);
    const hit = await cache.get(hash);
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual(entry.value);
    expect(hit!.source).toBe('disk');
    await cleanup();
  });

  it('persists across instance restart', async () => {
    const entry = makeEntry();
    const hash = 'b'.repeat(64);
    await cache.set(hash, entry);
    // New instance pointing at same dir
    const cache2 = new DiskCache({ diskDir: tmpDir });
    const hit = await cache2.get(hash);
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual(entry.value);
    await cleanup();
  });

  it('returns hit with ttlMs metadata even for expired entries (TTL enforcement is caller responsibility)', async () => {
    // DiskCache does NOT enforce TTL — it returns the hit with ttlMs so CacheLayer
    // can decide whether to apply SWR or hard-expire.
    const hash = 'c'.repeat(64);
    const entry = makeEntry({ storedAt: Date.now() - 120_000, ttlMs: 60_000 }); // expired
    await cache.set(hash, entry);
    const hit = await cache.get(hash);
    // Hit is returned — DiskCache does not enforce TTL
    expect(hit).not.toBeNull();
    expect(hit!.ttlMs).toBe(60_000);
    // The staleness is > ttlMs, so the caller (CacheLayer) should treat it as stale
    expect(hit!.staleness).toBeGreaterThan(60_000);
    await cleanup();
  });

  it('parallel writes do not corrupt store', async () => {
    const entry = makeEntry();
    const writes = Array.from({ length: 10 }, (_, i) =>
      cache.set(i.toString().padStart(64, '0'), entry)
    );
    await Promise.all(writes);
    const reads = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        cache.get(i.toString().padStart(64, '0'))
      )
    );
    expect(reads.every((r) => r !== null)).toBe(true);
    await cleanup();
  });

  it('rotates oldest when over maxDiskBytes', async () => {
    const smallCache = new DiskCache({ diskDir: tmpDir, maxDiskBytes: 5 * 1024 });
    const bigValue = 'x'.repeat(1800);
    const entries = Array.from({ length: 5 }, (_, i) =>
      smallCache.set(
        i.toString().padStart(64, '0'),
        makeEntry({ value: bigValue, storedAt: Date.now() - (5 - i) * 1000 })
      )
    );
    await Promise.all(entries);
    // Give rotation time (fire-and-forget)
    await new Promise((r) => setTimeout(r, 300));
    const surviving = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        smallCache.get(i.toString().padStart(64, '0'))
      )
    );
    const nullCount = surviving.filter((r) => r === null).length;
    expect(nullCount).toBeGreaterThan(0);
    await cleanup();
  });

  it('invalidateServer removes entries for that server only', async () => {
    const githubEntry = makeEntry({ server: 'github', tool: 'list_issues' });
    const ibkrEntry = makeEntry({ server: 'ibkr', tool: 'get_quote' });
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    await cache.set(hash1, githubEntry);
    await cache.set(hash2, ibkrEntry);
    await cache.invalidateServer('github');
    expect(await cache.get(hash1)).toBeNull();       // github gone
    expect(await cache.get(hash2)).not.toBeNull();   // ibkr survives
    await cleanup();
  });
});
