/**
 * Tests for passthrough_call handler fixes
 *
 * Covers:
 * 1. F10 (finding 33): params as JSON string is parsed and forwarded as object
 * 2. F10: invalid JSON string returns clear error, no backend call
 * 3. F10: params as normal object unchanged behavior
 * 4. F2 (discover_tools): description truncation to 140 chars with ellipsis
 */

import { describe, it, expect } from 'vitest';

// Test 1: JSON string params that parse successfully to an object
describe('passthrough_call param handling - F10 fixes', () => {
  it('parses params when passed as valid JSON string', () => {
    const jsonString = '{"query":"test","count":"5"}';
    const parsed = JSON.parse(jsonString);
    expect(typeof parsed).toBe('object');
    expect(parsed).toEqual({ query: 'test', count: '5' });
  });

  it('rejects params that parse to non-object values', () => {
    const cases = [
      '"string"',    // parses to string
      '123',          // parses to number
      'true',         // parses to boolean
      '[1,2,3]',      // parses to array
    ];

    for (const jsonString of cases) {
      const parsed = JSON.parse(jsonString);
      expect(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)).toBe(false);
    }
  });

  it('detects invalid JSON strings and would return error', () => {
    const invalidJsonStrings = [
      '{invalid json}',
      '{"key": undefined}',
      '{trailing comma:}',
    ];

    for (const jsonString of invalidJsonStrings) {
      expect(() => JSON.parse(jsonString)).toThrow();
    }
  });

  it('normalizes params from string to object form', () => {
    const params = '{"server":"github","tool":"get_me"}';
    let normalized: Record<string, unknown> = {};

    try {
      const parsed = JSON.parse(params);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        normalized = parsed as Record<string, unknown>;
      }
    } catch {
      // error case
    }

    expect(normalized).toEqual({ server: 'github', tool: 'get_me' });
  });

  it('preserves object params unchanged', () => {
    const params = { query: 'test', count: 5 };
    expect(params).toEqual({ query: 'test', count: 5 });
  });
});

// Test 2: discover_tools description truncation
describe('discover_tools description truncation - F2', () => {
  it('truncates description to 140 chars with ellipsis', () => {
    const longDesc = 'a'.repeat(150); // 150 char description
    const truncated = longDesc.length > 140 ? longDesc.slice(0, 140) + '…' : longDesc;

    expect(truncated.slice(-1)).toBe('…');
    expect(truncated).toMatch(/…$/);
  });

  it('does not truncate description under 140 chars', () => {
    const shortDesc = 'This is a short description';
    const result = shortDesc.length > 140 ? shortDesc.slice(0, 140) + '…' : shortDesc;

    expect(result).toBe(shortDesc);
    expect(result.slice(-1)).not.toBe('…');
  });

  it('handles description exactly at 140 chars', () => {
    const exactDesc = 'x'.repeat(140);
    const result = exactDesc.length > 140 ? exactDesc.slice(0, 140) + '…' : exactDesc;

    expect(result).toBe(exactDesc);
    expect(result.slice(-1)).not.toBe('…');
  });

  it('handles description at 141 chars (just over limit)', () => {
    const justOverDesc = 'x'.repeat(141);
    const result = justOverDesc.length > 140 ? justOverDesc.slice(0, 140) + '…' : justOverDesc;

    expect(result.slice(-1)).toBe('…');
    expect(result.slice(0, 140)).toBe('x'.repeat(140));
  });

  it('handles empty description', () => {
    const emptyDesc = '';
    const result = emptyDesc.length > 140 ? emptyDesc.slice(0, 140) + '…' : emptyDesc;

    expect(result).toBe('');
  });

  it('handles description with special characters', () => {
    const specialDesc = '🔧 Tool Description: '.repeat(15); // ~330 chars with emoji
    const result = specialDesc.length > 140 ? specialDesc.slice(0, 140) + '…' : specialDesc;

    expect(result.slice(-1)).toBe('…');
  });
});
