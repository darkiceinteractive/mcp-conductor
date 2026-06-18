# 13 — Hot-Path Analysis and Prebaked Primitives

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## PROBLEM

The model has to rediscover the same multi-tool call chains from scratch on every session.
There is no persistent recognition that "quote + options chain" is a single semantic intent,
or that "standup digest" is a seven-tool workflow with a known shape. The result is:

1. Extra round-trips to `discover_tools` on every session cold-start.
2. The model writes identical boilerplate `execute_code` scripts over and over.
3. Replayable sessions exist but cannot be promoted to named, user-invocable primitives.
4. `get_hot_paths` surfaces latency data but does not surface _co-occurrence_ — which
   tools are always called together — which is the signal needed to design primitives.

---

## EVIDENCE

### 1. `get_hot_paths` — what it actually returns

**Source**: `src/observability/hot-path.ts` + `src/server/mcp-server.ts:2278`

`get_hot_paths` returns per-(server, tool) latency aggregates:

```
{ server, tool, callCount, totalLatencyMs, meanLatencyMs, p99LatencyMs }
```

Data backing it: `HotPathProfiler` records one `LatencySample { latencyMs, timestamp }` per
call, keyed by `"${server}::${tool}"`. Rolling window: 1 hour, capped at 1 000 samples per
bucket. Populated in `mcp-server.ts` bridge handler — both PII-tokenized and standard paths
call `getHotPathProfiler().record(serverName, toolName, _obsLatency)`.

**Critical gap**: the profiler records individual tool calls but has no concept of sequence or
co-occurrence. There is no way to ask "which tools were called in the same `execute_code`
invocation?" The `toolsUsed` field exists on `ExecutionMetrics` in `metrics-collector.ts`
(line 193) but it is only aggregated at the session level as a frequency count
(`toolCallsByTool`), not as a sequence or co-occurrence matrix.

### 2. `toolSavingsBuckets` — the per-tool savings ledger

**Source**: `src/metrics/metrics-collector.ts:268`

`toolSavingsBuckets` is a `Map<string, ToolSavingsBucket>` keyed by `"${server}::${tool}"`.
Each bucket accumulates:

```
{ server, tool, calls, totalActualTokens, totalEstimatedPassthroughTokens, isPassthrough }
```

This is a call-count × token-cost ledger. It identifies which tools are expensive in token
terms (high `totalEstimatedPassthroughTokens`) but again has no co-occurrence dimension.

### 3. `record_session` / `replay_session` — what data is captured

**Source**: `src/observability/replay.ts`

Journal format (JSONL, one event per line):

```
{ seq, ts, type: "tool_call"|"tool_result"|"code_result", server, tool, args, result }
```

Stored in `~/.mcp-conductor/recordings/<uuid>.jsonl`. Rotation: oldest file deleted when
total directory exceeds 1 GB.

Replay operates in-memory against the journal — it does NOT re-execute Deno code. It
reconstructs the recorded call sequence and applies modifications (skip/replace by seq index).

**The key insight**: recordings contain the full call sequence with args and results.
This is the only place in the system where multi-tool chains are represented as ordered data.
But there is no path from "I have N recordings that all do the same thing" to "create a
named primitive". The session lifecycle is: start → stop → replay (with modifications). There
is no `promote_to_primitive`, `name_session`, or `extract_pattern` tool.

### 4. Benchmark fixtures — proxy for real-world common patterns

**Source**: `test/fixtures/workflow-fixtures.ts`, `docs/benchmarks/workflow-results-*.md`

The benchmark fixtures, which were designed to represent real daily use, show seven
recurring workflow shapes:

| Workflow | Servers | Tool calls (deep) | Tokens saved |
|---|---|---|---|
| Morning standup | github | 8 | ~8.7K |
| Code review | github, filesystem | 10 | ~17.8K |
| Bug investigation | github, filesystem | 8 | ~12.4K |
| Dependency check | filesystem | 6 | ~9.6K |
| Research synthesis | brave-search | 5 | ~3.6K |
| Project context load | github, filesystem, context7 | varies | ~20.8K |
| Release prep | github, filesystem | varies | ~13.9K |

Scale benchmarks also identify three recurring single-server patterns:
- `github-issues-fetch`: 1 call, 3 KB
- `filesystem-dir-listing`: 1 call, 4 KB
- `brave-search-single`: 1 call, 2 KB

For the trading/finance domain (ibkr server, 39 tools), common chains are visible from the
catalog description: "pnl, quote, health, option price" — implying a `quote + options_chain`
co-call is the canonical starting point for any options workflow.

### 5. `discover_tools` — no executable snippets today

**Source**: `src/server/mcp-server.ts:1007`

`discover_tools` returns:
```
{ server, tool, description, relevance }
```

It does not return input schemas (the handler reads them from the registry but strips them in
the output), executable code snippets, or suggestions for common follow-on tools. The model
must call `discover_tools`, read descriptions, mentally compose a script, and write it to
`execute_code`.

---

## OPTIONS

### Option A — Prebaked Primitives (conductor-native composite tools)

Register new meta-tools that orchestrate multi-tool calls internally. The model calls one
tool; conductor fans out and assembles the result.

**Proposed primitives** based on the evidence above:

**Finance domain** (ibkr server):
- `quote_with_chain(symbol, expiry?)` → calls `ibkr.get_quote` + `ibkr.get_options_chain`
  in parallel; returns merged `{ quote, chain }`.
- `portfolio_snapshot()` → calls `ibkr.get_pnl` + `ibkr.get_positions` + `ibkr.get_pnl_history`;
  returns `{ unrealised, positions, pnl_7d }`.
- `scan_and_price(criteria)` → calls `ibkr.run_market_scanner` + parallel
  `ibkr.calculate_option_price` for top N results.

**Development domain** (github + filesystem):
- `standup_digest(repo, since?)` → calls `github.list_pull_requests(merged)` +
  `github.list_issues(closed)` + `github.list_commits(since)` in parallel; returns structured
  summary matching the `morning-standup-deep` fixture shape.
- `pr_review_context(pr_number, repo)` → calls `github.get_pull_request` +
  `github.get_pull_request_files` + `github.get_pull_request_status` in parallel; returns
  unified `{ diff_summary, files, ci_status, linked_issues }`.
- `dep_audit(path?)` → calls `filesystem.read_file(package.json)` +
  `filesystem.read_file(package-lock.json)` → pipes to execute_code for CVE scan logic;
  returns `{ vulnerabilities, outdated, licenceIssues }`.

**Cross-domain** (any servers):
- `repo_summary(owner, name)` → calls `github.get_repository` + `github.list_issues(open)` +
  `github.list_pull_requests(open)`; returns `{ stars, openIssues, openPRs, lastCommit }`.

**Implementation note**: these must be registered as conductor meta-tools (not passthrough),
must route through the existing reliability gateway and cache layer, and must use parallel
`Promise.all` internally to minimise wall time.

**Token impact**: a `quote_with_chain` call that saves the model from needing to write an
execute_code script (320+ chars of boilerplate) saves roughly 90–120 tokens per invocation
on the code side. The larger benefit is context conservation: fewer round-trips means fewer
tool-result blobs in the conversation history.

### Option B — Memo'd Workflows (session-to-named-prompt pipeline)

Promote replayed sessions to user-invocable named prompts stored in conductor config.

Add three new tools:
- `name_session(sessionId, name, description)` — tags a recording with a human name and
  stores it in `~/.mcp-conductor.json` under `namedWorkflows`.
- `list_named_workflows()` — lists named workflows with call-count and last-used stats.
- `run_workflow(name, args?)` — replays the named session, substituting `args` into recorded
  call parameters via a lightweight template substitution (e.g. `"{{symbol}}"` in recorded
  args gets replaced by `args.symbol`).

This converts the existing replay infrastructure into a macro system. The model does not need
to relearn the call chain; it calls `run_workflow("morning_standup")` and gets results.

**Token impact**: a 7-call standup workflow that today costs ~30 tokens of boilerplate code
(plus the discover_tools round-trip) becomes a single-tool call with a parameter.

### Option C — Auto-completion via `next_step` helper

Add a `next_step` meta-tool that reads the current session's `toolCallsByTool` from
`MetricsCollector.getSessionMetrics()` and returns likely follow-up tools.

Implementation: embed a static co-occurrence table compiled from the workflow fixtures and
the `popular-mcps-2026-05-04.md` benchmark data. When the model has just called
`ibkr.get_quote`, `next_step` returns `["ibkr.get_options_chain", "ibkr.calculate_option_price"]`.
When it has called `github.get_pull_request`, it returns
`["github.get_pull_request_files", "github.get_pull_request_status", "github.list_commits"]`.

This is a low-cost, purely in-memory feature. No recording infrastructure needed.

**Token impact**: eliminates one `discover_tools` call (and its response) per workflow in
cases where the user follows a well-trodden path. Discovery is ~500–1 000 tokens per call
(20 results × ~50 chars each). Eliminating it on the 2nd and subsequent tool calls in a
chain saves ~500 tokens per skip.

### Option D — Executable snippets in `discover_tools` output

Extend the `discover_tools` response shape to include a `snippet` field per result — a
ready-to-paste `execute_code` code block for the most common invocation of that tool.

Example:
```json
{
  "server": "ibkr",
  "tool": "get_options_chain",
  "description": "...",
  "relevance": 1.0,
  "snippet": "const chain = await mcp.server('ibkr').call('get_options_chain', { symbol: 'AAPL', expiry: '2026-01-16' }); return chain;"
}
```

Snippets would be generated once at server start from the tool input schemas (already
available in the registry) and cached. No LLM needed to generate them.

**Token impact**: reduces the number of `execute_code` trial-and-error calls. Current pattern
is often: discover → write script → fail (wrong param name) → fix → succeed. Snippets short-
circuit the first failure loop.

---

## IMPACT

| Option | Dev effort | Token saving per workflow | Breaks existing API? |
|---|---|---|---|
| A — Prebaked primitives | Medium (1–2 days per domain) | 200–400 tokens (code + round-trips) | No — additive |
| B — Memo'd workflows | Medium (2–3 days) | 500–2 000 tokens (full workflow reuse) | No — additive |
| C — `next_step` helper | Low (0.5–1 day) | 500 tokens per skipped discovery | No — additive |
| D — Snippets in discover_tools | Low (0.5 day) | 100–200 tokens (fewer failed calls) | No — extends response shape |

All options are additive. None requires changing the existing tool contracts.

---

## RECOMMENDED PATH

**Ship in order: D → C → A (finance primitives first) → B**

**D first** because it costs half a day and immediately reduces the trial-and-error loop that
accounts for 1–3 wasted `execute_code` calls per new workflow. It requires no new tools, only
a schema extension to `discover_tools` output and snippet generation at registry load time.

**C second** because it surfaces the co-occurrence signal that is already latent in the
workflow fixture data. Building `next_step` forces the team to formalise the co-occurrence
table that Option A (prebaked primitives) will later use as its design spec.

**A third**, starting with the finance domain (ibkr), because:
- ibkr has 39 tools — the highest tool density in the connected catalog
- the catalog description explicitly names the canonical chain ("pnl, quote, health, option price")
- the finance use-case is the primary production use-case for this conductor instance

**B last** because it depends on having enough recordings to be useful, and those accumulate
naturally as A and C drive more consistent session patterns.

---

## STRUCTURAL GAP: Co-occurrence Is Not Tracked

None of the four options above will be as effective as they should be until conductor
records tool co-occurrence. The change required is small:

In `MetricsCollector.recordExecution()`, instead of only counting `toolCallsByTool` as a flat
frequency map, also record a `coOccurrenceMatrix: Record<string, Record<string, number>>` —
an `n×n` table where `matrix[tool_a][tool_b]` is incremented whenever `tool_a` and `tool_b`
appear in the same `execute_code` call (both present in `toolsUsed`).

This matrix is the input data for Option C (static → dynamic co-occurrence) and the
validation signal for Option A (confirm that the proposed primitive chains match what users
actually do).

---

*File: docs/findings/2026-06-12-perf-audit/13-hot-paths-and-prebaked.md*
