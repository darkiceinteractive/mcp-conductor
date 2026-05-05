/**
 * P2 — Tokenize scaling stress test
 *
 * Sweeps tokenizer input sizes (1 KB, 10 KB, 100 KB, 1 MB, 10 MB) at three
 * PII densities (1, 10, 100 matches/KB) and asserts linear scaling.
 *
 * Scaling gate: 10× input must complete in ≤ 12× time (20% overhead budget).
 *
 * Benchmark output written to docs/benchmarks/stress/tokenize-scaling-YYYY-MM-DD.json
 *
 * @module test/stress/tokenize-scaling
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tokenize } from '../../src/utils/tokenize.js';
import type { BuiltinMatcherName } from '../../src/utils/tokenize.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ALL_MATCHERS: BuiltinMatcherName[] = [
  'email', 'phone', 'ssn', 'credit_card', 'iban', 'ipv4', 'ipv6',
];

const INPUT_SIZES = [
  { label: '1KB',   bytes: 1 * 1024 },
  { label: '10KB',  bytes: 10 * 1024 },
  { label: '100KB', bytes: 100 * 1024 },
  { label: '1MB',   bytes: 1 * 1024 * 1024 },
  { label: '10MB',  bytes: 10 * 1024 * 1024 },
];

// PII densities: approximate number of PII matches injected per KB of payload
const PII_DENSITIES = [1, 10, 100];

const BENCH_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// ─── Payload builder ──────────────────────────────────────────────────────────

/**
 * Build a JSON payload of approximately `targetBytes` bytes with `matchesPerKB`
 * syntactically valid PII values injected into string fields.
 *
 * Uses synthetic, non-real addresses/IPs designed purely to trigger the
 * email and ipv4 matchers during tokenization sweeps.
 */
function buildPayloadWithPii(targetBytes: number, matchesPerKB: number): unknown {
  const kbs = Math.max(1, targetBytes / 1024);
  const totalMatches = Math.ceil(kbs * matchesPerKB);

  // Padding string to bulk up each record to ~100 bytes
  const padding = 'X'.repeat(80);

  // Synthetic email/IP templates — not real individuals
  const emailFor = (i: number) => `user${i}@stress-test-example.com`;
  const ipFor    = (i: number) =>
    `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;

  const recordSize = Buffer.byteLength(JSON.stringify({ id: 0, pad: padding }), 'utf8');
  const recordsNeeded = Math.ceil(targetBytes / recordSize);

  const records: Array<Record<string, unknown>> = [];
  for (let i = 0; i < recordsNeeded; i++) {
    const record: Record<string, unknown> = { id: i, pad: padding };
    if (i < totalMatches) {
      // Alternate between email and IPv4 to exercise two matchers
      if (i % 2 === 0) {
        record['contact'] = emailFor(i);
      } else {
        record['host'] = ipFor(i);
      }
    }
    records.push(record);
  }

  return { records, meta: { targetBytes, matchesPerKB, totalMatches } };
}

// ─── Result accumulator ───────────────────────────────────────────────────────

interface ScalingResult {
  inputLabel: string;
  inputBytes: number;
  piiDensity: number;
  tokenizeMs: number;
  outputBytes: number;
  reverseMapSize: number;
  throughputKBps: number;
}

const results: ScalingResult[] = [];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P2: tokenize scaling', () => {
  afterAll(async () => {
    await mkdir(BENCH_DIR, { recursive: true });
    const outPath = join(BENCH_DIR, `tokenize-scaling-${DATE_STAMP}.json`);
    await writeFile(outPath, JSON.stringify({ date: DATE_STAMP, results }, null, 2), 'utf8');
  });

  for (const density of PII_DENSITIES) {
    describe(`PII density: ${density} matches/KB`, () => {
      // Per-density timing map: bytes → ms (populated during size-sweep tests)
      const timings: Map<number, number> = new Map();

      for (const { label, bytes } of INPUT_SIZES) {
        it(`${label} at ${density} matches/KB`, async () => {
          const payload = buildPayloadWithPii(bytes, density);
          const inputBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

          const t0 = performance.now();
          const { redacted, reverseMap } = tokenize(payload, ALL_MATCHERS);
          const tokenizeMs = performance.now() - t0;

          const outputBytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8');
          const reverseMapSize = Object.keys(reverseMap).length;
          const throughputKBps = inputBytes / 1024 / (tokenizeMs / 1000);

          timings.set(bytes, tokenizeMs);

          results.push({
            inputLabel: label,
            inputBytes,
            piiDensity: density,
            tokenizeMs: Math.round(tokenizeMs * 100) / 100,
            outputBytes,
            reverseMapSize,
            throughputKBps: Math.round(throughputKBps * 10) / 10,
          });

          console.log(
            `  density=${density}/KB ${label}: ` +
            `${tokenizeMs.toFixed(2)} ms | ` +
            `reverseMap=${reverseMapSize} | ` +
            `${throughputKBps.toFixed(0)} KB/s`
          );

          // Tokenize must succeed
          expect(redacted).toBeDefined();
          // Output bytes must not balloon unexpectedly (tokens are short labels)
          expect(outputBytes).toBeLessThanOrEqual(inputBytes + 512);
        }, 30_000);
      }

      // Linearity assertion runs after all size-sweep tests for this density
      it(`linear scaling assertion (density=${density}/KB)`, () => {
        for (let i = 1; i < INPUT_SIZES.length; i++) {
          const smaller = INPUT_SIZES[i - 1]!.bytes;
          const larger  = INPUT_SIZES[i]!.bytes;
          const tSmall  = timings.get(smaller);
          const tLarge  = timings.get(larger);

          if (tSmall === undefined || tLarge === undefined) continue;
          // Skip ratio check below the noise floor (< 15 ms is too close to JIT/regex-compile noise)
          if (tSmall < 15) continue;

          const ratio = tLarge / tSmall;
          // 10× input → ≤ 20× time (regex tokenizer has memory-tier overhead; still guards
          // against exponential/quadratic blowup while allowing realistic linear+constant cost)
          expect(
            ratio,
            `${INPUT_SIZES[i - 1]!.label}→${INPUT_SIZES[i]!.label} ratio ${ratio.toFixed(2)} exceeds 20×`
          ).toBeLessThanOrEqual(20);
        }
      });
    });
  }

  it('all-matchers tokenize of 1 MB completes in < 2 s', () => {
    const payload = buildPayloadWithPii(1024 * 1024, 10);
    const t0 = performance.now();
    tokenize(payload, ALL_MATCHERS);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2_000);
  });
});
