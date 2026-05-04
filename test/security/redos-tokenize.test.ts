/**
 * T3: ReDoS tokenize test.
 *
 * Sends pathological inputs to each PII matcher to detect catastrophic
 * backtracking (ReDoS). Each tokenize() call must complete in < 100 ms.
 *
 * @module test/security/redos-tokenize
 */

import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/utils/tokenize.js';
import type { BuiltinMatcherName } from '../../src/utils/tokenize.js';

const MAX_MS = 100; // per PRD §6.3

/** Pathological near-miss inputs per matcher — crafted to maximise backtracking. */
const PATHOLOGICAL: Record<BuiltinMatcherName, string[]> = {
  email: [
    'a'.repeat(200) + '@',
    ('a.').repeat(100) + 'b',
    'user@host' + '.a'.repeat(100),
    ('x'.repeat(50) + '@').repeat(20) + 'end',
  ],
  phone: [
    '1'.repeat(200),
    ('1-').repeat(100),
    ('(123) ').repeat(50),
  ],
  ssn: [
    ('12-').repeat(100),
    '123-45-' + '6'.repeat(200),
  ],
  credit_card: [
    '4'.repeat(200),
    ('1234 ').repeat(50),
    '4532015112830' + '0'.repeat(100),
  ],
  iban: [
    'GB' + '8'.repeat(200),
    ('GB12').repeat(50),
  ],
  ipv4: [
    '1.2.3.4.5.6.7.8.' + '9'.repeat(100),
    '255.255.255.' + '2'.repeat(100),
    '.'.repeat(200),
  ],
  ipv6: [
    ('abcd:').repeat(20),
    'a'.repeat(4) + ':' + 'b'.repeat(100),
    '::' + ('ffff:').repeat(20),
  ],
};

describe('T3 redos-tokenize', () => {
  for (const [matcherName, inputs] of Object.entries(PATHOLOGICAL) as [BuiltinMatcherName, string[]][]) {
    describe(`matcher: ${matcherName}`, () => {
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        it(`pathological input #${i + 1} completes in < ${MAX_MS}ms`, () => {
          const payload = { data: input };
          const t0 = Date.now();
          tokenize(payload, [matcherName]);
          const elapsed = Date.now() - t0;
          expect(elapsed).toBeLessThan(MAX_MS);
        });
      }
    });
  }

  it('large mixed-PII object with pathological fields tokenizes in < 500ms', () => {
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      largeObj[`field_${i}`] = i % 7 === 0 ? 'user@example.com' : `value-${'x'.repeat(50)}-${i}`;
    }
    const t0 = Date.now();
    tokenize(largeObj, ['email', 'phone', 'credit_card', 'ipv4']);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
