import { describe, it, expect } from 'vitest';
import {
  generateExecutionId,
  estimateTokens,
  estimateTokensFromBytes,
  formatBytes,
  formatDuration,
  truncate,
  safeJsonParse,
  sleep,
  percentageChange,
  debounce,
} from '../../src/utils/helpers.js';

describe('helpers', () => {
  describe('generateExecutionId', () => {
    it('should generate a unique ID', () => {
      const id1 = generateExecutionId();
      const id2 = generateExecutionId();
      expect(id1).not.toBe(id2);
    });

    it('should generate an ID with expected format', () => {
      const id = generateExecutionId();
      // UUID v4 format: 8-4-4-4-12 hex characters
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens for simple text', () => {
      // ~4 chars per token
      const text = 'Hello world this is a test';
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(text.length);
    });

    it('should estimate based on character count / 4', () => {
      expect(estimateTokens('12345678')).toBe(2); // 8 chars / 4 = 2
      expect(estimateTokens('123456789')).toBe(3); // 9 chars / 4 = 2.25, ceil = 3
    });
  });

  describe('estimateTokensFromBytes', () => {
    it('should estimate tokens from byte count', () => {
      expect(estimateTokensFromBytes(0)).toBe(0);
      expect(estimateTokensFromBytes(8)).toBe(2);
      expect(estimateTokensFromBytes(100)).toBe(25);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds correctly', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(1000)).toBe('1.00s');
      expect(formatDuration(1500)).toBe('1.50s');
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0ms');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('should truncate long strings', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('should handle strings exactly at max length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('should handle very short max length', () => {
      expect(truncate('hello world', 3)).toBe('...');
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse<{ key: string }>('{"key": "value"}', { key: '' });
      expect(result).toEqual({ key: 'value' });
    });

    it('should return default for invalid JSON', () => {
      const result = safeJsonParse<{ key: string }>('invalid', { key: 'default' });
      expect(result).toEqual({ key: 'default' });
    });

    it('should return default for empty string', () => {
      const result = safeJsonParse<number[]>('', []);
      expect(result).toEqual([]);
    });
  });

  describe('sleep', () => {
    it('should delay for specified time', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
    });
  });

  describe('percentageChange', () => {
    it('should calculate positive change', () => {
      expect(percentageChange(100, 150)).toBe('+50.0%');
    });

    it('should calculate negative change', () => {
      expect(percentageChange(100, 50)).toBe('-50.0%');
    });

    it('should handle zero original', () => {
      expect(percentageChange(0, 100)).toBe('+∞%');
      expect(percentageChange(0, 0)).toBe('0%');
    });

    it('should handle no change', () => {
      expect(percentageChange(100, 100)).toBe('+0.0%');
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', async () => {
      let callCount = 0;
      const fn = () => {
        callCount++;
      };

      const debounced = debounce(fn, 50);

      // Call multiple times rapidly
      debounced();
      debounced();
      debounced();

      // Should not have called yet
      expect(callCount).toBe(0);

      // Wait for debounce
      await sleep(100);

      // Should have called once
      expect(callCount).toBe(1);
    });
  });
});
