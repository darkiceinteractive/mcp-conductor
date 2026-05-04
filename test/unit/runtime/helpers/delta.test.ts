import { describe, it, expect, beforeEach } from 'vitest';
import { delta, clearSnapshots, registerCacheBridge } from '../../../../src/runtime/helpers/delta.js';

describe('delta', () => {
  beforeEach(() => { clearSnapshots(); });

  describe('first call (no previous snapshot)', () => {
    it('returns full result with changed=true', async () => {
      const data = { id: 1, name: 'test' };
      const result = await delta('github', 'get_issue', { id: 1 }, data);
      expect(result.changed).toBe(true);
      expect(result.delta).toEqual(data);
    });
  });

  describe('object diff', () => {
    it('returns changed=false when nothing changed', async () => {
      const data = { id: 1, state: 'open' };
      await delta('github', 'get_issue', { id: 1 }, data);
      const result = await delta('github', 'get_issue', { id: 1 }, data);
      expect(result.changed).toBe(false);
    });

    it('returns changed=true with changed keys when object changes', async () => {
      await delta('github', 'get_issue', { id: 1 }, { id: 1, state: 'open', title: 'Bug' });
      const result = await delta('github', 'get_issue', { id: 1 }, { id: 1, state: 'closed', title: 'Bug' });
      expect(result.changed).toBe(true);
      expect(result.changedKeys).toContain('state');
      expect(result.changedKeys).not.toContain('id');
    });

    it('delta contains only the changed fields', async () => {
      await delta('github', 'get_issue', { id: 1 }, { id: 1, state: 'open' });
      const result = await delta('github', 'get_issue', { id: 1 }, { id: 1, state: 'closed' });
      const d = result.delta;
      expect(d.state).toBe('closed');
      expect(d.id).toBeUndefined();
    });

    it('returns DeltaResult identical to cache.delta shape', async () => {
      const result = await delta('svc', 'tool', {}, { x: 1 });
      expect(result).toHaveProperty('changed');
      expect(result).toHaveProperty('delta');
    });
  });

  describe('array diff', () => {
    it('detects added items', async () => {
      await delta('github', 'list_issues', {}, [1, 2]);
      const result = await delta('github', 'list_issues', {}, [1, 2, 3]);
      expect(result.changed).toBe(true);
      expect(result.added).toBe(1);
      expect(result.removed).toBe(0);
    });

    it('detects removed items', async () => {
      await delta('github', 'list_issues', {}, [1, 2, 3]);
      const result = await delta('github', 'list_issues', {}, [1, 2]);
      expect(result.changed).toBe(true);
      expect(result.removed).toBe(1);
    });

    it('returns changed=false for identical arrays', async () => {
      const arr = [{ id: 1 }, { id: 2 }];
      await delta('github', 'list_issues', {}, arr);
      const result = await delta('github', 'list_issues', {}, arr);
      expect(result.changed).toBe(false);
    });
  });

  describe('key isolation', () => {
    it('snapshots are keyed per server+tool+args', async () => {
      await delta('github', 'get_issue', { id: 1 }, { state: 'open' });
      const result = await delta('github', 'get_issue', { id: 2 }, { state: 'open' });
      expect(result.changed).toBe(true);
    });
  });

  describe('cache bridge delegation', () => {
    it('delegates to registered cache bridge', async () => {
      const bridgeResult = { changed: true, delta: { id: 42 }, changedKeys: ['id'] };
      registerCacheBridge({ delta: async () => bridgeResult });
      const result = await delta('test', 'tool', {}, { id: 42 });
      expect(result).toEqual(bridgeResult);
      // restore fallback
      registerCacheBridge({ delta: async (_s, _t, _a, current) => ({ changed: true, delta: current }) });
      clearSnapshots();
    });
  });
});
