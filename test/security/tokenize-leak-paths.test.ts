/**
 * T3: Tokenize PII leak path tests.
 *
 * Verifies every possible PII leak vector in the tokenization pipeline:
 *   - Email, phone, SSN, credit card, IBAN, IPv4, IPv6 in nested structures.
 *   - PII embedded in Error-like message strings.
 *   - Token-savings reporter output must not contain real PII values.
 *
 * @module test/security/tokenize-leak-paths
 */

import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/utils/tokenize.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const EMAIL = 'user@example.com';
const PHONE = '555-867-5309';
const SSN = '123-45-6789';
const CC = '4532015112830366'; // valid Luhn
const IBAN = 'GB82WEST12345698765432';
const IPV4 = '192.168.100.200';
const IPV6 = '2001:db8::1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function containsPII(value: unknown): boolean {
  const str = JSON.stringify(value);
  return (
    str.includes(EMAIL) ||
    str.includes(PHONE) ||
    str.includes(SSN) ||
    str.includes(CC) ||
    str.includes(IBAN) ||
    str.includes(IPV4) ||
    str.includes(IPV6)
  );
}

describe('T3 tokenize-leak-paths', () => {
  it('flat object with all PII types has no raw values after tokenize', () => {
    const input = {
      email: EMAIL,
      phone: PHONE,
      ssn: SSN,
      cc: CC,
      iban: IBAN,
      ipv4: IPV4,
      ipv6: IPV6,
    };

    const { redacted } = tokenize(input, ['email', 'phone', 'ssn', 'credit_card', 'iban', 'ipv4', 'ipv6']);
    expect(containsPII(redacted)).toBe(false);
  });

  it('deeply nested PII is redacted at every level', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            contact: { email: EMAIL, phone: PHONE },
            payment: { cc: CC, iban: IBAN },
          },
        },
      },
    };

    const { redacted } = tokenize(input, ['email', 'phone', 'credit_card', 'iban']);
    expect(containsPII(redacted)).toBe(false);
  });

  it('PII inside array strings is redacted', () => {
    const input = {
      users: [
        `Contact ${EMAIL} for support`,
        `Call us at ${PHONE}`,
      ],
    };

    const { redacted } = tokenize(input, ['email', 'phone']);
    expect(containsPII(redacted)).toBe(false);
  });

  it('PII inside error-like message strings is redacted', () => {
    const input = {
      error: {
        message: `Authentication failed for ${EMAIL} from ${IPV4}`,
        stack: `Error: auth failed\n  at login (auth.js:42)\n  email=${EMAIL}`,
        code: 'AUTH_FAIL',
      },
    };

    const { redacted } = tokenize(input, ['email', 'ipv4']);
    expect(containsPII(redacted)).toBe(false);
  });

  it('reverse map contains original values but tokenized output does not', () => {
    const input = { email: EMAIL, ipv6: IPV6 };

    const { redacted, reverseMap } = tokenize(input, ['email', 'ipv6']);

    // The reverse map must contain the original values.
    const mapValues = Object.values(reverseMap);
    expect(mapValues.some((v) => v === EMAIL || v === IPV6)).toBe(true);

    // But those values must NOT appear in the tokenized payload.
    expect(containsPII(redacted)).toBe(false);
  });

  it('integer-valued fields are not corrupted by tokenization', () => {
    const input = {
      email: EMAIL,
      count: 42,
      price: 9.99,
      active: true,
    };

    const { redacted } = tokenize(input as Record<string, unknown>, ['email']);
    const out = redacted as Record<string, unknown>;
    expect(out['count']).toBe(42);
    expect(out['price']).toBe(9.99);
    expect(out['active']).toBe(true);
  });

  it('token-savings reporter output preserves numeric fields while redacting PII', () => {
    // Simulate a response that contains both PII data and a savings block.
    const rawResult = {
      result: { items: [{ email: EMAIL, amount: 100 }] },
      tokenSavings: {
        estimatedPassthroughTokens: 1000,
        actualExecutionTokens: 50,
        tokensSaved: 950,
        savingsPercent: 95.0,
      },
    };

    const { redacted } = tokenize(rawResult, ['email']);
    const out = redacted as typeof rawResult;

    // Savings block should be preserved intact.
    expect(out.tokenSavings.savingsPercent).toBe(95.0);
    expect(out.tokenSavings.tokensSaved).toBe(950);

    // PII must not appear anywhere.
    expect(containsPII(redacted)).toBe(false);
  });

  it('SSN appearing multiple times is fully redacted every occurrence', () => {
    const input = {
      note: `Primary SSN: ${SSN} and secondary SSN: ${SSN}`,
    };

    const { redacted } = tokenize(input, ['ssn']);
    expect(containsPII(redacted)).toBe(false);
  });

  it('no-op when no matchers requested — original value returned unchanged', () => {
    const input = { email: EMAIL };
    const { redacted } = tokenize(input, []);
    // With empty matchers, value is returned as-is.
    expect((redacted as typeof input).email).toBe(EMAIL);
  });
});
