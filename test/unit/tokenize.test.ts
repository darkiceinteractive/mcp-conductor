/**
 * Unit tests for src/utils/tokenize.ts (Workstream X4 — Agent J)
 *
 * ~12 focused cases covering every built-in matcher and the key
 * invariants from the acceptance criteria.
 */

import { describe, it, expect } from 'vitest';
import { tokenize, detokenize } from '../../src/utils/tokenize.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function tok(value: unknown, matchers: string[]) {
  return tokenize(value, matchers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — email', () => {
  it('replaces an email in a plain string', () => {
    const { redacted, reverseMap } = tok('contact x@y.com please', ['email']);
    expect(redacted).toBe('contact [EMAIL_1] please');
    expect(reverseMap['[EMAIL_1]']).toBe('x@y.com');
  });

  it('replaces email inside an object value', () => {
    const { redacted, reverseMap } = tok({ email: 'x@y.com', name: 'Alice' }, ['email']);
    expect((redacted as Record<string, unknown>).email).toBe('[EMAIL_1]');
    expect((redacted as Record<string, unknown>).name).toBe('Alice');
    expect(reverseMap['[EMAIL_1]']).toBe('x@y.com');
  });

  it('does NOT tokenize when email matcher is not requested', () => {
    const { redacted } = tok({ email: 'x@y.com' }, ['phone']);
    expect((redacted as Record<string, unknown>).email).toBe('x@y.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phone
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — phone', () => {
  it('replaces an international phone number', () => {
    const { redacted, reverseMap } = tok('+61 412 345 678', ['phone']);
    expect(redacted).toBe('[PHONE_1]');
    expect(reverseMap['[PHONE_1]']).toBe('+61 412 345 678');
  });

  it('replaces a US NANP format phone', () => {
    const { redacted, reverseMap } = tok('Call (555) 867-5309', ['phone']);
    expect(redacted).toBe('Call [PHONE_1]');
    expect(reverseMap['[PHONE_1]']).toBe('(555) 867-5309');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSN
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — SSN', () => {
  it('redacts dashed SSN format NNN-NN-NNNN', () => {
    const { redacted, reverseMap } = tok('SSN: 123-45-6789', ['ssn']);
    expect(redacted).toBe('SSN: [SSN_1]');
    expect(reverseMap['[SSN_1]']).toBe('123-45-6789');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credit card (Luhn)
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — credit_card', () => {
  it('redacts a Luhn-valid Visa number with spaces', () => {
    // 4111 1111 1111 1111 is the canonical Luhn test card
    const { redacted, reverseMap } = tok('card: 4111 1111 1111 1111', ['credit_card']);
    expect(redacted).toBe('card: [CC_1]');
    expect(reverseMap['[CC_1]']).toBe('4111 1111 1111 1111');
  });

  it('does NOT redact a 16-digit number that fails Luhn', () => {
    // 4111 1111 1111 1112 — last digit off, fails Luhn
    const { redacted } = tok('num: 4111 1111 1111 1112', ['credit_card']);
    expect(redacted).toBe('num: 4111 1111 1111 1112');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IBAN
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — IBAN', () => {
  it('redacts a valid German IBAN', () => {
    // DE89 3704 0044 0532 0130 00 — real Luhn-valid test IBAN
    const { redacted, reverseMap } = tok('iban: DE89 3704 0044 0532 0130 00', ['iban']);
    expect(redacted).toBe('iban: [IBAN_1]');
    expect(reverseMap['[IBAN_1]']).toBe('DE89 3704 0044 0532 0130 00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IP addresses
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — IPv4/IPv6', () => {
  it('redacts an IPv4 address', () => {
    const { redacted, reverseMap } = tok('server at 192.168.1.100', ['ipv4']);
    expect(redacted).toBe('server at [IPV4_1]');
    expect(reverseMap['[IPV4_1]']).toBe('192.168.1.100');
  });

  it('redacts a full IPv6 address', () => {
    const addr = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const { redacted, reverseMap } = tok(`addr: ${addr}`, ['ipv6']);
    expect(redacted).toBe('addr: [IPV6_1]');
    expect(reverseMap['[IPV6_1]']).toBe(addr);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency + multi-field
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenize — idempotency and multiple fields', () => {
  it('same email value receives same token when seen twice', () => {
    const { redacted, reverseMap } = tok(
      { a: 'x@y.com', b: 'x@y.com' },
      ['email']
    );
    const r = redacted as Record<string, unknown>;
    expect(r.a).toBe('[EMAIL_1]');
    expect(r.b).toBe('[EMAIL_1]');
    expect(Object.keys(reverseMap)).toHaveLength(1);
  });

  it('tokenizes multiple matchers in one call', () => {
    const { redacted, reverseMap } = tok(
      { email: 'x@y.com', phone: '+61 412 345 678' },
      ['email', 'phone']
    );
    const r = redacted as Record<string, unknown>;
    expect(r.email).toBe('[EMAIL_1]');
    expect(r.phone).toBe('[PHONE_1]');
    expect(Object.keys(reverseMap)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detokenize
// ─────────────────────────────────────────────────────────────────────────────

describe('detokenize', () => {
  it('returns the original value for a known token', () => {
    const { reverseMap } = tok({ email: 'x@y.com' }, ['email']);
    expect(detokenize('[EMAIL_1]', reverseMap)).toBe('x@y.com');
  });

  it('returns undefined for an unknown token', () => {
    expect(detokenize('[EMAIL_99]', {})).toBeUndefined();
  });
});
