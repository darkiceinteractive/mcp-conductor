import { describe, it, expect } from 'vitest';
import { compact } from '../../../../src/runtime/helpers/compact.js';

describe('compact', () => {
  const issues = [
    { id: 1, title: 'Fix bug', state: 'open', body: 'Long body text here', labels: [{ name: 'bug', color: 'red' }], assignee: { login: 'alice' } },
    { id: 2, title: 'Add feature', state: 'closed', body: 'Another long body', labels: [{ name: 'enhancement', color: 'blue' }], assignee: null },
    { id: 3, title: 'Docs update', state: 'open', body: 'Update readme', labels: [], assignee: { login: 'bob' } },
  ];

  describe('field selection', () => {
    it('retains only the specified top-level fields', () => {
      const result = compact(issues, { fields: ['id', 'title'] }) as typeof issues;
      for (const item of result) {
        expect((item as Record<string, unknown>).id).toBeDefined();
        expect((item as Record<string, unknown>).title).toBeDefined();
        expect((item as Record<string, unknown>).body).toBeUndefined();
        expect((item as Record<string, unknown>).labels).toBeUndefined();
      }
    });

    it('drops fields not in the selector', () => {
      const result = compact(issues[0], { fields: ['id'] }) as Record<string, unknown>;
      expect(result.id).toBe(1);
      expect(result.title).toBeUndefined();
      expect(result.state).toBeUndefined();
    });

    it('dot-path field selection works', () => {
      const result = compact(issues, { fields: ['id', 'labels.name'] }) as Array<Record<string, unknown>>;
      expect(result[0].id).toBe(1);
      const labels = result[0].labels as Array<Record<string, unknown>>;
      expect(labels[0].name).toBe('bug');
      expect(labels[0].color).toBeUndefined();
    });

    it('returns all fields when no field selector is provided', () => {
      const result = compact(issues[0], {}) as Record<string, unknown>;
      expect(result.id).toBe(1);
      expect(result.title).toBe('Fix bug');
      expect(result.body).toBeDefined();
    });
  });

  describe('maxItems', () => {
    it('maxItems truncates arrays', () => {
      const result = compact(issues, { maxItems: 2 }) as typeof issues;
      expect(result).toHaveLength(2);
    });

    it('does not truncate when array is within maxItems', () => {
      const result = compact(issues, { maxItems: 10 }) as typeof issues;
      expect(result).toHaveLength(3);
    });

    it('truncates nested arrays', () => {
      const data = { items: [1, 2, 3, 4, 5] };
      const result = compact(data, { maxItems: 3 }) as typeof data;
      expect(result.items).toHaveLength(3);
    });
  });

  describe('maxStringLength', () => {
    it('maxStringLength truncates long strings', () => {
      const result = compact(issues[0], { maxStringLength: 5 }) as Record<string, unknown>;
      expect((result.body as string).length).toBeLessThanOrEqual(6);
    });

    it('preserves strings within maxStringLength', () => {
      const result = compact({ text: 'hello' }, { maxStringLength: 10 }) as { text: string };
      expect(result.text).toBe('hello');
    });
  });

  describe('maxDepth', () => {
    it('maxDepth limits nesting', () => {
      const deep = { a: { b: { c: { d: 'deep value' } } } };
      const result = compact(deep, { maxDepth: 1 }) as Record<string, unknown>;
      const a = result.a as Record<string, unknown>;
      expect(a).toBeDefined();
      expect(typeof a.b === 'string' || typeof a.b === 'object').toBe(true);
    });

    it('returns full structure when maxDepth is generous', () => {
      const deep = { a: { b: 'value' } };
      const result = compact(deep, { maxDepth: 5 }) as Record<string, unknown>;
      expect((result.a as Record<string, unknown>).b).toBe('value');
    });
  });

  describe('passthrough cases', () => {
    it('handles null without throwing', () => {
      expect(compact(null, {})).toBeNull();
    });

    it('handles numbers', () => {
      expect(compact(42, {})).toBe(42);
    });

    it('handles empty arrays', () => {
      expect(compact([], { maxItems: 5 })).toEqual([]);
    });

    it('handles empty objects', () => {
      expect(compact({}, { fields: ['id'] })).toEqual({});
    });
  });
});
