/**
 * Dictionary map miner for MCP Conductor.
 *
 * Scans a project directory and/or recent session logs to find recurring
 * high-token strings. Emits a `.dict-map.json` file with validated entries
 * (entries that don't net-save tokens are rejected).
 *
 * ## Two-pass mining
 * 1. **Path mining** — walks the project tree and collects all unique file/dir
 *    paths. Paths appearing in session logs get frequency-boosted.
 * 2. **Phrase mining** — scans session JSONL logs for repeated multi-word
 *    phrases in framing text (outside code fences). n-gram window 2–8 words.
 *
 * ## Token counting
 * Uses a simple BPE approximation (1 token ≈ 4 characters) calibrated against
 * tiktoken measurements on English text. This avoids a hard Python dependency
 * while giving accurate-enough net-savings estimates for entry acceptance.
 * Known deviation: ±15% vs tiktoken for path strings (slashes split tokens).
 *
 * A separate Python helper (scripts/validate-dict-tokens.py) can be run to
 * re-validate entries against real tiktoken if precision matters.
 *
 * @module compression/miner
 */

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { DictMap, DictEntry } from './dict-map.js';
import { generateCode } from './dict-map.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum occurrence count for a phrase candidate */
const MIN_PHRASE_FREQ = 4;
/** n-gram window: 2–8 space-separated words */
const N_MIN = 2;
const N_MAX = 8;
/** Max entries in the output map (top-K by net savings) */
const DEFAULT_TOP_K = 50;
/** Minimum net token savings for an entry to be accepted */
const MIN_NET_SAVINGS = 2;
/** Max bytes to read from a single session JSONL file */
const MAX_BYTES_PER_FILE = 20 * 1024 * 1024; // 20 MB
/** Directories to skip when walking the project tree */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache',
  '.venv', 'venv', '.tox', '.mypy_cache',
]);

// ---------------------------------------------------------------------------
// BPE token approximation
// ---------------------------------------------------------------------------

/**
 * Approximate BPE token count for a string.
 *
 * Calibration (measured on cl100k_base, Jun 2026):
 * - English prose: ~4.0 chars/token
 * - File paths: ~3.2 chars/token (slashes and dots create more splits)
 * - Code: ~3.5 chars/token
 *
 * We use 3.8 chars/token (matches mcp-conductor's existing estimateResultTokens)
 * as a single conservative rate.
 *
 * NOTE: Per empirical testing (research-dictionary-compression.md §3), no tested
 * code style (e.g. ~1, #1, $1) tokenises to 1 BPE token — the minimum is 2.
 * The approxTokens function is used for phrase expansions; for codes we use the
 * hardcoded CODE_TOKEN_COST constant (2) rather than approximating.
 */
export function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 3.8));
}

/**
 * Empirically measured BPE token cost for a `~N` style code.
 * All tested short codes (~1, #1, $1, @a1, α1) cost 2 tokens in cl100k_base.
 * Source: research-dictionary-compression.md §3.
 */
export const CODE_TOKEN_COST = 2;

/**
 * Approximate token cost of a map entry in the system prompt legend.
 * Format: "~N=<expansion>\n" → code + "=" + expansion + newline
 */
export function approxEntryOverhead(code: string, expansion: string): number {
  return approxTokens(`${code}=${expansion}\n`);
}

// ---------------------------------------------------------------------------
// Code-fence aware text extraction
// ---------------------------------------------------------------------------

/**
 * Strip code-fenced blocks from text and return only the substitutable prose.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
}

// ---------------------------------------------------------------------------
// Path mining
// ---------------------------------------------------------------------------

/** Walk a directory tree (depth-first, skip SKIP_DIRS) and collect paths */
function walkPaths(root: string, maxDepth = 10): string[] {
  const paths: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      paths.push(fullPath);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          walk(fullPath, depth + 1);
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  walk(root, 0);
  return paths;
}

/**
 * Mine path candidates from a project root.
 * Returns paths sorted by path length (longer paths = more savings).
 */
export function minePaths(projectRoot: string): Map<string, number> {
  const freq = new Map<string, number>();
  const paths = walkPaths(projectRoot);

  for (const p of paths) {
    // Use the full absolute path (most useful for compression)
    freq.set(p, (freq.get(p) ?? 0) + 1);

    // Also collect the parent directory separately (directories appear repeatedly)
    const parent = dirname(p);
    if (parent !== projectRoot && parent.length > projectRoot.length) {
      freq.set(parent, (freq.get(parent) ?? 0) + 1);
    }
  }

  return freq;
}

// ---------------------------------------------------------------------------
// Session log phrase mining
// ---------------------------------------------------------------------------

/**
 * Tokenise text into words for n-gram mining.
 * Splits on whitespace but preserves path-like tokens.
 */
function tokeniseWords(text: string): string[] {
  return text.match(/[^\s,;:!?]+/g) ?? [];
}

/**
 * Mine n-gram phrases from text.
 * Returns Map<phrase, count> filtered by MIN_PHRASE_FREQ.
 */
function mineNgrams(text: string): Map<string, number> {
  const words = tokeniseWords(text);
  const counts = new Map<string, number>();

  for (let n = N_MIN; n <= N_MAX; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phrase.length >= 8) {
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
    }
  }

  // Filter to minimum frequency
  for (const [phrase, count] of counts) {
    if (count < MIN_PHRASE_FREQ) counts.delete(phrase);
  }

  return counts;
}

/**
 * Extract substitutable text from a session JSONL line.
 * Skips tool_result content (raw file payloads), code fences, and short strings.
 */
function extractFramingText(line: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return '';
  }

  // Handle nested message wrappers
  if ('message' in obj && typeof obj.message === 'object' && obj.message !== null) {
    obj = obj.message as Record<string, unknown>;
  }

  const content = obj.content;
  if (typeof content === 'string') {
    return stripCodeFences(content);
  }

  if (!Array.isArray(content)) return '';

  let text = '';
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    // Skip tool_result blocks (raw file content)
    if (b.type === 'tool_result') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += stripCodeFences(b.text) + '\n';
    }
  }
  return text;
}

/**
 * Mine phrase frequencies from Claude session JSONL log files.
 */
export function mineSessionPhrases(sessionFiles: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const file of sessionFiles) {
    if (!existsSync(file)) continue;
    let bytesRead = 0;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const line of lines) {
      bytesRead += line.length;
      if (bytesRead > MAX_BYTES_PER_FILE) break;
      if (!line.trim()) continue;

      const text = extractFramingText(line);
      if (!text) continue;

      const ngrams = mineNgrams(text);
      for (const [phrase, count] of ngrams) {
        counts.set(phrase, (counts.get(phrase) ?? 0) + count);
      }
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

/**
 * Compute net savings for a candidate entry.
 * net = (freq * (expansionTokens - codeTokens)) - entryOverheadTokens
 */
export function computeNetSavings(
  expansion: string,
  frequency: number,
  codeSlot: number,
): {
  code: string;
  expansionTokens: number;
  codeTokens: number;
  entryOverhead: number;
  grossSavings: number;
  netSavings: number;
} {
  const code = generateCode(codeSlot);
  const expansionTokens = approxTokens(expansion);
  // Use empirically measured cost (2 tokens per research-dictionary-compression.md §3),
  // not approxTokens(code) which underestimates short codes like ~1 → 1 token approx.
  const codeTokens = CODE_TOKEN_COST;
  const savedPerUse = expansionTokens - codeTokens;
  const entryOverhead = approxEntryOverhead(code, expansion);
  const grossSavings = frequency * savedPerUse;
  const netSavings = grossSavings - entryOverhead;
  return { code, expansionTokens, codeTokens, entryOverhead, grossSavings, netSavings };
}

// ---------------------------------------------------------------------------
// Deduplication & subsumption
// ---------------------------------------------------------------------------

/**
 * Remove entries where the expansion is a substring of a longer accepted entry.
 * This prevents redundant shorter replacements when a longer one covers more.
 *
 * Note: we keep both if the shorter one appears in different contexts.
 * For conservatism, we only remove X if >80% of X's occurrences are subsumed
 * by a longer phrase that contains X.
 *
 * Simplified: just remove entries where expansion is a prefix-suffix of another.
 */
function removeSubsumedEntries(entries: DictEntry[]): DictEntry[] {
  const result: DictEntry[] = [];
  const expansions = entries.map(e => e.expansion);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    // Check if this expansion is contained in any longer expansion
    const subsumed = expansions.some(
      (other, j) => j !== i && other!.length > e.expansion.length && other!.includes(e.expansion)
    );
    if (!subsumed) {
      result.push(e);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main mine function
// ---------------------------------------------------------------------------

export interface MinerOptions {
  /** Project root directory to scan for paths */
  projectRoot: string;
  /** Session JSONL files to mine for phrases */
  sessionFiles?: string[];
  /** Maximum number of entries in the output map */
  topK?: number;
  /** Minimum net token savings to accept an entry */
  minNetSavings?: number;
}

/**
 * Mine a project and optional session logs to produce a DictMap.
 * Entries are validated for net-savings and sorted by net savings descending.
 * Returns the top-K entries.
 */
export function mineDict(options: MinerOptions): DictMap {
  const {
    projectRoot,
    sessionFiles = [],
    topK = DEFAULT_TOP_K,
    minNetSavings = MIN_NET_SAVINGS,
  } = options;

  const candidates = new Map<string, { freq: number; isPath: boolean }>();

  // 1. Mine project paths
  const pathFreqs = minePaths(projectRoot);
  for (const [path, freq] of pathFreqs) {
    // Only include paths with meaningful savings potential:
    // expansion must be longer than the shortest code (~1 = 2 chars)
    if (path.length > 8) {
      const existing = candidates.get(path);
      candidates.set(path, {
        freq: (existing?.freq ?? 0) + freq,
        isPath: true,
      });
    }
  }

  // 2. Mine session phrases
  if (sessionFiles.length > 0) {
    const phraseFreqs = mineSessionPhrases(sessionFiles);
    for (const [phrase, freq] of phraseFreqs) {
      if (phrase.length > 8) {
        const existing = candidates.get(phrase);
        candidates.set(phrase, {
          freq: (existing?.freq ?? 0) + freq,
          isPath: false,
        });
      }
    }
  }

  // 3. Score all candidates and assign tentative slots
  type ScoredCandidate = {
    expansion: string;
    freq: number;
    isPath: boolean;
    expansionTokens: number;
    grossSavings: number;
  };

  const scored: ScoredCandidate[] = [];
  const CODE_TOKEN_COST_LOCAL = CODE_TOKEN_COST; // 2 tokens per empirical measurement

  for (const [expansion, { freq, isPath }] of candidates) {
    const expansionTokens = approxTokens(expansion);
    const savedPerUse = expansionTokens - CODE_TOKEN_COST_LOCAL;
    if (savedPerUse <= 0) continue; // can't save tokens
    const grossSavings = freq * savedPerUse;
    if (grossSavings < minNetSavings) continue;
    scored.push({ expansion, freq, isPath, expansionTokens, grossSavings });
  }

  // Sort by gross savings descending so we assign best codes first
  scored.sort((a, b) => b.grossSavings - a.grossSavings);

  // 4. Assign codes and validate net savings (including map-entry overhead)
  const accepted: DictEntry[] = [];
  let slot = 1;

  for (const candidate of scored) {
    if (accepted.length >= topK * 2) break; // pre-filter before dedup

    const { code, expansionTokens, codeTokens, netSavings } =
      computeNetSavings(candidate.expansion, candidate.freq, slot);

    if (netSavings < minNetSavings) continue;

    accepted.push({
      code,
      expansion: candidate.expansion,
      expansionTokens,
      codeTokens,
      frequency: candidate.freq,
      netSavedPerUse: expansionTokens - codeTokens,
      isPath: candidate.isPath,
    });
    slot++;
  }

  // 5. Remove subsumed entries
  const deduped = removeSubsumedEntries(accepted);

  // 6. Take top-K by net savings (re-compute after dedup to get accurate totals)
  const topK_entries = deduped
    .sort((a, b) => {
      const netA = a.frequency * a.netSavedPerUse - approxEntryOverhead(a.code, a.expansion);
      const netB = b.frequency * b.netSavedPerUse - approxEntryOverhead(b.code, b.expansion);
      return netB - netA;
    })
    .slice(0, topK);

  // Reassign codes sequentially after sorting/dedup (stable 1..N)
  const finalEntries: DictEntry[] = topK_entries.map((e, i) => ({
    ...e,
    code: generateCode(i + 1),
  }));

  const projectedNetSavings = finalEntries.reduce((sum, e) => {
    return sum + e.frequency * e.netSavedPerUse - approxEntryOverhead(e.code, e.expansion);
  }, 0);

  return {
    entries: finalEntries,
    generatedAt: (new Date().toISOString().split('T')[0] ?? new Date().toISOString()), // date only for cache stability
    sourcePaths: [projectRoot, ...sessionFiles.slice(0, 3)],
    projectedNetSavings,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point (called from bin/mine-dict.ts)
// ---------------------------------------------------------------------------

export interface MineDictCLIArgs {
  projectRoot: string;
  output: string;
  sessionFiles: string[];
  topK: number;
  verbose: boolean;
}

export async function runMinerCLI(args: MineDictCLIArgs): Promise<void> {
  const { projectRoot, output, sessionFiles, topK, verbose } = args;

  if (verbose) {
    console.error(`[dict-miner] Scanning project: ${projectRoot}`);
    if (sessionFiles.length > 0) {
      console.error(`[dict-miner] Session files: ${sessionFiles.length}`);
    }
  }

  const map = mineDict({ projectRoot, sessionFiles, topK });

  if (verbose) {
    console.error(`[dict-miner] Accepted entries: ${map.entries.length}`);
    console.error(`[dict-miner] Projected net savings: ${map.projectedNetSavings} tokens`);
    const pathCount = map.entries.filter(e => e.isPath).length;
    const phraseCount = map.entries.length - pathCount;
    console.error(`[dict-miner] Path entries: ${pathCount}, phrase entries: ${phraseCount}`);
    if (verbose && map.entries.length > 0) {
      console.error('[dict-miner] Top 10 entries:');
      for (const e of map.entries.slice(0, 10)) {
        const net = e.frequency * e.netSavedPerUse - approxEntryOverhead(e.code, e.expansion);
        console.error(`  ${e.code} → ${e.expansion.slice(0, 60)} (freq=${e.frequency}, net=${net}tok)`);
      }
    }
  }

  const { serializeDictMap } = await import('./dict-map.js');
  const json = serializeDictMap(map);

  if (output === '-') {
    process.stdout.write(json + '\n');
  } else {
    writeFileSync(output, json, 'utf8');
    if (verbose) console.error(`[dict-miner] Written to: ${output}`);
    else console.log(output);
  }
}

// ---------------------------------------------------------------------------
// Auto-session discovery
// ---------------------------------------------------------------------------

/**
 * Find recent Claude session JSONL files for a project path.
 * Looks in ~/.claude/projects/<encoded-path>/*.jsonl
 */
export function findSessionFiles(projectRoot: string): string[] {
  // Claude encodes project paths by replacing / with - in the dir name
  const encoded = projectRoot.replace(/\//g, '-');
  const claudeDir = join(homedir(), '.claude', 'projects');
  const projectDir = join(claudeDir, encoded);

  if (!existsSync(projectDir)) return [];

  try {
    return readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f));
  } catch {
    return [];
  }
}
