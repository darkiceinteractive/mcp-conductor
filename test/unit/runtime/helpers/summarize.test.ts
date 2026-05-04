import { describe, it, expect } from 'vitest';
import { summarize } from '../../../../src/runtime/helpers/summarize.js';

const CHARS_PER_TOKEN = 4;
function tokenLen(s) { return Math.ceil(s.length / CHARS_PER_TOKEN); }

describe('summarize', () => {
  const issues = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    title: `Issue ${i + 1} with a relatively long title that takes space`,
    state: i % 2 === 0 ? 'open' : 'closed',
  }));

  describe('respects maxTokens', () => {
    it('respects maxTokens for arrays (list style)', () => {
      const result = summarize(issues, { maxTokens: 100, style: 'list' });
      expect(tokenLen(result)).toBeLessThanOrEqual(105);
    });
    it('respects maxTokens for arrays (paragraph style)', () => {
      const result = summarize(issues, { maxTokens: 50, style: 'paragraph' });
      expect(tokenLen(result)).toBeLessThanOrEqual(55);
    });
    it('respects maxTokens for arrays (json style)', () => {
      const result = summarize(issues, { maxTokens: 200, style: 'json' });
      expect(tokenLen(result)).toBeLessThanOrEqual(205);
    });
    it('respects maxTokens for objects', () => {
      const obj = { description: 'x'.repeat(2000), items: issues };
      const result = summarize(obj, { maxTokens: 100, style: 'list' });
      expect(tokenLen(result)).toBeLessThanOrEqual(105);
    });
  });

  describe('style shapes', () => {
    it('list style produces expected shape for arrays', () => {
      const result = summarize([{ name: 'Alice' }, { name: 'Bob' }], { maxTokens: 500, style: 'list' });
      expect(result).toContain('•');
    });
    it('paragraph style produces expected shape for arrays', () => {
      const result = summarize([1, 2, 3], { maxTokens: 500, style: 'paragraph' });
      expect(result).toMatch(/\d+ items?/);
    });
    it('json style produces valid JSON for small data', () => {
      const small = { id: 1, name: 'test' };
      const result = summarize(small, { maxTokens: 500, style: 'json' });
      expect(() => JSON.parse(result)).not.toThrow();
    });
    it('list style handles object input', () => {
      const result = summarize({ a: 1, b: 2, c: 3 }, { maxTokens: 500, style: 'list' });
      expect(result).toContain('a:');
    });
    it('paragraph style handles objects', () => {
      const result = summarize({ id: 1, name: 'test' }, { maxTokens: 500, style: 'paragraph' });
      expect(result).toContain('Object with');
    });
    it('defaults to list style when not specified', () => {
      const result = summarize([{ x: 1 }], { maxTokens: 500 });
      expect(result).toContain('•');
    });
  });

  describe('edge cases', () => {
    it('handles empty array', () => {
      const result = summarize([], { maxTokens: 100, style: 'list' });
      expect(typeof result).toBe('string');
    });
    it('handles string input', () => {
      const result = summarize('hello world', { maxTokens: 10 });
      expect(result).toBeTruthy();
    });
    it('handles null input', () => {
      const result = summarize(null, { maxTokens: 10 });
      expect(typeof result).toBe('string');
    });
  });
});
