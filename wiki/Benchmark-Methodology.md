# Benchmark Methodology

This page describes how MCP Conductor's benchmark suite generates and validates token savings statistics.

## Overview

All benchmark numbers use the same formula as production code (`src/metrics/metrics-collector.ts`) applied to realistic fixture data. The benchmarks prove that token savings are genuine, reproducible, and consistent across usage scales.

## How to Run

```bash
# Scale benchmarks with formatted output
npm run benchmark:scale

# Full Vitest assertion suite
npm run test:benchmark
```

Scale benchmark results are written to:
- `docs/benchmarks/results-YYYY-MM-DD.md` — human-readable report
- `docs/benchmarks/results-YYYY-MM-DD.json` — machine-readable data

## Token Estimation Formula

See [Metrics & Token Savings](./Metrics-and-Token-Savings) for the full formula. In summary:

```
passthrough = (toolCalls × 150) + (dataBytes / 1024 × 256)
execution   = ceil(codeChars / 3.5) + ceil(resultJson.length / 3.8)
compression = (passthrough − execution) / passthrough × 100
```

## Scale Benchmark Suite

**File:** `test/benchmark/scale-benchmark.test.ts`
**Fixtures:** `test/fixtures/scale-fixtures.ts`

Four usage scales, each with three scenarios:

| Scale | Tool Calls | Data Range | Example |
|-------|-----------|------------|---------|
| Small | 1–5 | 5–50 KB | Single file read |
| Medium | 5–20 | 50–500 KB | Repository analysis |
| Large | 20–100 | 500 KB–5 MB | Multi-repo audit |
| Enterprise | 100–500 | 5–50 MB | Organisation-wide scan |

### Fixture Construction

Each fixture specifies:
- `toolCalls` — number of MCP server calls
- `dataBytes` — total raw data from servers
- `codeChars` — TypeScript code length
- `resultChars` — compact result length

Values are calibrated from real-world usage patterns. Data bytes represent typical API responses (GitHub repos, file contents, search results).

### Assertions

- Every individual scenario achieves ≥ 85% compression
- Average compression across all scenarios > 95%
- Results are deterministic (same fixtures → same numbers)

### Results

| Scale | Compression |
|-------|------------|
| Small | 88.8% |
| Medium | 95.6% |
| Large | 98.9% |
| Enterprise | 99.4% |
| **Overall Average** | **95.7%** |

## Workflow Benchmark Suite

**File:** `test/benchmark/workflow-benchmark.test.ts`
**Fixtures:** `test/fixtures/workflow-fixtures.ts`

Seven workflow categories with quick and deep variants:

| Category | Quick Variant | Deep Variant |
|----------|--------------|--------------|
| Code Review | Single file | Multi-file with history |
| Research Synthesis | 3 sources | 10+ sources with cross-referencing |
| File Operations | List + read | Batch rename + content analysis |
| Data Analysis | Simple query | Multi-table joins with aggregation |
| API Integration | Single endpoint | Multi-service orchestration |
| Documentation | Single page | Full site generation |
| DevOps | Status check | Multi-environment deployment |

### Assertions

- Floor ≥ 85% per individual scenario
- Average > 90% per category
- Overall average > 95%

## Claude Desktop Benchmark Suite

**File:** `test/benchmark/claude-desktop-benchmark.test.ts`
**Fixtures:** `test/fixtures/workflow-fixtures.ts`

Three user profiles simulating Claude Desktop sessions:

| Profile | Sessions/Day | Tools/Session | Context Window |
|---------|-------------|---------------|----------------|
| Casual | 5 | 3 | 200K tokens |
| Power User | 20 | 10 | 200K tokens |
| Heavy Automation | 50 | 30 | 200K tokens |

### What's Tested

1. **Context overflow** — Does passthrough exceed 200K tokens? Does execution fit?
2. **Monthly savings** — USD savings estimate based on Anthropic pricing
3. **Capacity ratio** — How many more sessions fit in the context window with execution mode?

### Key Findings

- Power user: ~$57/month savings
- Heavy automation passthrough overflows 200K context; execution uses ~35K
- Casual user: 1 session → 90 sessions in same context window

## Running Individual Suites

```bash
# Scale only
npx vitest run test/benchmark/scale-benchmark.test.ts

# Workflow only
npx vitest run test/benchmark/workflow-benchmark.test.ts

# Claude Desktop only
npx vitest run test/benchmark/claude-desktop-benchmark.test.ts
```

## Reproducing and Extending

To add a new benchmark scenario:

1. Add fixtures to `test/fixtures/scale-fixtures.ts` or `test/fixtures/workflow-fixtures.ts`
2. Follow the existing pattern: specify `toolCalls`, `dataBytes`, `codeChars`, `resultChars`
3. Add test assertions in the appropriate benchmark file
4. Run `npm run benchmark:scale` to regenerate results
