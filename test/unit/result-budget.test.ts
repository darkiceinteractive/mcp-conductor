import { describe, it, expect } from 'vitest';
import {
  trimResultToBudget,
  estimateResultTokens,
} from '../../src/server/mcp-server.js';

describe('trimResultToBudget', () => {
  describe('under-budget pass-through', () => {
    it('returns the original value unchanged when already within budget', () => {
      const value = { hello: 'world' };
      const result = trimResultToBudget(value, 1000);
      expect(result.wasTrimmed).toBe(false);
      expect(result.result).toBe(value);
      expect(result.meta).toBeUndefined();
    });

    it('passes through a small array without trimming', () => {
      const arr = [1, 2, 3];
      const out = trimResultToBudget(arr, 500);
      expect(out.wasTrimmed).toBe(false);
      expect(out.result).toEqual(arr);
    });

    it('passes through a plain string without trimming', () => {
      const s = 'short string';
      const out = trimResultToBudget(s, 100);
      expect(out.wasTrimmed).toBe(false);
    });
  });

  describe('over-budget array trimming', () => {
    it('trims a large array to fit within the token budget', () => {
      // Build an array that is definitely over budget for 10 tokens
      const bigArray = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        description: 'some padding text to make each entry larger',
      }));
      const budget = 10;
      const out = trimResultToBudget(bigArray, budget);
      expect(out.wasTrimmed).toBe(true);
      expect(Array.isArray(out.result)).toBe(true);
      expect(estimateResultTokens(out.result)).toBeLessThanOrEqual(budget);
      expect(out.meta).toMatchObject({
        to_tokens: budget,
        original_bytes: expect.any(Number),
      });
      expect((out.meta as { original_bytes: number }).original_bytes).toBeGreaterThan(0);
    });

    it('attaches result_trimmed metadata with original_bytes', () => {
      const arr = Array.from({ length: 500 }, (_, i) => i);
      const out = trimResultToBudget(arr, 5);
      expect(out.wasTrimmed).toBe(true);
      expect(out.meta?.original_bytes).toBeGreaterThan(0);
    });
  });

  describe('over-budget object trimming', () => {
    it('trims a large object to fit within the token budget', () => {
      const bigObj: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        bigObj[`field_${i}`] = 'x'.repeat(200);
      }
      const budget = 20;
      const out = trimResultToBudget(bigObj, budget);
      expect(out.wasTrimmed).toBe(true);
      expect(estimateResultTokens(out.result)).toBeLessThanOrEqual(budget);
    });
  });

  describe('string fallback clip', () => {
    it('clips a single very large string to the token budget', () => {
      const huge = 'a'.repeat(10_000);
      const budget = 10;
      const out = trimResultToBudget(huge, budget);
      expect(out.wasTrimmed).toBe(true);
      // The clipped result should be a string ending with the trim marker
      expect(typeof out.result).toBe('string');
      expect((out.result as string).endsWith('…[trimmed]')).toBe(true);
    });
  });

  describe('estimateResultTokens', () => {
    it('returns 0 for an empty object', () => {
      expect(estimateResultTokens({})).toBe(1); // '{}' is 2 chars => ceil(2/3.8)=1
    });

    it('estimates proportional to JSON length', () => {
      const small = { a: 1 };
      const large = { a: 'x'.repeat(380) };
      expect(estimateResultTokens(large)).toBeGreaterThan(estimateResultTokens(small));
    });

    it('rounds up', () => {
      // JSON.stringify(null) = 'null' = 4 chars; ceil(4/3.8) = 2
      expect(estimateResultTokens(null)).toBe(2);
    });
  });
});
