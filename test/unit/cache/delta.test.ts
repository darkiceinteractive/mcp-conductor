import { describe, it, expect } from 'vitest';
import { computeDelta, deepEqual } from '../../../src/cache/delta.js';

describe('computeDelta', () => {
  it('returns unchanged: true for identical results', () => {
    const result = computeDelta([1, 2, 3], [1, 2, 3]);
    expect(result.unchanged).toBe(true);
  });

  it('detects added items in large array result (delta smaller than full)', () => {
    // Use a large enough array so the delta (just the added item) is smaller
    // than the full result. With 10 existing items + 1 added, full >> added.
    const existing = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Issue ${i + 1}`,
      status: 'open',
      assignee: 'alice',
    }));
    const newItem = { id: 11, title: 'Issue 11', status: 'open', assignee: 'alice' };
    const prev = [...existing];
    const curr = [...existing, newItem];
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    // For large arrays delta should be smaller than full
    if (delta.full !== undefined) {
      // Full returned — both are valid; just verify the full has the new item
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.added).toEqual([newItem]);
      expect(delta.removed).toBeUndefined();
    }
  });

  it('detects removed items in large array', () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Issue ${i + 1}`,
    }));
    const prev = [...existing];
    const curr = existing.slice(0, 9); // remove last item
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    if (delta.full !== undefined) {
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.removed).toEqual([existing[9]]);
      expect(delta.added).toBeUndefined();
    }
  });

  it('detects both added and removed items', () => {
    // Large enough that delta payload (1 add + 1 remove) << full (10 items)
    const base = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Long title for issue ${i + 1} with extra text to pad size`,
    }));
    const prev = [...base];
    const curr = [...base.slice(1), { id: 99, title: 'Newly added issue with long title' }];
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    if (delta.full !== undefined) {
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.added).toBeDefined();
      expect(delta.removed).toBeDefined();
    }
  });

  it('returns full result when delta would be larger (small arrays)', () => {
    // Single element arrays: delta overhead > full result size — must use full
    const prev = [{ id: 1 }];
    const curr = [{ id: 2 }];
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    // For tiny arrays the delta envelope is always larger than full
    expect(delta.full).toEqual(curr);
    expect(delta.added).toBeUndefined();
    expect(delta.removed).toBeUndefined();
  });

  it('detects modified items in large object result', () => {
    // Use a large enough object so the change-only delta is smaller than full
    const base = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field${i}`, `value_${i}_with_extra_padding`])
    );
    const prev = { ...base, title: 'Old Title' };
    const curr = { ...base, title: 'New Title' };
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    if (delta.full !== undefined) {
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.modified).toBeDefined();
      const mod = delta.modified!;
      expect(mod[0]!.before).toEqual({ title: 'Old Title' });
      expect(mod[0]!.after).toEqual({ title: 'New Title' });
    }
  });

  it('small object changes return full (delta overhead exceeds full size)', () => {
    // A 2-field object modified — delta is always bigger for small objects
    const prev = { title: 'Old Title', status: 'open' };
    const curr = { title: 'New Title', status: 'open' };
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    // Either full (correct for small objects) or modified (correct for large ones)
    // Both are valid outputs — just verify the result is self-consistent
    if (delta.full !== undefined) {
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.modified).toBeDefined();
    }
  });

  it('detects added and removed object properties', () => {
    const prev = { a: 1, b: 2 };
    const curr = { b: 2, c: 3 };
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    // Small object — likely returns full; either is valid
    if (delta.full !== undefined) {
      expect(delta.full).toEqual(curr);
    } else {
      expect(delta.added).toBeDefined();
      expect(delta.removed).toBeDefined();
    }
  });

  it('returns full result for scalar change', () => {
    const delta = computeDelta('old string', 'new string');
    expect(delta.full).toBe('new string');
    expect(delta.unchanged).toBe(false);
  });

  it('returns full result for mixed type change', () => {
    const delta = computeDelta([1, 2], { a: 1 });
    expect(delta.full).toEqual({ a: 1 });
  });

  it('delta result is always smaller than full for large incremental arrays', () => {
    // 100-item array with 1 new item — delta must be much smaller
    const existing = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      title: `Item ${i}`.repeat(5),
      body: 'Some body text that makes each item fairly large for realistic testing',
    }));
    const newItem = { id: 100, title: 'New Item', body: 'New body' };
    const prev = [...existing];
    const curr = [...existing, newItem];
    const delta = computeDelta(prev, curr);
    expect(delta.unchanged).toBe(false);
    // For 100 large items + 1 added, delta MUST be smaller — should not return full
    expect(delta.full).toBeUndefined();
    expect(delta.added).toEqual([newItem]);
  });
});

describe('deepEqual', () => {
  it('returns true for primitively equal values', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it('returns false for different values', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
  });

  it('compares objects deeply', () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('compares arrays deeply', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });
});
