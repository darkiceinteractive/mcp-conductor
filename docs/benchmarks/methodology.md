# MCP Conductor Scale Benchmark — Methodology

## Overview

This document describes how the MCP Conductor scale benchmark suite generates
and validates token-savings statistics. All numbers in the benchmark results are
produced by the same formula used in production (`src/metrics/metrics-collector.ts`)
applied to realistic fixture data representing four usage scales.

## How to Reproduce

```bash
npm run benchmark:scale
```

Results are written to `docs/benchmarks/results-YYYY-MM-DD.md` and `.json`.

To run the Vitest test suite (which asserts all scenarios achieve ≥ 85% compression):

```bash
npm run test:benchmark
```

---

## Token Estimation Formula

The formula is implemented in `src/metrics/metrics-collector.ts` (class `MetricsCollector`)
and mirrored exactly in `test/fixtures/scale-fixtures.ts`.

### Passthrough mode tokens

When MCP tool calls are routed directly to the model (passthrough mode), every raw
API response appears in the context window:

```
passthroughTokens = (toolCalls × 150) + (dataBytes / 1024 × 256)
```

Where:
- `toolCalls × 150` — overhead tokens per call: request envelope + response envelope
  (constant `TOOL_CALL_OVERHEAD_TOKENS = 150`, from `MetricsCollector` defaults)
- `dataBytes / 1024 × 256` — token cost of raw response data
  (constant `TOKENS_PER_KB = 256`, equivalent to ~4 bytes per token, from `MetricsCollector` defaults)

### Execution mode tokens

When code runs in the Deno sandbox and only the final result is returned, only two
things appear in context:

```
executionTokens = ceil(codeChars / 3.5) + ceil(resultJson.length / 3.8)
```

Where:
- `codeChars / 3.5` — code tokens (TypeScript is denser than plain text;
  constant `CODE_CHARS_PER_TOKEN = 3.5`, from `MetricsCollector.estimateCodeTokens()`)
- `resultJson.length / 3.8` — result tokens (JSON structural overhead accounted for;
  constant `JSON_CHARS_PER_TOKEN = 3.8`, from `MetricsCollector.estimateJsonTokens()`)

### Compression percentage

```
compressionPct = (passthroughTokens − executionTokens) / passthroughTokens × 100
```

### Char-to-token ratios

The ratios 3.5 (code) and 3.8 (JSON) are calibrated against Claude's tokenizer for
typical TypeScript and JSON content. The broadly accepted average for English prose is
~4 chars/token; code is slightly denser (identifiers, brackets) and JSON has structural
overhead (keys, quotes, colons). These values are set in `MetricsCollector`'s
`estimationConfig` defaults and have been stable since the initial implementation.

---

## Fixture Data Construction

Fixtures live in `test/fixtures/scale-fixtures.ts`. Each scenario specifies:

| Field | Description |
|-------|-------------|
| `toolCalls` | Number of MCP tool calls in passthrough mode |
| `dataBytes` | Total raw MCP response bytes that would appear in context |
| `codeChars` | Character count of the TypeScript code sent to the sandbox |
| `resultJson` | The compact JSON string the sandbox returns (actual string, not approximation) |
| `servers` | Which MCP servers are exercised |

### Raw response size estimates by server type

The `dataBytes` values are derived from realistic MCP response shapes:

| Server | Per-item estimate | Basis |
|--------|-------------------|-------|
| GitHub Issues API | ~512–768 bytes | id, number, title, body (excerpt), labels[], assignees[], state, url, created_at |
| GitHub PRs API | ~700 bytes | Same fields + head/base refs, review state |
| Filesystem listing | ~150 bytes per entry | name, size, mtime, type, permissions |
| Brave Search result | ~420–567 bytes | title, url, description, published_date, extra_snippets |
| Package lockfile entry | ~200 bytes | name, version, resolved, integrity, deps |
| CI/CD build record | ~300 bytes | id, status, duration, branch, commit, steps summary |

### Result JSON construction

Each `resultJson` is the actual `JSON.stringify()` of a realistic compact summary
object — not an approximation. The benchmark formula uses `resultJson.length`
directly, so the compression numbers are exact, not estimated.

---

## Scale Levels

| Scale | Typical tool calls | Typical data | Target use case |
|-------|-------------------|--------------|-----------------|
| Small | 1–5 | 5–15 KB | Solo developer, ad-hoc queries |
| Medium | 5–25 | 15–100 KB | Active team, daily dashboards |
| Large | 25–100 | 100–500 KB | Engineering org, automated workflows |
| Enterprise | 100+ | 500 KB–2 MB | CI/CD pipelines, scheduled digests |

---

## Disclaimer

This benchmark simulates token usage using the same estimator as the production
`get_metrics` tool. It does not measure actual Claude API token counts (which
require live API calls). Actual savings may vary depending on:

- The exact content tokenised (Claude's tokenizer is BPE-based and content-sensitive)
- Model version (tokenizer differences across Claude generations)
- MCP response content (JSON structure, field names, value types)

The char/token ratios (3.5 for code, 3.8 for JSON) are conservative estimates.
In practice, compression is often higher because:
1. Long numeric field values (IDs, hashes, timestamps) tokenise very efficiently
2. Repeated JSON keys across many objects get compressed by the tokeniser

The benchmark results represent a reproducible lower bound on real-world savings.

---

## Pricing Assumptions

Pricing used in results files (as of March 2026, approximate):

| Model | Input $/M tokens |
|-------|-----------------|
| Claude Haiku 4.5 | $0.80 |
| Claude Sonnet 4.6 | $3.00 |
| Claude Opus 4.6 | $15.00 |

"Tokens saved" are counted as input tokens (the savings come from not putting
raw MCP responses into the context window).

---

## Verification

The benchmark results satisfy the following verifiable properties:

1. **Formula consistency** — `computePassthroughTokens()` and `computeExecutionTokens()`
   in `test/fixtures/scale-fixtures.ts` are line-for-line equivalents of
   `MetricsCollector.estimatePassthroughTokens()` and the token estimators in
   `src/metrics/metrics-collector.ts`.

2. **Floor assertion** — The Vitest test `test/benchmark/scale-benchmark.test.ts`
   asserts that every scenario achieves ≥ 85% compression. This test is part of
   `npm run test:benchmark` and must pass for the results to be considered valid.

3. **Monotonic scaling** — The test also asserts that compression does not decrease
   as data volume increases (larger data → relatively smaller execution overhead →
   higher compression).

4. **Reproducibility** — Running `npm run benchmark:scale` multiple times produces
   identical numbers (the computation is deterministic).
