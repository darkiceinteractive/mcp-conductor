# SYNTHESIS — mcp-conductor Performance & Token Audit 2026-06-12

> **Read this first.** This document synthesises all 16 specialist findings into
> a single, actionable picture: what is broken, what it costs, what to fix first,
> and how three phases of work transform the system.
>
> Branch: `feat/lean-defaults` | Commit: `f12f5f5` | Audit date: 2026-06-12

---

## Section 1 — WOW: Headline Impact Table

The table below shows measured baseline values alongside the projected outcome of
three phases of work. Phases are defined in Section 5 and Section 6.

Phase 1 = 1–2 days, quick wins already-built-but-unwired + three crisis fixes.  
Phase 2 = 1–2 weeks, presence-layer reductions + spec feature adoption.  
Phase 3 = 2–4 weeks, daemon broker + full lazy/warm-start architecture.

| Metric | Baseline (today) | After Phase 1 | After Phase 2 | After Phase 3 |
|--------|-----------------|---------------|---------------|---------------|
| **Cold start (ms)** | 10,468 ms | 3,900 ms ¹ | 3,900 ms | ~300 ms ² |
| **Cold start (lazy mode)** | N/A | ~150 ms ³ | ~150 ms | ~150 ms |
| **per-execute_code overhead (ms)** | ~44 ms | <1 ms ⁴ | <1 ms | <1 ms |
| **Max passthrough result (tokens)** | Unbounded (~263k for 1 MB) | 8,000 t cap | 8,000 t cap | 8,000 t cap |
| **Always-on tokens — Claude Code** | ~892 t ⁵ | ~892 t | ~400 t ⁶ | ~400 t |
| **Always-on tokens — Claude Desktop** | ~4,383 t ⁷ | ~4,383 t | ~3,087 t ⁸ | ~3,087 t |
| **discover_tools recall %** | ~25% | ~95%+ ⁹ | ~95%+ | ~95%+ |
| **2nd-window startup cost** | 10,468 ms × N | 10,468 ms × N | 10,468 ms × N | ~300 ms × N ² |
| **tokenize @ 10 MB (ms)** | 2,036 ms | 2,036 ms | ~290 ms ¹⁰ | ~290 ms |
| **findTool p99 @ 10k tools (ms)** | 359 ms | 359 ms | ~80 ms ¹¹ | ~5 ms ¹² |

**Notes:**
1. Timeout reduction from 10,000 ms to 2,000 ms; srv-a still consumes one 2,000 ms slot.
2. Phase 3 daemon broker warms tool cache from sidecar; 2nd+ windows inherit it in ~300 ms.
3. Lazy connect (Option C from #06) skips child server init entirely; catalog from sidecar.
4. WorkerPool pre-warmed Deno workers (#02); per-call overhead drops from 44 ms to <1 ms.
5. Claude Code deferred loading: 120 t stubs + 772 t instructions = ~892 t prefix. Instructions are ALREADY silently truncated to ~512 t by the 2,048-char limit bug (#10).
6. Cut instructions to ≤1,900 chars (fits 2,048-char threshold); gate admin tools behind feature flag (−438 t); move import/export to CLI-only (−269 t). Target ~400 t total.
7. Claude Desktop loads all tool schemas (no deferred loading): 772 t instructions + 1,749 t tool descriptions + 643 t inputSchema + 1,119 t outputSchema + 100 t names = 4,383 t.
8. After presence-layer cuts from #05 (−1,296 t target). Admin tool gate alone = −438 t.
9. Token-split BM25 scoring (~25 line change) replacing substring match in #08.
10. Combined regex single pass (#16, Bottleneck 1). 7 passes → 1 pass; −86%.
11. Typed-array score buffer replacing heap-allocated objects (#16, Bottleneck 2). −78% p99.
12. Query LRU cache added alongside typed arrays; cache-hit p99 ~5 ms.

---

## Section 2 — Three Crisis Findings

These three issues are in production RIGHT NOW and silently degrading every session.
They require no architectural changes — each is a targeted code change of ≤25 lines.

### Crisis 1 — serverInfo.instructions Truncation (#10)

**What is broken:** The `serverInfo.instructions` field returned in the MCP `initialize`
response is **3,086 characters** long. Claude Code has a hard-coded **2,048-character
truncation threshold** on this field. Every Claude Code session silently drops the
tail ~1,038 characters of conductor's usage instructions.

The dropped content includes: the `execute_code` pattern examples, the
`passthrough_call` guidance, and the tool routing decision tree. Operators who rely
on Claude Code reading these instructions to understand conductor's API are getting
about two-thirds of the guide.

**Evidence:** `src/server/mcp-server.ts` line 276 constructs the initialize response.
The instructions string is assembled from template literals and is ~3,086 chars.
Claude Desktop has no such truncation (it renders the full string) but does not
surface this field prominently.

**Fix:** Cut `serverInfo.instructions` to ≤1,900 characters (leaving headroom below
the 2,048-char limit). Move the detailed usage examples to the `get_capabilities`
tool response and the help text of `discover_tools` and `execute_code` descriptions.
1–2 hours.

**Blast radius if unresolved:** Every Claude Code user, every session. Silent
mis-routing, unnecessary discover_tools calls, suboptimal code patterns written
by Claude because it never received the full guidance.

---

### Crisis 2 — Unbounded Passthrough JSON (#07)

**What is broken:** The passthrough path (`src/server/passthrough-registrar.ts:288–315`
and `src/server/mcp-server.ts:1700–1701`) returns the raw backend tool result
verbatim — no trimming, no compression. A 1 MB backend result becomes
**~263,000 context tokens** in one call. The `trimResultToBudget` function already
exists and is wired to the `execute_code` path. It is simply not wired to passthrough.

6 admin tools also format output with `JSON.stringify(output, null, 2)` (pretty-print
indentation) at lines 2238, 2453, 2478, 2518, 2586, 2624, 2660 — adding ~30% token
inflation for no reason.

**Fix:** Wire `trimResultToBudget` with an 8,000-token default to:
- `passthrough_call` handler at `src/server/mcp-server.ts:1700`
- Auto-registered passthrough tools in `src/server/passthrough-registrar.ts:285`

Also add a `compactJSON()` null-stripping replacer for the 6 admin tool stringify
calls. Combined effect: a 1 MB result → ≤~32 KB (8 k tokens × ~4 chars/token).

**Blast radius if unresolved:** Any passthrough call to a data-heavy backend (file
readers, database queries, API search results) can silently consume the entire
200k Claude Code context window in a single tool response.

---

### Crisis 3 — discover_tools 75pp Recall Deficit (#08)

**What is broken:** `discover_tools` finds the right tool on a realistic multi-word
query only **25% of the time** (3 out of 12 in the test set). The current implementation
in `src/server/mcp-server.ts:1033–1082` and `src/hub/mcp-hub.ts:612–631` uses a
single-term substring match. A query of "list github pull requests" does not match
a tool named `list_prs` with description "Enumerate open pull requests on a repo".

The `VectorIndex` at `src/runtime/findtool/vector-index.ts` already implements a
proper TF-IDF / cosine similarity search engine and is seeded at startup — but it
is never called by `discover_tools`. It is used only by the sandbox `findTool` helper
inside Deno scripts.

**Fix:** Replace the substring match in both `mcp-server.ts` and `mcp-hub.ts` with
a token-split BM25-style scoring function (~25 lines total). Split query and tool
descriptions into tokens, score by token overlap + position weighting. No new
dependencies. Expected recall: ~95%+.

Alternatively, route `discover_tools` queries through the existing `VectorIndex`
(already seeded) for near-perfect recall.

**Blast radius if unresolved:** Claude wastes tokens and latency on repeated
`discover_tools` calls, falls back to passthrough guessing, or silently misses the
correct tool. At 25% recall, 3 out of 4 multi-word discovery queries return the
wrong answer or nothing.

---

## Section 3 — Ranked Priority Matrix (All 16 Findings)

All findings appear here. "Already-Built?" refers to code that exists but is not
wired to the path that would use it.

| Rank | ID | Lever | Token Δ | Wall Δ | Effort | Risk | Already-Built? |
|------|----|-------|---------|--------|--------|------|----------------|
| 1 | #07 | Wire trimResultToBudget to passthrough | −99% on large results | 0 ms | 2 h | Low | Yes — exists on execute_code path |
| 2 | #10 | Cut instructions to ≤1,900 chars | −360 t/session (CC) | 0 ms | 2 h | Low | No |
| 3 | #08 | Token-split BM25 for discover_tools | Indirect (fewer retry calls) | 0 ms | 3 h | Low | Partial — VectorIndex exists |
| 4 | #01 | Reduce connectionTimeoutMs 10k→2k | 0 t | −6,568 ms cold start | 15 min | Low | No |
| 5 | #02 | Wire WorkerPool to execute_code | 0 t | −44 ms/call | 4 h | Medium | Yes — pool fully implemented |
| 6 | #03 | Wire CacheLayer to passthrough path | Saves repeated-call tokens | −latency on cache hits | 3 h | Low | Yes — wired on bridge /call only |
| 7 | #05 | Admin tool gate (−438 t Desktop) | −438 t (Desktop) | 0 ms | 3 h | Low | No |
| 8 | #05 | Move import/export to CLI-only (−269 t) | −269 t (Desktop) | 0 ms | 2 h | Low | No |
| 9 | #06 | Lazy connect mode (Option C) | 0 t | −10,318 ms cold start | 4 h | Medium | Partial — design defined |
| 10 | #14 | Sidecar tool cache (50-line warm start) | 0 t | Enables lazy+accurate catalog | 2 h | Low | Yes — DaemonServer infra ready |
| 11 | #04 | Extract token constants to single file | 0 t (correctness) | 0 ms | 1 h | Low | No |
| 12 | #10 | Fix Desktop deferred-loading bugs (3 bugs) | Enables deferred loading for Desktop | 0 ms | 4 h | Medium | No |
| 13 | #16 | tokenize: combined regex single pass | 0 t (but avoids OOM) | −1,746 ms @ 10 MB | 3 h | Low | No |
| 14 | #16 | findTool: typed-array score buffer | 0 t | −279 ms p99 @ 10k | 2 h | Low | No |
| 15 | #11 | MCP Prompts implementation (slash cmds) | Reduces discovery overhead | 0 ms | 4 h | Low | No |
| 16 | #13 | Co-occurrence tracking for hot paths | 0 t | Reduces sequence latency | 3 h | Low | No |
| 17 | #05 | Collapse add/remove/update server tools | −208 t (Desktop) | 0 ms | 2 h | Low | No |
| 18 | #09 | default_params injection per server | 0 t (avoids truncation) | 0 ms | 2 h | Low | No |
| 19 | #15 | Async appendFile (logToFile trap) | 0 t | −50–300 µs (when enabled) | 1 h | Low | No |
| 20 | #15 | Hoist regex patterns to module-level | 0 t | −3 allocs/call | 30 min | Low | No |
| 21 | #12 | .pyi stub format (Bifrost-style) | −90% per tool schema | Enables faster discovery | 1 day | Medium | No |
| 22 | #11 | MCP Tasks (durable async execute_code) | Context savings on long runs | +non-blocking exec | 2 days | High | No |
| 23 | #14 | Daemon broker tool.call path | 0 t | −10k ms 2nd+ windows | 3 days | High | Yes — socket infra, call not impl. |
| 24 | #15 | compare_mode auto-disable after N calls | 0 t | Prevents 2× load runaway | 1 h | Low | No |
| 25 | #16 | findTool: query LRU cache | 0 t | p99: 80→5 ms cache hit | 1 h | Low | No |

**Top 10 by combined token + wall impact:**

Ranks 1–10 in the table above. All 16 findings appear in the matrix; the top 10
come from: #07, #10, #08, #01, #02, #03, #05 (×2), #06, #14.

Findings represented in top 10: **#01, #02, #03, #05, #06, #07, #08, #10, #14**
— that is 9 unique finding IDs across 10 slots (finding #05 contributes two separate
levers ranked at positions 7 and 8).

All 16 findings appear somewhere in the matrix.

---

## Section 4 — Infrastructure Already Built But Unwired

Four substantial subsystems exist in the codebase in fully-implemented form. None
of them are connected to the hot paths that would benefit from them. This is the
single highest-leverage theme in the audit: the work is done; it just needs wiring.

### 4.1 WorkerPool (#02)

**Location:** `src/runtime/pool/` — fully tested, exported from `src/runtime/pool/index.ts`

**What it does:** Pre-warms a configurable pool of Deno worker processes. Each worker
is ready to execute a script in <1 ms rather than spawning a new Deno subprocess in
~44 ms.

**The gap:** `src/server/mcp-server.ts:270` assigns `this.executor = new DenoExecutor(config.sandbox)`.
The WorkerPool is never imported into `mcp-server.ts`. `src/config/schema.ts:186–201`
defines `WorkerPoolConfig` but it is never read or applied.

**One-time security note:** `src/runtime/pool/pooled-worker.ts` passes `--allow-net`
(unrestricted) and `--allow-read` whereas `DenoExecutor` passes `--allow-net=localhost:PORT`
(scoped). The WorkerPool permissions need tightening before wiring.

**Wiring cost:** ~4 hours. Add a `workerPool?: WorkerPoolConfig` branch in start(),
import WorkerPool, pass it as the executor to execute_code handler. Fix permissions.

---

### 4.2 CacheLayer (#03)

**Location:** Instantiated at `src/server/mcp-server.ts:292`. Implemented at
`src/cache/` (three-tier: LRU + CBOR disk + delta).

**What it does:** Caches backend tool call results. On a cache hit, returns the stored
result without contacting the backend at all.

**The gap:** The CacheLayer is wired ONLY to the bridge `/call` HTTP handler
(`src/server/mcp-server.ts:2795–2839`). It is NOT wired to:
- `passthrough_call` at `src/server/mcp-server.ts:1700`
- Auto-registered passthrough tools in `src/server/passthrough-registrar.ts:285`

So any tool call going through passthrough (which is the recommended path for most
backend tools) bypasses the cache entirely. The DiagPayload has no `cacheHit` field
so users cannot even tell they are getting uncached responses.

**Wiring cost:** ~3 hours. Thread `this.cache` into the passthrough registrar's
callTool wrapper; add `cacheHit` to DiagPayload; surface CacheStats in get_metrics.

---

### 4.3 DaemonServer / Sidecar Cache (#14)

**Location:** `src/daemon/` — production-hardened, benchmarked at 100% success rate
across 50 concurrent clients.

**What it does:** Unix-socket IPC server providing SharedKV, distributed locks, and
pub/sub to any process on the same machine. Already used for multi-agent
synchronisation.

**The gap (part 1 — tool.call not implemented):**
`src/daemon/daemon-server.ts:562` has `case 'tool.call': throw new Error('not implemented in daemon v3.0')`.
Implementing this would allow 2nd+ Claude windows to route tool calls through the
first window's already-connected MCPHub instead of re-initialising 22 child servers
(saving ~10 s cold start per additional window).

**The gap (part 2 — sidecar cache is 50 lines):**
A sidecar cache at `~/.mcp-conductor/tool-cache.json` would let `mcp-hub.ts`
write discovered tool schemas after first connect, then read them back on subsequent
starts before calling `hub.initialise()`. This enables lazy-connect to show an
accurate tool catalog on startup without waiting for any child servers. The cache
invalidation logic is trivial (TTL or hash of server config).

Changes needed: add `cacheServerTools()` to `src/hub/mcp-hub.ts` and read the cache
at the top of `initialise()`. ~50 lines total.

---

### 4.4 VectorIndex (#08)

**Location:** `src/runtime/findtool/vector-index.ts` — TF-IDF cosine similarity
index. Seeded at startup with all 498 backend tool descriptions.

**What it does:** Semantic search over tool descriptions. Returns ranked results
by vector similarity, enabling multi-word natural-language queries to match tools
whose names differ from the query terms.

**The gap:** `discover_tools` in `src/server/mcp-server.ts:1033–1082` does a
substring match. The VectorIndex is only used inside Deno sandbox scripts via the
`findTool` helper function. The `searchTools` function in `src/hub/mcp-hub.ts:612–631`
also uses substring matching.

**The minimum viable fix** is not to route through VectorIndex (though that would
work) but to add ~25 lines of token-split BM25 scoring to both functions. This
is lower risk than changing the seeded index query path. The VectorIndex is then
available as a Phase 2 upgrade to full semantic search.

---

## Section 5 — Phase 1 Implementation Plan (next 1–2 days)

Each task is ≤4 hours, sequenced by dependency, with file:line, before/after
measurement, and a test guard. Tasks 1–3 are the three crisis fixes. Tasks 4–6
are the highest-impact "already built, just unwire" wins.

---

### Task 1 — Fix instructions truncation (#10, #05)
**Effort:** 2 h | **Risk:** Low | **Dependency:** none

**File:** `src/server/mcp-server.ts` (initialize response construction, line ~276)

**Before:** `serverInfo.instructions` = 3,086-character string. Silently truncated
at 2,048 chars in every Claude Code session.

**After:** `serverInfo.instructions` ≤ 1,900 characters. Detailed examples moved
to `get_capabilities` response body.

**Measurement:**
```
wc -c <<< "$(node -e "const s=require('./src/server/mcp-server'); ...")"
# or: grep -c '' <(echo "$INSTRUCTIONS_FIELD") — must be ≤1900 chars
```

**Test guard:** Add a unit test asserting `instructions.length <= 1900` in the
initialize response fixture. This test should fail before the fix and pass after.

---

### Task 2 — Wire trimResultToBudget to passthrough (#07)
**Effort:** 2 h | **Risk:** Low | **Dependency:** none

**Files:**
- `src/server/mcp-server.ts:1700` — `passthrough_call` handler
- `src/server/passthrough-registrar.ts:285` — auto-registered tool call wrapper

**Before:**
```typescript
// passthrough-registrar.ts:288-315 — raw backend string returned verbatim
return { content: [{ type: 'text', text: rawResult }] };
```

**After:**
```typescript
const trimmed = trimResultToBudget(rawResult, { maxTokens: 8000 });
return { content: [{ type: 'text', text: trimmed }] };
```

Also: replace `JSON.stringify(output, null, 2)` with `JSON.stringify(output)` at
admin tool sites: lines 2238, 2453, 2478, 2518, 2586, 2624, 2660.

**Measurement:** Create a test fixture that passes a 1 MB string through the
passthrough handler and asserts `result.content[0].text.length < 35000` (8k tokens × ~4 chars).

**Test guard:** Integration test: mock a backend tool that returns 1 MB of JSON;
call via passthrough_call; assert result byte count ≤ ~32 KB.

---

### Task 3 — Fix discover_tools recall (#08)
**Effort:** 3 h | **Risk:** Low | **Dependency:** none

**Files:**
- `src/server/mcp-server.ts:1033–1082` — discover_tools handler
- `src/hub/mcp-hub.ts:612–631` — hub.searchTools

**Before:** Single substring match. Query "list pull requests" misses tool named
`list_prs` with description "Enumerate open pull requests".

**After:** Token-split scoring. Split query and each tool name+description into
tokens; score by matched token count weighted by position in description.

```typescript
function tokenScore(query: string, tool: { name: string; description: string }): number {
  const qTokens = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 2));
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (haystack.includes(t)) score++;
  }
  return score / qTokens.size;
}
// Return tools sorted by score, filter where score > 0
```

**Measurement:** Run the 12-query test set from #08. Assert ≥10/12 queries return
the correct tool in the top 3 results (was: 3/12).

**Test guard:** Add test cases for "list pull requests" → `list_prs`, "get stock
price" → `get_stock_info`, "search web" → `brave_web_search`.

---

### Task 4 — Reduce connectionTimeoutMs from 10,000 to 2,000 (#01)
**Effort:** 15 min | **Risk:** Low | **Dependency:** none

**Files:**
- `src/hub/mcp-hub.ts:76` — `connectionTimeoutMs: 10000` → `connectionTimeoutMs: 2000`
- `src/server/mcp-server.ts:276` — `const connectTimeoutMs = conductorCfgForHub?.connect_timeout_ms ?? 2000`
  (default already 2000 per the finding; confirm it is not inadvertently set to 10000 elsewhere)

**Before:** Cold start 10,468 ms (srv-a consumes entire 10 s timeout).

**After:** Cold start ~3,900 ms (srv-a consumes one 2 s slot; remaining 21 servers
connect in parallel within that window or time out at 2 s each, whichever is first).

**Measurement:**
```bash
time npx mcp-conductor --version  # proxy for startup time
# or: node -e "const {start} = require('./dist'); const t=Date.now(); start().then(()=>console.log(Date.now()-t))"
```

**Test guard:** Existing integration test for startup timing; add assertion that
startup with all backends unreachable completes in < 5,000 ms.

---

### Task 5 — Wire WorkerPool to execute_code (#02)
**Effort:** 4 h | **Risk:** Medium (permissions) | **Dependency:** none

**Files:**
- `src/server/mcp-server.ts:270` — replace `new DenoExecutor(config.sandbox)` with WorkerPool when `config.sandbox.workerPool` is set
- `src/runtime/pool/pooled-worker.ts` — fix permissions from `--allow-net` to `--allow-net=localhost:${bridgePort}`; add `--deny-read` or scope `--allow-read` to match executor

**Before:** `this.executor = new DenoExecutor(config.sandbox)` — 44 ms/call spawn.

**After:** `this.executor = config.sandbox.workerPool ? new WorkerPool(config.sandbox) : new DenoExecutor(config.sandbox)` — <1 ms/call for pooled workers.

**Measurement:** Run the `execute_code` latency microbenchmark from #02 (20 sequential
calls); assert p50 < 5 ms when workerPool is enabled.

**Test guard:** Add `workerPool.enabled: true` to the test server config; assert
no regression in sandbox security by verifying that `--allow-net` is scoped.

---

### Task 6 — Sidecar tool cache for warm starts (#14)
**Effort:** 2 h | **Risk:** Low | **Dependency:** none (Phase 3 daemon broker depends on this)

**Files:**
- `src/hub/mcp-hub.ts` — add `cacheServerTools(path)` and `loadCachedTools(path)` methods
- `src/server/mcp-server.ts` — call `loadCachedTools` at top of `start()`, before `hub.initialise()`

**Before:** Every startup re-discovers all 22 servers' tool schemas from scratch.
Lazy connect (Task 4 prerequisite) cannot show accurate tool names without waiting.

**After:** `~/.mcp-conductor/tool-cache.json` stores all tool schemas after first
startup. Subsequent startups load from file in ~20 ms; `hub.initialise()` can
immediately report a full catalog before connecting any child server.

**Measurement:** Time a second startup with cold sidecar disabled vs enabled.
Assert second startup catalog is available (non-empty tool list) within 500 ms.

**Test guard:** Create a fixture that writes a known tool cache, starts the hub,
and asserts the catalog is populated before `initialise()` completes.

---

## Section 6 — Phase 2 and Phase 3 Outline

### Phase 2 (1–2 weeks)

- **Presence-layer surgery (#05):** Gate all admin tools (add/remove/update/reload/
  test/diagnose server, import/export) behind `config.expose_admin_tools` (default false
  in non-dev mode). Move `import_servers_from_claude` and `export_to_claude` to CLI-only.
  Collapse `add_server` + `update_server` into one `upsert_server` tool. Target: −1,296 t
  per Desktop session, −438 t for Claude Code (admin stubs removed from deferred list).

- **Instructions field rewrite (#10, #05):** New condensed `serverInfo.instructions`
  leading with the execute_code call pattern, one-line routing heuristic, link to
  `get_capabilities` for full reference. ≤1,600 chars.

- **Fix Desktop deferred-loading bugs (#10):** Three bugs in MCPClient:
  1. `capabilities: {}` at construction — needs `{ tools: { listChanged: true } }`
  2. `_setupListChangedHandler` never invoked for Desktop clients
  3. `tools` bound to a `const` array — needs re-assignment on list_changed event
  These three fixes enable Claude Desktop to participate in deferred tool loading,
  reducing its always-on cost to parity with Claude Code.

- **Wire CacheLayer to passthrough (#03):** Thread `this.cache` through passthrough
  registrar. Add `cacheHit: boolean` to DiagPayload. Surface `CacheStats` in
  `get_metrics` response.

- **tokenize combined regex (#16):** Merge 7 sequential regex passes into one
  alternating group regex. −86% processing time at 10 MB. Ship Option 4 (lazy
  walk skip for zero-PII payloads) in the same PR.

- **findTool typed-array score buffer + query LRU cache (#16):** Replace heap-
  allocated scored objects with `Float32Array`/`Int32Array`. Add 64-entry LRU
  cache keyed on normalised query. p99 @ 10k tools: 359 ms → ~5 ms cache-hit.

- **MCP Prompts (#11):** Implement `/catalog`, `/status`, `/help` as MCP Prompt
  objects. These appear as slash commands in Claude Desktop. Zero token cost at
  startup; zero always-on overhead.

- **Token constants deduplication (#04):** Extract `src/metrics/token-constants.ts`
  and import in all three current locations. Eliminates ±25% formula divergence.

- **compare_mode auto-disable (#15):** Add `max_compare_calls` parameter (default
  20). Auto-disable after that count with a warning. Prevents accidental 2×
  backend load from forgotten compare mode.

- **default_params per server (#09):** Add `default_params` to `ConductorServerConfig`.
  Inject before `hub.callTool`. Enables `per_page: 25` defaults for pagination-heavy
  backends without per-call client overhead.

### Phase 3 (2–4 weeks)

- **Daemon broker (tool.call implementation) (#14):** Implement `case 'tool.call'`
  in `src/daemon/daemon-server.ts:562`. First Claude window registers as the "primary"
  conductor; subsequent windows route tool calls to it over the Unix socket, inheriting
  its already-warmed MCPHub connections. 2nd+ window startup: ~300 ms vs 10,468 ms today.

- **Lazy connect with prewarmed catalog (#06):** Ship `connect_mode: 'eager' | 'lazy' | 'prewarmed'`
  in `ConductorServerConfig`. Prewarmed = load sidecar cache, connect lazily on first
  actual tool call. Combine with daemon broker so 2nd+ windows never touch child
  servers directly. Cold start for any window after the first: ~150 ms.

- **MCP Tasks (durable async) (#11):** Implement MCP Tasks spec. `execute_code` calls
  return a task ID immediately; result delivered via `tasks/updated` notification. Enables
  long-running Deno scripts without blocking Claude's context window for the duration.

- **Resource subscriptions (#11):** 5-line win. Emit `notifications/resources/updated`
  when a child server connects or disconnects. Claude Desktop can subscribe and update
  its catalog live without a full reinitialise.

- **HNSW vector backend option (#16):** Gate behind `MCP_CONDUCTOR_VECTOR_BACKEND=hnsw`.
  Defer until tool registry routinely exceeds 5,000 entries. Current 498-tool load
  is not a justification.

---

## Section 7 — Open Questions, Blockers, and External Dependencies

### 7.1 srv-a behaviour under 2,000 ms timeout

Finding #01 identifies srv-a as the server consuming the full 10,000 ms timeout. The
finding does not determine whether srv-a is:
- A permanently unreachable host that should be removed from the config
- A slow-starting server that needs a longer individual timeout
- A development server that is legitimately down during this audit

**Action needed:** Check `~/.mcp-conductor.json` for srv-a's URL and whether it
is expected to be reachable. If it is a test server left in config, remove it.
If it is a real backend that needs >2,000 ms, give it an individual `connect_timeout_ms`
override in the server config rather than raising the global default.

### 7.2 Claude Code 2,048-char instructions limit

Finding #10 cites this limit from Claude Code's source but does not link to a public
spec or changelog entry. If Anthropic raises this limit in a future Claude Code
release, the instructions truncation crisis downgrades to a cosmetic issue.

**Action needed:** Confirm the 2,048-char limit is hardcoded (not configurable) and
monitor Claude Code release notes for changes to this behaviour.

### 7.3 Claude Desktop deferred loading

Finding #10 identifies three bugs that prevent Claude Desktop from using deferred
tool loading. The MCP specification for `notifications/tools/list_changed` is
version 2025-11-25+. Older Claude Desktop builds may not support this notification
at all regardless of the bug fixes.

**Action needed:** Test the three MCPClient fixes against the latest Claude Desktop
release. Do not ship these fixes without a Desktop version compatibility check.

### 7.4 WorkerPool Deno permission model

Finding #02 identifies that `PooledWorker` uses `--allow-net` (unrestricted network
access) while `DenoExecutor` scopes to `--allow-net=localhost:PORT`. Wiring the pool
to execute_code without fixing the permission model would be a **security regression**
— any Deno script could exfiltrate to arbitrary network destinations.

**Blocker:** WorkerPool wiring (Task 5 above) MUST NOT ship until `--allow-net=localhost:${bridgePort}`
is enforced in `src/runtime/pool/pooled-worker.ts`.

### 7.5 BM25 vs VectorIndex routing for discover_tools

Two implementation paths exist for fixing discover_tools recall (#08):
1. Token-split BM25 in place (~25 lines, no new deps, ~95% recall)
2. Route through existing VectorIndex (~5 lines change, ~98%+ recall, but adds
   a code path dependency on the sandbox findtool module for a server-level function)

The choice affects the architecture: path 2 creates a dependency from the MCP server
layer into the runtime/findtool layer that currently only exists inside the Deno
sandbox. This is not a blocker but deserves a deliberate decision before the fix
is shipped.

### 7.6 Sidecar cache invalidation strategy

The sidecar cache (Task 6) needs an invalidation signal. Options:
- TTL (e.g., 24 hours) — simple, may serve stale schemas after a backend update
- Hash of conductor config's server list — invalidates when servers are added/removed,
  not when individual server schemas change
- Version header from each server's initialize response — most accurate, requires
  storing per-server schema versions in the cache file

No recommendation is codified in finding #14. **Decision needed before Task 6.**

---

## Section 8 — Discipline Note: Three Autonomous Commits

During the `feat/lean-defaults` branch work, three commits were made autonomously
by an agent session without explicit user approval for each commit:

- `20af911` — (content not specified in the findings, inferred from branch context)
- `bad5056` — (content not specified in the findings)
- `20b6262` — (content not specified in the findings)

These commits are visible in `git log --oneline feat/lean-defaults` above the audit
baseline commit `f12f5f5`.

**The discipline issue:** Autonomous commits on a feature branch without per-commit
user authorisation create two problems:

1. **Review gap:** The human owner cannot distinguish "I asked the agent to do X
   and it committed" from "the agent decided to commit X on its own initiative."
   This erodes trust in the git history as a reliable record of deliberate decisions.

2. **Rollback complexity:** If one of those commits introduced a regression, the
   owner must identify which autonomous commit is responsible without a clear
   human-approval audit trail.

**Requested discipline for future agent sessions on this repo:**
- Do not create commits without explicit instruction ("commit this", "stage and
  commit the changes to X").
- Prefer staging changes (`git add`) and describing what would be committed,
  then waiting for authorisation.
- Exception: explicitly-scoped batch tasks where the authorisation covers all
  commits ("implement Phase 1 tasks 1–6 and commit each with a message") are fine,
  but the scope must be stated upfront by the human.

The three commits may be entirely correct. The concern is process, not content.
The owner should review them with `git show 20af911 bad5056 20b6262` to confirm.

---

## Section 9 — Discrepancies Between Findings

### 9.1 Always-on token cost: #05 (4,383 t) vs #10 (~892 t for Claude Code)

These two numbers are both correct. They measure different clients.

**Finding #05** measures the full MCP initialize handshake cost — all 29 meta-tool
schemas, all descriptions, inputSchemas, outputSchemas, plus the instructions field.
This is what Claude Desktop sees on every session: **4,383 tokens** loaded into the
prefix unconditionally because Desktop does not support deferred tool loading.

**Finding #10** measures what Claude Code 2.1+ sees: the deferred loading path. Tool
schemas are NOT sent in the initialize response. Only "stubs" (tool name + truncated
description, ~4 tokens each × 29 tools = ~120 tokens) appear in the prefix. The
full schema for a tool is injected only when Claude Code requests it (on first use).
Add the instructions field (772 t, but truncated to ~512 t by the 2,048-char limit):
Claude Code always-on prefix is **~632–892 tokens**, not 4,383.

**The table in Section 1 reflects this correctly** by showing separate rows for
Claude Code and Claude Desktop always-on tokens.

**Practical implication:** The presence-layer surgery from finding #05 (−1,296 t)
has its full impact on Claude Desktop. For Claude Code, the benefit is only felt in
the per-turn cost when Claude Code fetches a tool schema — and only for tools that
were removed from the deferred list or whose schemas were shortened.

### 9.2 findTool p99 as benchmark artefact (#00 vs #16)

Finding #00 reports `findTool p99 @ 10k = 359 ms` as a concerning outlier.
Finding #16 (Bottleneck 2) explains the root cause: the p99 is a GC pressure artefact,
not a consistent code-path latency. The median query at 10k tools is 3.37 ms.
The 359 ms p99 is caused by V8 GC pauses triggered by the 780 KB per-query heap
allocation in `VectorIndex.search()`.

The fix (typed-array score buffer) eliminates the GC trigger, bringing p99 to ~80 ms.
Adding the query LRU cache brings repeated-query p99 to ~5 ms. Neither fix changes
the algorithmic complexity; both eliminate unnecessary allocations.

The p99 is real under concurrent load and should not be dismissed, but it does not
indicate that `findTool` is generally slow — it indicates that `findTool` under
sustained concurrent use produces GC pauses that occasionally land on a query.

### 9.3 Cold-start measurement methodology

Finding #00 reports cold start at 10,468 ms. Finding #01 attributes this entirely
to srv-a's 10,000 ms timeout. Finding #06 reports that lazy connect achieves ~150 ms
cold start — implying the 10,468 ms is 99% timeout wait, not real initialisation work.

This is consistent: the 468 ms remainder after removing srv-a's 10,000 ms is the
actual connection and tool-discovery time for the remaining 21 healthy servers in
parallel. This is well within acceptable bounds.

The headline improvement from Phase 1 Task 4 (connectionTimeoutMs → 2,000 ms) is
therefore not "making startup faster" in the general case — it is "stopping conductor
from waiting for a broken server for 8 unnecessary seconds."

### 9.4 VectorIndex seeding vs discover_tools

Finding #08 states that the VectorIndex is seeded at startup with all 498 backend
tool descriptions. Finding #08 also states that discover_tools does NOT use the
VectorIndex. This appears contradictory: why seed an index that nothing reads?

Resolution: The VectorIndex is seeded to serve the `findTool` helper that runs
INSIDE Deno sandbox scripts via `mcp.findTool(query)`. When a Claude-authored Deno
script calls `mcp.findTool('search github issues')`, the sandbox helper queries the
pre-seeded VectorIndex. The server-side `discover_tools` meta-tool is a separate
code path that was implemented independently and uses the older substring match.
The VectorIndex exists and works; it is simply not exposed through discover_tools.

### 9.5 DiagPayload omissions (#03 vs #15)

Finding #03 notes that CacheStats are never surfaced in get_metrics and DiagPayload
has no `cacheHit` field. Finding #15 notes that `MetricsCollector.recordExecution`
is always called (no enabled gate) but never passes cache status.

These are consistent: the cache instrumentation gap is a consequence of CacheLayer
being wired only to the bridge /call path (which is largely unused compared to
passthrough). Once CacheLayer is wired to passthrough (Phase 1 Task 5b / Phase 2),
adding `cacheHit` to DiagPayload and CacheStats to get_metrics becomes immediately
useful and should accompany that wiring PR.

---

*End of SYNTHESIS. Total findings synthesised: 16 (#00 baseline + #01–#16). All 16
appear in the priority matrix. Phase 1 alone is expected to resolve the three crisis
findings and reduce cold-start latency by ~63% on the eager-connect path, or ~99%
on the lazy-connect path, while cutting per-execute_code overhead from 44 ms to <1 ms.*
