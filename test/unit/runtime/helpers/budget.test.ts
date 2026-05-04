import { describe, it, expect } from 'vitest';
import { budget, BudgetExceededError, estimateTokens } from '../../../../src/runtime/helpers/budget.js';

describe('budget', () => {
  describe('estimateTokens', () => {
    it('estimates tokens for strings', () => { expect(estimateTokens('hello')).toBeGreaterThan(0); });
    it('estimates tokens for objects', () => { expect(estimateTokens({ id: 1, name: 'test' })).toBeGreaterThan(0); });
    it('estimates tokens for arrays', () => {
      expect(estimateTokens(Array.from({ length: 10 }, (_, i) => ({ id: i })))).toBeGreaterThan(0);
    });
  });

  describe('within budget', () => {
    it('returns result unchanged when within budget', async () => {
      const data = { id: 1, name: 'test' };
      expect(await budget(1000, async () => data)).toEqual(data);
    });
    it('works with synchronous fn', async () => {
      expect(await budget(1000, () => 42)).toBe(42);
    });
  });

  describe('auto-trim', () => {
    it('auto-trims oversized result', async () => {
      const bigArray = Array.from({ length: 500 }, (_, i) => ({
        id: i,
        title: `Issue ${i} with a fairly long title to consume tokens`,
        body: `Body text for issue ${i} which is also somewhat long`,
      }));
      const result = await budget(200, async () => bigArray);
      expect(estimateTokens(result)).toBeLessThanOrEqual(400);
    });

    it('auto-trims oversized object result', async () => {
      const bigObj = {};
      for (let i = 0; i < 100; i++) bigObj[`field_${i}`] = `value number ${i} which is a long string`;
      const result = await budget(100, async () => bigObj);
      expect(estimateTokens(result)).toBeLessThanOrEqual(300);
    });
  });

  describe('BudgetExceededError', () => {
    it('throws BudgetExceededError when untrimmable', async () => {
      await expect(budget(1, async () => 'hello world this is a test')).rejects.toBeInstanceOf(BudgetExceededError);
    });

    it('BudgetExceededError has correct properties', async () => {
      try {
        await budget(1, async () => 'hello world this is a test');
      } catch (err) {
        const e = err;
        expect(e).toBeInstanceOf(BudgetExceededError);
        expect(e.maxTokens).toBe(1);
        expect(e.estimatedTokens).toBeGreaterThan(1);
        expect(e.name).toBe('BudgetExceededError');
      }
    });
  });
});
