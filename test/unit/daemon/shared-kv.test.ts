/**
 * Unit tests for SharedKV — in-memory + disk-persistent key-value store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharedKV } from '../../../src/daemon/shared-kv.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-kv-test-'));
}

describe('SharedKV', () => {
  let persistDir: string;

  beforeEach(() => {
    persistDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeKV(namespace = 'test'): SharedKV {
    return new SharedKV({ persistDir, namespace, skipLoad: true, sweepIntervalMs: 999_999 });
  }

  // ---------------------------------------------------------------------------
  // Basic get / set / delete
  // ---------------------------------------------------------------------------

  describe('set then get from same client', () => {
    it('returns the stored value', () => {
      const kv = makeKV();
      kv.set('foo', 'bar');
      expect(kv.get('foo')).toBe('bar');
    });

    it('returns null for unknown key', () => {
      const kv = makeKV();
      expect(kv.get('missing')).toBeNull();
    });

    it('stores objects', () => {
      const kv = makeKV();
      kv.set('obj', { x: 1, y: [2, 3] });
      expect(kv.get('obj')).toEqual({ x: 1, y: [2, 3] });
    });

    it('overwrites existing value', () => {
      const kv = makeKV();
      kv.set('k', 'first');
      kv.set('k', 'second');
      expect(kv.get('k')).toBe('second');
    });
  });

  describe('delete', () => {
    it('removes a key', () => {
      const kv = makeKV();
      kv.set('a', 1);
      kv.delete('a');
      expect(kv.get('a')).toBeNull();
    });

    it('is a no-op for unknown key', () => {
      const kv = makeKV();
      expect(() => kv.delete('never-set')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // TTL expiry
  // ---------------------------------------------------------------------------

  describe('TTL expiry', () => {
    it('returns value before TTL expires', () => {
      const kv = makeKV();
      kv.set('temp', 'alive', { ttl: 60_000 });
      expect(kv.get('temp')).toBe('alive');
    });

    it('returns null after TTL expires', async () => {
      const kv = makeKV();
      kv.set('temp', 'gone', { ttl: 10 }); // 10 ms TTL
      await new Promise((r) => setTimeout(r, 20));
      expect(kv.get('temp')).toBeNull();
    });

    it('does not include expired key in list()', async () => {
      const kv = makeKV();
      kv.set('expire', 'x', { ttl: 10 });
      kv.set('persist', 'y');
      await new Promise((r) => setTimeout(r, 20));
      const keys = kv.list();
      expect(keys).not.toContain('expire');
      expect(keys).toContain('persist');
    });

    it('no TTL — entry persists indefinitely', async () => {
      const kv = makeKV();
      kv.set('forever', 42);
      await new Promise((r) => setTimeout(r, 20));
      expect(kv.get('forever')).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // list() with prefix
  // ---------------------------------------------------------------------------

  describe('list with prefix', () => {
    it('returns all keys when no prefix given', () => {
      const kv = makeKV();
      kv.set('a', 1);
      kv.set('b', 2);
      kv.set('c', 3);
      expect(kv.list().sort()).toEqual(['a', 'b', 'c']);
    });

    it('filters keys by prefix', () => {
      const kv = makeKV();
      kv.set('user:1', 'alice');
      kv.set('user:2', 'bob');
      kv.set('session:x', 'tok');
      expect(kv.list('user:')).toEqual(['user:1', 'user:2']);
    });

    it('returns empty array when no keys match prefix', () => {
      const kv = makeKV();
      kv.set('a', 1);
      expect(kv.list('z:')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Disk persistence
  // ---------------------------------------------------------------------------

  describe('disk persistence', () => {
    it('writes snapshot to disk on flushToDisk()', () => {
      const kv = makeKV('persist-test');
      kv.set('written', 'hello');
      kv.flushToDisk();

      // Load a fresh instance from the same dir / namespace.
      const kv2 = new SharedKV({ persistDir, namespace: 'persist-test', sweepIntervalMs: 999_999 });
      expect(kv2.get('written')).toBe('hello');
      kv2.shutdown();
    });

    it('does not restore expired entries on load', async () => {
      const kv = new SharedKV({ persistDir, namespace: 'ttl-persist', skipLoad: true, sweepIntervalMs: 999_999 });
      kv.set('dead', 'x', { ttl: 10 });
      await new Promise((r) => setTimeout(r, 20));
      kv.flushToDisk(); // expired entry is still in map at flush time if sweep hasn't run

      const kv2 = new SharedKV({ persistDir, namespace: 'ttl-persist', sweepIntervalMs: 999_999 });
      // Loading skips entries whose expiresAt is in the past.
      expect(kv2.get('dead')).toBeNull();
      kv2.shutdown();
    });

    it('shutdown() flushes dirty state', async () => {
      const kv = makeKV('shutdown-test');
      kv.set('last', 'value');
      await kv.shutdown();

      const kv2 = new SharedKV({ persistDir, namespace: 'shutdown-test', sweepIntervalMs: 999_999 });
      expect(kv2.get('last')).toBe('value');
      kv2.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Size / clear
  // ---------------------------------------------------------------------------

  describe('size and clear', () => {
    it('tracks size', () => {
      const kv = makeKV();
      expect(kv.size).toBe(0);
      kv.set('a', 1);
      kv.set('b', 2);
      expect(kv.size).toBe(2);
    });

    it('clear() removes all entries', () => {
      const kv = makeKV();
      kv.set('a', 1);
      kv.set('b', 2);
      kv.clear();
      expect(kv.list()).toEqual([]);
    });

    it('clear(prefix) removes only matching entries', () => {
      const kv = makeKV();
      kv.set('ns:a', 1);
      kv.set('ns:b', 2);
      kv.set('other', 3);
      kv.clear('ns:');
      expect(kv.list()).toEqual(['other']);
    });
  });
});
