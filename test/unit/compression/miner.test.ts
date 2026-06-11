/**
 * Unit tests for the dictionary map miner.
 *
 * Tests:
 * - approxTokens calibration (sanity check vs known values)
 * - computeNetSavings accepts/rejects based on threshold
 * - mineDict produces valid DictMap from a temp directory
 * - Entries with negative net savings are excluded
 * - CODE_TOKEN_COST is the correct empirical value (2)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  approxTokens,
  approxEntryOverhead,
  computeNetSavings,
  mineDict,
  CODE_TOKEN_COST,
} from '../../../src/compression/miner.js';
import { generateCode } from '../../../src/compression/dict-map.js';

// ---------------------------------------------------------------------------
// approxTokens
// ---------------------------------------------------------------------------

describe('approxTokens', () => {
  it('returns at least 1 for any string', () => {
    expect(approxTokens('')).toBeGreaterThanOrEqual(1);
    expect(approxTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('scales roughly with length', () => {
    const short = approxTokens('hello');
    const long = approxTokens('hello world this is a longer string with more tokens');
    expect(long).toBeGreaterThan(short);
  });

  it('is proportional to ~4 chars per token for prose', () => {
    // A 40-char string should be ~10 tokens at 4 chars/token
    const tokens = approxTokens('The quick brown fox jumps over the lazy');
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// CODE_TOKEN_COST
// ---------------------------------------------------------------------------

describe('CODE_TOKEN_COST', () => {
  it('is 2 (empirically measured, per research-dictionary-compression.md §3)', () => {
    expect(CODE_TOKEN_COST).toBe(2);
  });

  it('matches the approx cost of a ~1 style code', () => {
    // Note: approxTokens underestimates (~1 is 2 chars but tiktoken gives 2 tokens)
    // CODE_TOKEN_COST is the empirical override — this test documents the discrepancy.
    const approxCode = approxTokens(generateCode(1)); // may be 1 (underestimate)
    // The empirical constant must be >= the approximation
    expect(CODE_TOKEN_COST).toBeGreaterThanOrEqual(approxCode);
  });
});

// ---------------------------------------------------------------------------
// computeNetSavings
// ---------------------------------------------------------------------------

describe('computeNetSavings', () => {
  it('computes positive net savings for a long high-frequency phrase', () => {
    // A 50-char phrase used 20 times should have large gross savings
    const expansion = '/Users/mattcrombie/Dev/Projects/myapp/src';
    const result = computeNetSavings(expansion, 20, 1);
    expect(result.netSavings).toBeGreaterThan(0);
    expect(result.grossSavings).toBeGreaterThan(result.entryOverhead);
  });

  it('returns negative net savings for a short rarely-used phrase', () => {
    // A 5-char phrase used twice — overhead will exceed gross savings
    const result = computeNetSavings('hello', 2, 1);
    expect(result.netSavings).toBeLessThanOrEqual(0);
  });

  it('uses CODE_TOKEN_COST (2) as the code cost', () => {
    const result = computeNetSavings('/some/long/path/example', 10, 1);
    expect(result.codeTokens).toBe(CODE_TOKEN_COST);
  });

  it('includes map entry overhead in net savings calculation', () => {
    const expansion = '/some/long/path/to/module/here/now';
    const highFreq = computeNetSavings(expansion, 100, 1);
    const lowFreq = computeNetSavings(expansion, 1, 1);
    // High frequency should have much better net savings
    expect(highFreq.netSavings).toBeGreaterThan(lowFreq.netSavings);
  });
});

// ---------------------------------------------------------------------------
// approxEntryOverhead
// ---------------------------------------------------------------------------

describe('approxEntryOverhead', () => {
  it('is positive for all inputs', () => {
    expect(approxEntryOverhead('~1', '/some/path')).toBeGreaterThan(0);
    expect(approxEntryOverhead('~99', 'a very long expansion phrase here')).toBeGreaterThan(0);
  });

  it('scales with expansion length', () => {
    const short = approxEntryOverhead('~1', 'foo');
    const long = approxEntryOverhead('~1', 'a very long expansion phrase with many tokens');
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// mineDict integration test
// ---------------------------------------------------------------------------

describe('mineDict', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Create a temporary project structure with repeated paths
    tmpDir = mkdtempSync(join(tmpdir(), 'dict-miner-test-'));

    // Create some files with meaningful path depth
    mkdirSync(join(tmpDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'utils'), { recursive: true });
    mkdirSync(join(tmpDir, 'test', 'unit'), { recursive: true });

    writeFileSync(join(tmpDir, 'src', 'components', 'Button.tsx'), '// Button');
    writeFileSync(join(tmpDir, 'src', 'components', 'Modal.tsx'), '// Modal');
    writeFileSync(join(tmpDir, 'src', 'utils', 'helpers.ts'), '// helpers');
    writeFileSync(join(tmpDir, 'test', 'unit', 'button.test.ts'), '// test');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a valid DictMap structure', () => {
    const map = mineDict({ projectRoot: tmpDir });
    expect(map).toBeDefined();
    expect(map.entries).toBeDefined();
    expect(Array.isArray(map.entries)).toBe(true);
    expect(typeof map.projectedNetSavings).toBe('number');
    expect(map.sourcePaths).toContain(tmpDir);
  });

  it('only includes entries with positive net savings', () => {
    const map = mineDict({ projectRoot: tmpDir, minNetSavings: 1 });
    for (const entry of map.entries) {
      const net = entry.frequency * entry.netSavedPerUse -
        approxEntryOverhead(entry.code, entry.expansion);
      expect(net).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces at most topK entries', () => {
    const topK = 5;
    const map = mineDict({ projectRoot: tmpDir, topK });
    expect(map.entries.length).toBeLessThanOrEqual(topK);
  });

  it('assigns codes in sequential order (stable for prompt caching)', () => {
    const map = mineDict({ projectRoot: tmpDir });
    for (let i = 0; i < map.entries.length; i++) {
      expect(map.entries[i].code).toBe(generateCode(i + 1));
    }
  });

  it('does not include entries where expansion is shorter than code', () => {
    const map = mineDict({ projectRoot: tmpDir });
    for (const entry of map.entries) {
      // expansion must be longer than the code to save tokens
      expect(entry.expansionTokens).toBeGreaterThan(entry.codeTokens);
    }
  });

  it('uses a tmpdir without crashing even if path traversal hits symlinks', () => {
    // Just a smoke test: should not throw
    expect(() => mineDict({ projectRoot: tmpdir() })).not.toThrow();
  });
});
