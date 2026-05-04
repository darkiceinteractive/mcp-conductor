import { describe, it, expect } from 'vitest';
import {
  stableJsonStringify,
  hashArgs,
  buildCacheKey,
  cacheKeyToString,
  parseCacheKey,
} from '../../../src/cache/key.js';

describe('stableJsonStringify', () => {
  it('sorts object keys deterministically', () => {
    const a = stableJsonStringify({ z: 1, a: 2, m: 3 });
    const b = stableJsonStringify({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('preserves array order', () => {
    const result = stableJsonStringify([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles nested objects', () => {
    const a = stableJsonStringify({ b: { y: 1, x: 2 }, a: 3 });
    const b = stableJsonStringify({ a: 3, b: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it('handles null and primitives', () => {
    expect(stableJsonStringify(null)).toBe('null');
    expect(stableJsonStringify(42)).toBe('42');
    expect(stableJsonStringify('hello')).toBe('"hello"');
    expect(stableJsonStringify(true)).toBe('true');
  });

  it('handles arrays of objects (sorts keys inside each object)', () => {
    const result = stableJsonStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }]);
    expect(result).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe('hashArgs', () => {
  it('same args produce same hash regardless of key order', () => {
    const h1 = hashArgs({ z: 1, a: 2 });
    const h2 = hashArgs({ a: 2, z: 1 });
    expect(h1).toBe(h2);
  });

  it('different args produce different hashes', () => {
    const h1 = hashArgs({ id: 1 });
    const h2 = hashArgs({ id: 2 });
    expect(h1).not.toBe(h2);
  });

  it('large nested objects hash deterministically', () => {
    const args = {
      filters: { status: 'open', assignee: 'alice', labels: ['bug', 'high'] },
      pagination: { page: 1, perPage: 50 },
      sort: 'created_at',
    };
    const h1 = hashArgs(args);
    const h2 = hashArgs(args);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('null and undefined args both hash stably', () => {
    const h1 = hashArgs(null);
    const h2 = hashArgs(undefined);
    // Both serialize to a deterministic string
    expect(h1).toHaveLength(64);
    expect(h2).toHaveLength(64);
  });
});

describe('buildCacheKey', () => {
  it('returns structured key with 64-char argsHash', () => {
    const key = buildCacheKey('github', 'list_issues', { state: 'open' });
    expect(key.server).toBe('github');
    expect(key.tool).toBe('list_issues');
    expect(key.argsHash).toHaveLength(64);
  });
});

describe('cacheKeyToString / parseCacheKey', () => {
  it('round-trips a valid key', () => {
    const key = buildCacheKey('github', 'list_issues', { state: 'open' });
    const str = cacheKeyToString(key);
    const parsed = parseCacheKey(str);
    expect(parsed).toEqual(key);
  });

  it('key string has correct format', () => {
    const key = buildCacheKey('ibkr', 'get_quote', { symbol: 'AAPL' });
    const str = cacheKeyToString(key);
    expect(str).toMatch(/^ibkr:get_quote:[0-9a-f]{64}$/);
  });

  it('parseCacheKey returns null for invalid strings', () => {
    expect(parseCacheKey('')).toBeNull();
    expect(parseCacheKey('no-colons')).toBeNull();
    expect(parseCacheKey('server:tool:tooshort')).toBeNull();
  });
});
