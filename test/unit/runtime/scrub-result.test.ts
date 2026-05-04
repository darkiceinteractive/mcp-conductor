/**
 * HIGH-1: __scrubResult PII scrubbing unit tests
 *
 * Verifies that the scrubResult helper (extracted from the sandbox preamble)
 * walks nested result objects/arrays and replaces any plaintext value that
 * appears in the reverse map back to its token form.
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// __scrubResult extracted from executor.ts template string for unit testing
// ─────────────────────────────────────────────────────────────────────────────

function scrubResult(value: unknown, reverseMap: Record<string, string>): unknown {
  const plainToToken: Record<string, string> = {};
  for (const [token, plain] of Object.entries(reverseMap)) {
    plainToToken[plain] = token;
  }
  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      return Object.prototype.hasOwnProperty.call(plainToToken, v) ? plainToToken[v] : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(vv);
      }
      return out;
    }
    return v;
  }
  if (Object.keys(reverseMap).length === 0) return value;
  return walk(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('HIGH-1: __scrubResult PII scrubbing', () => {
  describe('basic replacement', () => {
    it('replaces an exact string match at the top level', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult('x@y.com', reverseMap);
      expect(result).toBe('[EMAIL_1]');
    });

    it('leaves non-matching strings untouched', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult('safe-value', reverseMap);
      expect(result).toBe('safe-value');
    });

    it('is a no-op when reverseMap is empty', () => {
      const result = scrubResult({ email: 'x@y.com' }, {});
      expect((result as Record<string, unknown>).email).toBe('x@y.com');
    });
  });

  describe('object traversal', () => {
    it('replaces matched plaintext in a flat object', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com', '[PHONE_1]': '+61 412 345 678' };
      const result = scrubResult(
        { email: 'x@y.com', phone: '+61 412 345 678', id: 42 },
        reverseMap,
      ) as Record<string, unknown>;

      expect(result.email).toBe('[EMAIL_1]');
      expect(result.phone).toBe('[PHONE_1]');
      expect(result.id).toBe(42);
    });

    it('replaces matched plaintext in a nested object', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult(
        { user: { contact: { email: 'x@y.com' }, name: 'Alice' } },
        reverseMap,
      ) as Record<string, unknown>;

      const user = result.user as Record<string, unknown>;
      const contact = user.contact as Record<string, unknown>;
      expect(contact.email).toBe('[EMAIL_1]');
      expect(user.name).toBe('Alice');
    });

    it('replaces matched plaintext in arrays', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult(['x@y.com', 'unrelated'], reverseMap) as string[];
      expect(result[0]).toBe('[EMAIL_1]');
      expect(result[1]).toBe('unrelated');
    });

    it('replaces matched values in arrays of objects', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult(
        [{ email: 'x@y.com', id: 1 }, { email: 'other@example.com', id: 2 }],
        reverseMap,
      ) as Array<Record<string, unknown>>;
      expect(result[0].email).toBe('[EMAIL_1]');
      expect(result[1].email).toBe('other@example.com');
    });
  });

  describe('non-string values', () => {
    it('passes through numbers unchanged', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const result = scrubResult(42, reverseMap);
      expect(result).toBe(42);
    });

    it('passes through booleans unchanged', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      expect(scrubResult(true, reverseMap)).toBe(true);
      expect(scrubResult(false, reverseMap)).toBe(false);
    });

    it('passes through null unchanged', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      expect(scrubResult(null, reverseMap)).toBeNull();
    });

    it('passes through undefined unchanged', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      expect(scrubResult(undefined, reverseMap)).toBeUndefined();
    });
  });

  describe('PII scrubbing integration scenario', () => {
    it('mcp.detokenize return value is scrubbed back to token', () => {
      // Simulate: user code calls mcp.detokenize('[EMAIL_1]') → 'x@y.com'
      // and returns that plaintext value directly.
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const userCodeResult = 'x@y.com'; // what mcp.detokenize() returned
      const scrubbed = scrubResult(userCodeResult, reverseMap);
      // Claude sees token, not PII
      expect(scrubbed).toBe('[EMAIL_1]');
    });

    it('nested object containing detokenized value is fully scrubbed', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com', '[PHONE_1]': '+61 412 345 678' };
      const userCodeResult = {
        found: true,
        contact: {
          email: 'x@y.com',
          phone: '+61 412 345 678',
        },
        scores: [1, 2, 3],
      };
      const scrubbed = scrubResult(userCodeResult, reverseMap) as typeof userCodeResult;
      expect(scrubbed.contact.email).toBe('[EMAIL_1]');
      expect(scrubbed.contact.phone).toBe('[PHONE_1]');
      expect(scrubbed.found).toBe(true);
      expect(scrubbed.scores).toEqual([1, 2, 3]);
    });

    it('original result not containing any PII is returned unchanged', () => {
      const reverseMap = { '[EMAIL_1]': 'x@y.com' };
      const userCodeResult = { status: 'ok', count: 7 };
      const scrubbed = scrubResult(userCodeResult, reverseMap) as typeof userCodeResult;
      expect(scrubbed.status).toBe('ok');
      expect(scrubbed.count).toBe(7);
    });
  });
});
