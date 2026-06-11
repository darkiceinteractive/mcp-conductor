/**
 * Dictionary-compression map types, encoder, and decoder for MCP Conductor.
 *
 * ## Overview
 * When `dictCompression` is enabled (config flag or DICT_COMPRESS=1 env var),
 * conductor rewrites outbound tool-result framing text by replacing high-token
 * repeated strings (paths, phrases) with compact numeric codes.
 *
 * ## Safety rules (always enforced)
 * - NEVER rewrite inside code fences (``` ... ``` blocks).
 * - NEVER rewrite inside JSON values that appear inside file-content payloads.
 * - Only replace at word boundaries — never mid-token.
 * - Longest-match first to avoid partial replacements.
 * - Inbound tool args: expand codes → originals before forwarding to backends.
 *
 * ## Code format
 * Codes use the form `~N` (e.g. `~1`, `~2`, …) which tokenises to 1–2 BPE
 * tokens. This format was selected from empirical testing in dict_compress_analysis.py.
 * The map legend injected into system instructions uses deterministic ordering
 * so it is stable for prompt caching.
 *
 * @module compression/dict-map
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in the dictionary map */
export interface DictEntry {
  /** The short code that replaces the expansion (e.g. "~1") */
  code: string;
  /** The original string being abbreviated */
  expansion: string;
  /** Token count of the expansion (for reporting) */
  expansionTokens: number;
  /** Token count of the code itself */
  codeTokens: number;
  /** Observed frequency in corpus */
  frequency: number;
  /** Net tokens saved per occurrence: expansionTokens - codeTokens */
  netSavedPerUse: number;
  /** Whether this entry came from path analysis (vs prose phrase) */
  isPath: boolean;
}

/** The full dictionary map: sorted by code for stable serialization */
export interface DictMap {
  /** Map entries, sorted by code for deterministic ordering */
  entries: DictEntry[];
  /** When this map was generated */
  generatedAt: string;
  /** Source path(s) that were mined */
  sourcePaths: string[];
  /** Total projected net savings in tokens for the corpus */
  projectedNetSavings: number;
}

/** Result of encoding a string */
export interface EncodeResult {
  /** The encoded string with codes substituted */
  text: string;
  /** Number of substitutions made */
  substitutions: number;
}

/** Result of decoding a string */
export interface DecodeResult {
  /** The decoded string with expansions restored */
  text: string;
  /** Number of expansions made */
  expansions: number;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Generate a code string for slot N (1-based).
 * Format: `~N` for N <= 99, `~N` for larger.
 * These tokenise to 1–2 BPE tokens in cl100k_base.
 */
export function generateCode(slot: number): string {
  return `~${slot}`;
}

// ---------------------------------------------------------------------------
// Code-fence detection
// ---------------------------------------------------------------------------

/** Segment of text: either fenced (protected) or plain (substitutable) */
interface TextSegment {
  text: string;
  isFenced: boolean;
}

/**
 * Split text into segments: code-fenced blocks are protected, everything
 * else is substitutable. Handles triple-backtick fences only (``` ... ```).
 */
export function splitByCodeFences(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // Match triple-backtick blocks (with optional language tag)
  // Uses a greedy match on the content between opening and closing fences.
  const fenceRe = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isFenced: false });
    }
    segments.push({ text: match[0], isFenced: true });
    lastIndex = fenceRe.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isFenced: false });
  }

  if (segments.length === 0) {
    segments.push({ text, isFenced: false });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Build a sorted replacement table from a DictMap.
 * Sorted by expansion length descending so longest-match wins.
 */
function buildReplacementTable(map: DictMap): Array<[string, string]> {
  return [...map.entries]
    .sort((a, b) => b.expansion.length - a.expansion.length)
    .map(e => [e.expansion, e.code]);
}

/**
 * Word-boundary-safe replacement: only replaces `expansion` when it appears
 * at a word boundary (not mid-identifier).
 *
 * Word boundary definition: expansion starts/ends at:
 * - Start/end of string
 * - Whitespace character
 * - Path separator (/ or \)
 * - Quote character (' or ")
 *
 * This prevents replacing e.g. "/src/components" inside "/src/components/Button"
 * when a shorter prefix is also in the map.
 */
function wordBoundarySafeReplace(
  text: string,
  expansion: string,
  code: string,
): string {
  // Escape special regex chars in the expansion
  const escaped = expansion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Build lookahead/lookbehind for word boundaries
  // We allow the match to start after: start-of-string, whitespace, /, \, ", '
  // and end before: end-of-string, whitespace, /, \, ", '
  const boundary = '(?:^|(?<=[\\s/\\\\"\'\\n\\r]))|(?=$|[\\s/\\\\"\'\\n\\r])';
  // Use a non-capturing group with lookbehind + lookahead
  const re = new RegExp(
    `(?<=^|[\\s/\\\\"'\\n\\r])${escaped}(?=$|[\\s/\\\\"'\\n\\r])`,
    'g',
  );
  return text.replace(re, code);
}

/**
 * Encode a string: replace all known expansions with their codes.
 *
 * Safety:
 * - Code-fenced blocks are never touched.
 * - Replacements are word-boundary safe.
 * - Longest expansion is replaced first.
 */
export function encode(text: string, map: DictMap): EncodeResult {
  if (!map.entries.length) {
    return { text, substitutions: 0 };
  }

  const table = buildReplacementTable(map);
  const segments = splitByCodeFences(text);
  let totalSubs = 0;

  const result = segments
    .map(seg => {
      if (seg.isFenced) return seg.text;
      let s = seg.text;
      for (const [expansion, code] of table) {
        const before = s;
        s = wordBoundarySafeReplace(s, expansion, code);
        if (s !== before) {
          // Count substitutions (rough: count occurrences of code in diff)
          totalSubs += (s.match(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        }
      }
      return s;
    })
    .join('');

  return { text: result, substitutions: totalSubs };
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Build a reverse table (code -> expansion) from a DictMap.
 */
function buildDecodeTable(map: DictMap): Map<string, string> {
  const t = new Map<string, string>();
  for (const e of map.entries) {
    t.set(e.code, e.expansion);
  }
  return t;
}

/**
 * Decode a string: expand all codes back to their originals.
 * Applies to the entire string (no code-fence protection needed for decoding —
 * codes should not appear inside code fences in the first place).
 */
export function decode(text: string, map: DictMap): DecodeResult {
  if (!map.entries.length) {
    return { text, expansions: 0 };
  }

  const table = buildDecodeTable(map);
  let result = text;
  let expansions = 0;

  // Sort codes by length descending to avoid partial matches
  const sortedCodes = [...table.keys()].sort((a, b) => b.length - a.length);

  for (const code of sortedCodes) {
    const expansion = table.get(code)!;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const before = result;
    result = result.replace(re, expansion);
    if (result !== before) {
      expansions += (before.match(re) || []).length;
    }
  }

  return { text: result, expansions };
}

// ---------------------------------------------------------------------------
// Map legend (for system instructions)
// ---------------------------------------------------------------------------

/**
 * Format the dict map as a compact legend suitable for injecting into the
 * MCP conductor system instructions block.
 *
 * Format is deterministic (sorted by code) and omits timestamps so the
 * system prompt is stable for prompt caching.
 *
 * Example output:
 * ```
 * ## Dict-compression map (mcp-conductor)
 * Codes expand to: ~1=/Users/mattcrombie/Dev/Projects/Foo ~2=src/components/Button
 * Use codes in tool args; conductor expands them before forwarding.
 * ```
 */
export function formatMapLegend(map: DictMap): string {
  if (!map.entries.length) return '';

  // Sort by code for deterministic ordering (stable for prompt cache)
  const sorted = [...map.entries].sort((a, b) => a.code.localeCompare(b.code));
  const pairs = sorted.map(e => `${e.code}=${e.expansion}`).join(' ');

  return [
    '## Dict-compression map (mcp-conductor)',
    `Codes expand to: ${pairs}`,
    'Use codes in tool args; conductor expands them before forwarding.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a DictMap to JSON, sorted for determinism.
 */
export function serializeDictMap(map: DictMap): string {
  const sorted: DictMap = {
    ...map,
    entries: [...map.entries].sort((a, b) => a.code.localeCompare(b.code)),
  };
  return JSON.stringify(sorted, null, 2);
}

/**
 * Parse a DictMap from JSON.
 */
export function parseDictMap(json: string): DictMap {
  const raw = JSON.parse(json) as DictMap;
  if (!raw.entries || !Array.isArray(raw.entries)) {
    throw new Error('Invalid dict map: missing entries array');
  }
  return raw;
}
