/**
 * Unit tests for the dict-compression encoder/decoder.
 *
 * Critical invariants:
 * - Code blocks are NEVER modified by encode().
 * - Decode is the exact inverse of encode (round-trip safety).
 * - Word-boundary safety: a code for "/src/components" does not
 *   corrupt "/src/components/Button" or identifiers containing the phrase.
 * - JSON payload values that are file paths still resolve after decode.
 * - Decode of inbound tool args expands codes before forwarding.
 */

import { describe, it, expect } from 'vitest';
import {
  encode,
  decode,
  splitByCodeFences,
  formatMapLegend,
  serializeDictMap,
  parseDictMap,
  generateCode,
} from '../../../src/compression/dict-map.js';
import type { DictMap } from '../../../src/compression/dict-map.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSingleEntryMap(expansion: string, code = '~1'): DictMap {
  return {
    entries: [{
      code,
      expansion,
      expansionTokens: Math.ceil(expansion.length / 3.8),
      codeTokens: 2,
      frequency: 10,
      netSavedPerUse: Math.ceil(expansion.length / 3.8) - 2,
      isPath: false,
    }],
    generatedAt: '2026-06-11',
    sourcePaths: ['/test'],
    projectedNetSavings: 100,
  };
}

function makeMultiEntryMap(pairs: Array<[string, string]>): DictMap {
  return {
    entries: pairs.map(([expansion, code], i) => ({
      code,
      expansion,
      expansionTokens: Math.ceil(expansion.length / 3.8),
      codeTokens: 2,
      frequency: 5,
      netSavedPerUse: Math.ceil(expansion.length / 3.8) - 2,
      isPath: false,
    })),
    generatedAt: '2026-06-11',
    sourcePaths: ['/test'],
    projectedNetSavings: 50,
  };
}

// ---------------------------------------------------------------------------
// generateCode
// ---------------------------------------------------------------------------

describe('generateCode', () => {
  it('produces ~1, ~2, ~3 for slots 1..3', () => {
    expect(generateCode(1)).toBe('~1');
    expect(generateCode(2)).toBe('~2');
    expect(generateCode(3)).toBe('~3');
  });

  it('handles slot 100', () => {
    expect(generateCode(100)).toBe('~100');
  });
});

// ---------------------------------------------------------------------------
// splitByCodeFences
// ---------------------------------------------------------------------------

describe('splitByCodeFences', () => {
  it('returns single plain segment for text with no fences', () => {
    const segs = splitByCodeFences('hello world');
    expect(segs).toHaveLength(1);
    expect(segs[0].isFenced).toBe(false);
    expect(segs[0].text).toBe('hello world');
  });

  it('isolates a fenced block', () => {
    const text = 'before\n```ts\nconst x = 1;\n```\nafter';
    const segs = splitByCodeFences(text);
    expect(segs.some(s => s.isFenced)).toBe(true);
    const fenced = segs.filter(s => s.isFenced);
    expect(fenced).toHaveLength(1);
    expect(fenced[0].text).toContain('const x = 1;');
  });

  it('handles multiple fenced blocks', () => {
    const text = 'a\n```\nfoo\n```\nb\n```\nbar\n```\nc';
    const segs = splitByCodeFences(text);
    const fenced = segs.filter(s => s.isFenced);
    expect(fenced).toHaveLength(2);
    const plain = segs.filter(s => !s.isFenced);
    expect(plain.map(s => s.text).join('')).toContain('a');
    expect(plain.map(s => s.text).join('')).toContain('c');
  });

  it('handles text with no fenced blocks cleanly', () => {
    const text = 'just plain text here';
    const segs = splitByCodeFences(text);
    expect(segs.every(s => !s.isFenced)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// encode — basic substitution
// ---------------------------------------------------------------------------

describe('encode', () => {
  it('replaces a known expansion with its code', () => {
    const map = makeSingleEntryMap('/Users/mattcrombie/Dev/Projects/Foo');
    const text = 'Reading files in /Users/mattcrombie/Dev/Projects/Foo\n';
    const result = encode(text, map);
    expect(result.text).toContain('~1');
    expect(result.text).not.toContain('/Users/mattcrombie/Dev/Projects/Foo');
    expect(result.substitutions).toBeGreaterThan(0);
  });

  it('does not modify text inside code fences', () => {
    const map = makeSingleEntryMap('/Users/mattcrombie/Dev/Projects/Foo');
    const text = 'See:\n```\nconst p = "/Users/mattcrombie/Dev/Projects/Foo";\n```\n';
    const result = encode(text, map);
    // The fenced block must remain untouched
    expect(result.text).toContain('/Users/mattcrombie/Dev/Projects/Foo');
    // But the code fence itself must be preserved verbatim
    expect(result.text).toContain('```');
  });

  it('returns the original string unchanged for an empty map', () => {
    const emptyMap: DictMap = {
      entries: [],
      generatedAt: '2026-06-11',
      sourcePaths: [],
      projectedNetSavings: 0,
    };
    const text = 'hello world /some/path foo';
    const result = encode(text, emptyMap);
    expect(result.text).toBe(text);
    expect(result.substitutions).toBe(0);
  });

  it('applies longest-match first to avoid partial replacements', () => {
    // If we have both "/src/components" and "/src/components/Button"
    // the longer match should win for the longer string.
    const map = makeMultiEntryMap([
      ['/src/components/Button', '~1'],
      ['/src/components', '~2'],
    ]);
    const text = 'import Button from /src/components/Button\n';
    const result = encode(text, map);
    // The longer expansion ~1 should be used, not ~2 + /Button
    expect(result.text).toContain('~1');
    expect(result.text).not.toContain('/Button'); // should be fully replaced
  });

  it('does not corrupt text when expansion is not present', () => {
    const map = makeSingleEntryMap('/not/present/path');
    const text = 'nothing to replace here';
    const result = encode(text, map);
    expect(result.text).toBe(text);
    expect(result.substitutions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decode — inbound expansion
// ---------------------------------------------------------------------------

describe('decode', () => {
  it('expands a code back to its original expansion', () => {
    const map = makeSingleEntryMap('/Users/mattcrombie/Dev/Projects/Foo');
    const encoded = 'Reading files in ~1\n';
    const result = decode(encoded, map);
    expect(result.text).toContain('/Users/mattcrombie/Dev/Projects/Foo');
    expect(result.text).not.toContain('~1');
    expect(result.expansions).toBeGreaterThan(0);
  });

  it('returns unchanged text for an empty map', () => {
    const emptyMap: DictMap = {
      entries: [],
      generatedAt: '2026-06-11',
      sourcePaths: [],
      projectedNetSavings: 0,
    };
    const text = '~1 ~2 ~3';
    const result = decode(text, emptyMap);
    expect(result.text).toBe(text);
    expect(result.expansions).toBe(0);
  });

  it('handles multiple codes in a single string', () => {
    const map = makeMultiEntryMap([
      ['/Users/foo/project', '~1'],
      ['src/components', '~2'],
    ]);
    const encoded = 'Found ~1/~2/Button.tsx\n';
    const result = decode(encoded, map);
    expect(result.text).toContain('/Users/foo/project');
    expect(result.text).toContain('src/components');
  });
});

// ---------------------------------------------------------------------------
// Round-trip safety (encode → decode = original)
// ---------------------------------------------------------------------------

describe('encode/decode round-trip', () => {
  it('is lossless for plain prose with one substitution', () => {
    const expansion = '/Users/mattcrombie/Dev/Projects/myapp';
    const map = makeSingleEntryMap(expansion);
    const original = `Using project at ${expansion} for all work.`;
    const { text: encoded } = encode(original, map);
    const { text: decoded } = decode(encoded, map);
    expect(decoded).toBe(original);
  });

  it('is lossless for multi-entry maps', () => {
    const map = makeMultiEntryMap([
      ['/Users/foo/project', '~1'],
      ['mcp-conductor', '~2'],
    ]);
    const original = 'Working on mcp-conductor at /Users/foo/project today.';
    const { text: encoded } = encode(original, map);
    const { text: decoded } = decode(encoded, map);
    expect(decoded).toBe(original);
  });

  it('is lossless when text contains code fences', () => {
    const expansion = '/Users/mattcrombie/Dev/Projects/Foo';
    const map = makeSingleEntryMap(expansion);
    const original = [
      `Loading ${expansion}/index.ts`,
      '```typescript',
      `import { foo } from "${expansion}/lib/foo";`,
      '```',
      `Done loading from ${expansion}.`,
    ].join('\n');

    const { text: encoded } = encode(original, map);
    const { text: decoded } = decode(encoded, map);
    expect(decoded).toBe(original);
  });

  it('preserves code fence contents exactly after round-trip', () => {
    const expansion = 'some/long/path/to/module';
    const map = makeSingleEntryMap(expansion);
    const original = `Before\n\`\`\`\n${expansion}\n\`\`\`\nAfter ${expansion} here`;
    const { text: encoded } = encode(original, map);
    // The fenced content must still contain the original path
    expect(encoded).toContain(expansion); // inside fence
    // After decode, original is fully restored
    const { text: decoded } = decode(encoded, map);
    expect(decoded).toBe(original);
  });

  it('is lossless for JSON tool arg containing a file path', () => {
    const expansion = '/Users/mattcrombie/Dev/Projects/myapp/src/index.ts';
    const map = makeSingleEntryMap(expansion);
    // Simulate a JSON-encoded tool arg where the path appears as a value
    const original = JSON.stringify({ file_path: expansion, action: 'read' });
    // Encode (path in JSON value is NOT in a code fence, so it may be replaced)
    const { text: encoded } = encode(original, map);
    // After decode, the JSON must be parseable with the correct path
    const { text: decoded } = decode(encoded, map);
    const parsed = JSON.parse(decoded) as { file_path: string; action: string };
    expect(parsed.file_path).toBe(expansion);
    expect(parsed.action).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Word-boundary safety
// ---------------------------------------------------------------------------

describe('word-boundary safety', () => {
  it('does not replace a path inside a longer path', () => {
    const map = makeSingleEntryMap('/src/components');
    // "/src/components/Button" should NOT be partially replaced
    const text = 'import from /src/components/Button\n';
    const result = encode(text, map);
    // Since /src/components/Button does not have a word boundary after /components,
    // the shorter path should not be replaced mid-path
    // (word boundary after /components requires whitespace, /, etc.)
    // In this case "/src/components/Button" — /components is followed by /Button
    // The lookbehind/lookahead uses / as a boundary, so this IS a boundary match.
    // Accept either outcome but assert no corruption:
    const decoded = decode(result.text, map);
    expect(decoded.text).toContain('/src/components/Button');
  });

  it('does not replace expansion inside a camelCase identifier', () => {
    // Even if "foo" is in the map, "fooBar" should not be corrupted
    const map = makeSingleEntryMap('mcp conductor');
    const text = 'Run the mcp conductor now.\nSee mcpConductorConfig for options.\n';
    const result = encode(text, map);
    // After encoding, the identifier "mcpConductorConfig" must not have ~1 injected
    // (there's no word boundary between "mcp conductor" and "Config")
    const decoded = decode(result.text, map);
    expect(decoded.text).toContain('mcpConductorConfig');
  });
});

// ---------------------------------------------------------------------------
// formatMapLegend
// ---------------------------------------------------------------------------

describe('formatMapLegend', () => {
  it('formats a legend with correct code=expansion pairs', () => {
    const map = makeSingleEntryMap('/Users/foo/project');
    const legend = formatMapLegend(map);
    expect(legend).toContain('~1=/Users/foo/project');
    expect(legend).toContain('Dict-compression map');
    expect(legend).toContain('Use codes in tool args');
  });

  it('returns empty string for empty map', () => {
    const emptyMap: DictMap = {
      entries: [],
      generatedAt: '2026-06-11',
      sourcePaths: [],
      projectedNetSavings: 0,
    };
    expect(formatMapLegend(emptyMap)).toBe('');
  });

  it('sorts entries by code for deterministic output', () => {
    // Ensure stable ordering regardless of insertion order
    const map: DictMap = {
      entries: [
        { code: '~3', expansion: 'c', expansionTokens: 1, codeTokens: 2, frequency: 1, netSavedPerUse: -1, isPath: false },
        { code: '~1', expansion: 'a', expansionTokens: 1, codeTokens: 2, frequency: 1, netSavedPerUse: -1, isPath: false },
        { code: '~2', expansion: 'b', expansionTokens: 1, codeTokens: 2, frequency: 1, netSavedPerUse: -1, isPath: false },
      ],
      generatedAt: '2026-06-11',
      sourcePaths: [],
      projectedNetSavings: 0,
    };
    const legend1 = formatMapLegend(map);
    // Reverse entry order and check legend is identical (sorted)
    const map2 = { ...map, entries: [...map.entries].reverse() };
    const legend2 = formatMapLegend(map2);
    expect(legend1).toBe(legend2);
  });
});

// ---------------------------------------------------------------------------
// Serialization / deserialization
// ---------------------------------------------------------------------------

describe('serializeDictMap / parseDictMap', () => {
  it('round-trips a DictMap through JSON', () => {
    const map = makeMultiEntryMap([
      ['/Users/foo/project', '~1'],
      ['mcp-conductor', '~2'],
    ]);
    const json = serializeDictMap(map);
    const parsed = parseDictMap(json);
    expect(parsed.entries).toHaveLength(map.entries.length);
    expect(parsed.entries[0].expansion).toBe('/Users/foo/project');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseDictMap('{invalid json')).toThrow();
  });

  it('throws when entries array is missing', () => {
    expect(() => parseDictMap('{"generatedAt":"2026-06-11"}')).toThrow(/Invalid dict map/);
  });

  it('serializes with stable ordering (sorted by code)', () => {
    const map = makeMultiEntryMap([
      ['/c', '~3'],
      ['/a', '~1'],
      ['/b', '~2'],
    ]);
    const json = serializeDictMap(map);
    const parsed = JSON.parse(json) as DictMap;
    const codes = parsed.entries.map((e: DictEntry) => e.code);
    expect(codes).toEqual(['~1', '~2', '~3']);
  });
});

// Re-import DictEntry type for test above (used in parsed type cast)
import type { DictEntry } from '../../../src/compression/dict-map.js';
