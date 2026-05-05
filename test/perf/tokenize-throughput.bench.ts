/**
 * Tokenize-throughput benchmark — T1
 *
 * Measures the time to tokenize a 1 MB JSON payload with all six built-in
 * PII matchers active.
 *
 * PRD §6.1 threshold: 1 MB payload must complete in < 100ms.
 */

import { describe, test, expect } from 'vitest';
import { tokenize } from '../../src/utils/tokenize.js';
import { runBenchmark, emitBenchmarkResult } from './bench-utils.js';

// ---------------------------------------------------------------------------
// Generate a 1 MB synthetic JSON payload containing representative field
// names that trigger each of the six built-in PII matchers:
//   email, phone, ssn, creditCard, ipv4, apiKey
// ---------------------------------------------------------------------------
function generate1MbPayload(): string {
  const record = {
    id: 'record-0000',
    email: 'user@example.com',
    phone: '+1-555-867-5309',
    ssn: '123-45-6789',
    creditCard: '4111-1111-1111-1111',
    ipAddress: '192.168.1.100',
    apiKey: 'sk-proj-abcdef1234567890abcdef1234567890',
    description: 'A'.repeat(200),
    nested: {
      contactEmail: 'contact@corp.example.org',
      billingPhone: '(555) 234-5678',
      notes: 'B'.repeat(200),
    },
  };

  // Repeat the record until we exceed 1 MB.
  const single = JSON.stringify(record);
  const target = 1024 * 1024; // 1 MB
  const repeats = Math.ceil(target / single.length);
  const items = Array.from({ length: repeats }, (_, i) => ({
    ...record,
    id: `record-${String(i).padStart(4, '0')}`,
  }));
  return JSON.stringify({ results: items });
}

const PAYLOAD_1MB = generate1MbPayload();
const MATCHERS = ['email', 'phone', 'ssn', 'creditCard', 'ipv4', 'apiKey'] as const;

// Confirm the payload is actually ~1 MB.
const payloadBytes = Buffer.byteLength(PAYLOAD_1MB, 'utf8');

async function tokenizeFn(): Promise<void> {
  tokenize(PAYLOAD_1MB, MATCHERS);
}

describe('tokenize-throughput', () => {
  test('payload is approximately 1 MB', () => {
    expect(payloadBytes).toBeGreaterThanOrEqual(900_000);
    expect(payloadBytes).toBeLessThanOrEqual(2_000_000);
  });

  test('tokenize 1 MB in < 150ms (CI gate)', async () => {
    const result = await runBenchmark(tokenizeFn, {
      warmupIterations: 5,
      iterations: 20,
    });

    emitBenchmarkResult('tokenize-throughput-1mb', result, { p50: 150 });

    // p50 gate calibrated for shared GitHub runners (~115ms observed; local M-series ~30ms).
    expect(result.p50).toBeLessThan(150);
  });

  test('tokenize 1 MB p99 < 300ms (CI gate)', async () => {
    const result = await runBenchmark(tokenizeFn, {
      warmupIterations: 5,
      iterations: 20,
    });

    // p99 is 2× the p50 gate — allows for GC pauses on noisy CI infrastructure.
    expect(result.p99).toBeLessThan(300);
  });
});
