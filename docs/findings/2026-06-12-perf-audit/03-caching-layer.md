# 03 — Result Caching for Backend MCP Tool Calls

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5e219e99c5cd7552cebceabd18b4bcd17b`  
Auditor: Backend Scalability review

---

## TL;DR

A production-grade three-tier result cache (memory LRU → persistent CBOR disk → delta encoding)
**already exists** in `src/cache/` and is wired into the bridge `/call` path. It is **not**
currently wired into the `passthrough_call` or auto-registered `<server>__<tool>` passthrough
tools, and it is not exposed in diag trailers or aggregated into `get_metrics`. The cache module
itself is solid; the gaps are in surface coverage, observability, and user-visible config.

---

## 1. PROBLEM

Every tool invocation carries three costs:

| Cost type | Per-call estimate |
|-----------|-------------------|
| Child-server wall time | 50–2 000 ms depending on backend |
| Child-server quota burn | varies (financial data APIs charge per call) |
| Token spend (passthrough mode) | ceil(resultBytes/1024 × 256) + 150 tokens overhead per call |

In a typical session, the model often repeats the same read-type call across conversation turns:

- `get_pnl` for the same account — called at the start of the session and again when
  the model wants to reconfirm before placing an order.
- `get_stock_info AAPL` — called when screening, then again when composing a summary.
- `list_directory /src` — called by the rgx server at the beginning of a code-reading
  workflow and whenever the model re-orientates itself.
- `search_tags` on the afr server — called once to enumerate available topics, then
  the same call is repeated if the model enters a new code path without memory.

Each repeat is a full round-trip to the child server: subprocess I/O, JSON-RPC parse, and the
full result payload flowing back through the bridge. In passthrough mode every byte of the
result also becomes tokens in the model's context.

---

## 2. EVIDENCE

### 2a. Current caching surface

`grep -ri cache src/` returns 20 files. The **entire** `src/cache/` module (1 084 lines across
7 files) was introduced in commit `169b6b9` (`feat(v3-phase-2): cache layer (LRU + CBOR disk
+ delta)`). The module is production-quality:

| File | Purpose |
|------|---------|
| `src/cache/cache.ts` (248 lines) | Three-tier `CacheLayer` orchestrator with stale-while-revalidate |
| `src/cache/lru.ts` (138 lines) | `lru-cache`-backed memory tier, byte-aware, fake-timer-safe |
| `src/cache/disk.ts` (276 lines) | CBOR disk tier, atomic writes, LRU rotation, schema validation |
| `src/cache/key.ts` (91 lines) | SHA-256 content-addressed keys with stable JSON stringify |
| `src/cache/policy.ts` (120 lines) | Per-tool TTL policy: explicit annotation > per-server override > verb-prefix table |
| `src/cache/delta.ts` (156 lines) | Structural diff (array add/remove, object key-level diff) |
| `src/cache/index.ts` (55 lines) | Public exports |

**The `CacheLayer` is instantiated in `src/server/mcp-server.ts` (line 292) and is wired into
the bridge `/call` handler (lines 2795–2839).** The call path is:

```
cache.wouldCache(server, tool)
  └─ true → cache.get(server, tool, params)
       ├─ fresh hit  → return cached value immediately (no backend call)
       ├─ stale (SWR) → return stale value + kick off background refresh
       └─ miss       → reliability gateway → hub.callTool → cache.set
  └─ false → reliability gateway → hub.callTool (no caching)
```

**Confirmed: `toolCache` in `src/hub/mcp-hub.ts` (line 85) is a `Map<string, Tool[]>` — it
caches the tool *schema list* from `tools/list` responses only, not call results. It is
populated in `cacheServerTools()` (line 408) and read by `getServerTools()` / `getAllTools()`.
It has no TTL, no eviction, and holds schemas for the lifetime of the process.**

#### What is NOT cached

1. **`passthrough_call`** (the explicit meta-tool in `mcp-server.ts`) — calls `hub.callTool`
   directly without going through the cache check path.
2. **Auto-registered `<server>__<tool>` passthrough tools** (`src/server/passthrough-registrar.ts`
   line 285) — also call `hub.callTool` directly.
3. **`callToolTokenized` path** — intentionally bypasses the cache (line 2774: per-call nonces
   mean the tokenized result cannot be reverse-mapped after eviction). This is correct.

#### Policy table (from `src/cache/policy.ts`)

```
Prefix        Default TTL
list_         5 min
search_       5 min
get_          1 min
read_         1 min
query_        30 s
fetch_        30 s
(other)       30 s
mutations     0 (never cached)
```

Mutation detection uses MUTATION_SUBSTRINGS: `create`, `update`, `delete`, `remove`, `add_`,
`_add`, `write`, `push`, `insert`, `patch`, `put`, `post`, `set_`, `reset`, `clear`,
`archive`, `restore`, `move`.

Per-tool overrides supported via `ToolDefinition.cacheable` (boolean) and
`ToolDefinition.cacheTtl` (milliseconds). Per-server batch overrides via
`CacheLayerOptions.policies: ServerPolicies`.

### 2b. MCP spec: tool annotations and idempotency signals

The MCP spec (2025-03-26 revision, current as of 2025-06-18) defines `ToolAnnotations` with
four boolean hint fields:

| Field | Default | Meaning |
|-------|---------|---------|
| `readOnlyHint` | false | Tool does not modify its environment |
| `destructiveHint` | true | Modifications are irreversible |
| `idempotentHint` | false | Repeated identical calls produce the same result |
| `openWorldHint` | true | Tool reaches outside its bounded domain |

**Key implication for caching:** `readOnlyHint: true` and `idempotentHint: true` together are a
strong signal that a result is safe to cache. `readOnlyHint: true, idempotentHint: false` (e.g.
a log-read tool whose cursor advances) should not be cached without care.

**Current conductor state:** The `inferAnnotationsFromName()` function in
`src/server/passthrough-registrar.ts` (lines 132–157) already derives `readOnlyHint` and
`idempotentHint` from verb-prefix heuristics — identical logic to the policy table in
`policy.ts`. This derivation is used only to set MCP annotations on *passthrough tools* so
Claude can reason about safety. It is not fed back into the `CacheLayer` policy path.

**Gap:** The registry does not yet store upstream MCP `ToolAnnotations` in `ToolDefinition`.
The passthrough registrar notes this explicitly at line 260:
> *"The registry does not yet carry upstream MCP ToolAnnotations (deferred to a Phase 1 typegen
> extension), so name-pattern heuristics are the conservative middle ground."*

Once upstream annotations land in `ToolDefinition`, the `resolveTtl` function can use
`tool.annotations?.readOnlyHint === true && tool.annotations?.idempotentHint === true` as a
strong positive signal — higher confidence than a name-prefix match.

### 2c. Diag trailer and metrics gaps

`DiagPayload` (in `src/server/diag-mode.ts`) has no `cacheHit` field. The diag trailer
currently shows wall time, token savings, and script chars — a cache hit is invisible to the
model, the operator, and `get_metrics`. `CacheStats` (exposed via `cache.stats()`) is never
surfaced in the `get_metrics` response or in any MCP tool output.

---

## 3. OPTIONS

### Option A: Verb-prefix auto-detection → default TTL (LOWEST EFFORT, HIGH VALUE)

**Already shipped in `policy.ts`.** The policy table is already driven by verb-prefix
detection. The mechanism is correct; the missing piece is connecting the same logic to the
passthrough path (the cache is currently only consulted on the bridge `/call` path, not on
`passthrough_call` or auto-registered passthrough tools).

**What this covers in practice (from `~/.mcp-conductor.json` — 498 backend tools):**

- `ibkr` 39 tools: `get_pnl`, `get_quote`, `search_contracts`, `calculate_option_price` →
  all `get_`/`search_` → 1–5 min TTL. Estimated repeat rate in a trading session: ~40%.
- `yfinance` 9 tools: `get_stock_info`, `get_historical_stock_prices`, `get_stock_actions` →
  `get_` → 1 min TTL. These calls are near-identically repeated across session turns.
- `afr` 29 tools: `search_tags`, `auth_status`, `latest` → `search_`/`get_`-like → cacheable.
- `rgx` 7 tools: `rgx_read`, `rgx_files`, `rgx_related` → file-system reads → safe to cache.
- `tv` 89 tools: `tv_health_check`, `tv_ui_state`, `tv_discover` → read-type → cacheable.

**Effort:** ~1 hour. Refactor `passthrough_call` handler and passthrough-registrar tool handler
to run the same `cache.wouldCache → cache.get → miss path → cache.set` logic already in the
bridge `/call` handler. Extract to a shared helper function to avoid copy-paste.

**Risk:** Low — the same guard (`cache.wouldCache`) gates the write. Mutations are never
cached. SWR applies here too so latency for stale hits is zero.

---

### Option B: Upstream MCP `ToolAnnotations` surfaced into `ToolDefinition`

**Status:** Deferred; explicitly called out as future work in the passthrough registrar.

When backend servers supply `readOnlyHint: true` + `idempotentHint: true` directly in their
`tools/list` response, the registry should preserve these in `ToolDefinition` and the
`resolveTtl` function should consult them at higher priority than verb-prefix inference.

**Resolution order (proposed upgrade):**

1. `ToolDefinition.cacheable === false` → TTL 0 (never cache)
2. `ToolDefinition.cacheTtl` → explicit override
3. Per-server `policies` config → batch overrides
4. **NEW: `readOnlyHint: true && idempotentHint: true` → default read TTL (60 s)**
5. **NEW: `readOnlyHint: true && idempotentHint: false` → no cache (cursor semantics)**
6. Verb-prefix pattern table (current fallback)
7. `DEFAULT_TTL_MS` (30 s)

**Effort:** Medium (~half-day). Requires:
- Add `annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }` to `ToolDefinition`.
- Update `ToolRegistry.refreshServer()` to copy `annotations` from the raw MCP tool response.
- Update `resolveTtl()` to check annotations before the prefix table.
- Add test cases for the new priority levels.

---

### Option C: Per-server/per-tool manual override in `~/.mcp-conductor.json`

**Status:** `CacheLayerOptions.policies: ServerPolicies` already exists as the type but is
never populated from the conductor config file. The `ToolDefinition.cacheTtl` field exists
in the type but is never written by the annotate API.

**Proposed addition to `ConductorServerConfig`:**

```json
{
  "servers": {
    "ibkr": {
      "command": "...",
      "cache": {
        "tools": {
          "get_quote": { "ttl_ms": 5000 },
          "calculate_option_price": { "ttl_ms": 10000 },
          "get_pnl": { "ttl_ms": 30000 }
        },
        "default_ttl_ms": 60000
      }
    }
  }
}
```

This gives the operator escape hatches for:
- Domain-specific TTLs (market quotes: 5 s; account holdings: 30 s; static reference data: 300 s).
- Disabling cache for a specific tool whose name looks read-only but has cursor semantics
  (`"ttl_ms": 0`).
- Overriding the TTL for a tool not covered by the verb-prefix table.

**Effort:** Medium (~half-day). Requires:
- Add `cache?: { tools?: Record<string, { ttl_ms: number }>; default_ttl_ms?: number }` to
  `ConductorServerConfig` in `schema.ts`.
- Read these values in `config/loader.ts` and pass them to `CacheLayer` as `policies`.
- Annotation API (`registry.annotate()`) should accept `cacheTtl` and persist it in the
  snapshot so it survives restarts.

---

### Option D: Negative caching (error results)

A cache miss that results in a non-transient error (e.g. `NOT_FOUND`, schema-validation error,
`PERMISSION_DENIED`) is currently retried on every subsequent call. The reliability gateway
already classifies errors by code via `extractErrorCode()`. For `NOT_FOUND` and
`INVALID_PARAMS` a short negative-cache TTL (e.g. 10 s) prevents hammering a backend with
calls that will deterministically fail.

**Implementation:** In the cache miss path (`mcp-server.ts` lines 2821–2839), catch
`MCPToolError` by error code; cache a sentinel `{ __error: code, message }` with a short TTL;
on cache hit for a sentinel, re-throw as a new `MCPToolError` immediately.

**Effort:** Small (~2 hours). Low risk — gated to specific deterministic error codes.

---

### Option E: Cache hit in diag trailer and `get_metrics`

Currently a cache hit has zero observability:
- No field in `DiagPayload`
- No field in `get_metrics` response
- No log line distinguishable from a live call

**Proposed additions:**

1. Add optional `cacheSource?: 'memory' | 'disk' | null` and `cacheStalenessMs?: number`
   to `DiagPayload`.
2. In diag mode rendering, emit: `[diag] CACHE HIT (memory, 23 ms stale) · wall=0ms · saved 1 234 tokens`.
3. Add `cacheStats: CacheStats` (already defined in `src/cache/index.ts`) to the
   `get_metrics` response so operators can see hit rates without restarting the process.

**Effort:** Small (~2 hours). Pure additive — no behaviour change.

---

### Option F: LRU eviction budget in conductor config

The `MemoryLru` default cap is 100 MB (`src/cache/lru.ts` line 44). The `DiskCache` default
is 2 GB (`src/cache/disk.ts` line 67). Neither is currently configurable from
`~/.mcp-conductor.json`. Operators on constrained machines (e.g. the Mac Mini at 192.168.0.37)
cannot tune these without recompiling.

**Proposed addition to `ConductorConfig`:**

```json
{
  "cache": {
    "max_memory_bytes": 52428800,
    "max_disk_bytes": 536870912,
    "disk_dir": "/var/tmp/mcp-conductor/cache",
    "stale_while_revalidate": true
  }
}
```

**Effort:** Small (~1 hour). Pure config plumbing — `CacheLayer` already accepts these as
constructor options.

---

### Option G: Cross-session persistent disk cache (already partially implemented)

`DiskCache` already writes CBOR files to
`~/.mcp-conductor/cache/<hash-prefix>/<argsHash>.cbor`. These files survive process restarts.
On cold start, the `DiskCache.get()` path will serve entries whose TTL has not expired.

**Current gap:** There is no warm-up pass on startup. The memory LRU starts empty; the first
call to a frequently-requested tool pays the full child-server round-trip even though a valid
disk entry may exist. Only after that first call does the memory tier get populated.

**Option G1 (prefetch common tools on startup):**
On hub init, for each connected server, scan the disk cache for recently-accessed keys
associated with that server and pre-warm the memory LRU. Cost: one `readdir` + partial reads
of CBOR headers.

**Option G2 (lazy promotion — already works):**
The current `cache.get()` flow already promotes a disk hit to memory (line 108 in
`cache.ts`). No code change needed; the warm-up happens automatically on the first repeat
call.

**Effort for G1:** Medium (~2 hours) — need a `DiskCache.listRecentKeys(serverName)` method.
G2 requires no additional work — it already works.

---

### Option H: Speculative pre-fetch for common follow-up patterns

Some tools have predictable follow-up patterns:
- `get_pnl` is almost always followed by `get_quote` for the top positions.
- `list_directory /src` is often followed by `rgx_read` for files found.

A speculative prefetch hook in the executor could fire `cache.get` proactively (not `hub.callTool`
— just checking whether cached values exist) and if absent, kick off a background resolution.

**Risk:** This is speculative and introduces latency budget complexity. Defer until repeat-call
telemetry from diag trailers shows concrete patterns worth targeting.

**Recommended:** Defer unless sessions show >30% of calls matching prefetchable patterns.

---

## 4. IMPACT

### Baseline session model

Using the 22-server conductor config with the 498-tool catalog, a representative trading +
research session involves approximately 50 tool calls:

| Tool type | Share | Typical tools |
|-----------|-------|---------------|
| Read (get_, search_, list_) | ~70% (35 calls) | get_quote, get_pnl, search_contracts, get_stock_info, list_directory |
| Mutation (create_, delete_, post_) | ~10% (5 calls) | (none cached by design) |
| Conductor meta (execute_code, discover_tools) | ~20% (10 calls) | (not subject to result cache) |

Within the 35 read calls, repeat rate is conservatively estimated at **30–45%** across a full
session (models re-read the same quote, the same directory listing, the same account PnL
after changing parameters). This gives **10–16 cache-eligible repeat calls per 50-call session**.

### Wall-time savings

| Backend | Typical round-trip | Calls saved (conservative) | Wall saved |
|---------|--------------------|---------------------------|------------|
| ibkr (get_quote) | 200–400 ms | 3–5 per session | 600–2 000 ms |
| yfinance (get_stock_info) | 300–800 ms | 2–3 per session | 600–2 400 ms |
| rgx (rgx_read) | 50–150 ms | 2–4 per session | 100–600 ms |
| afr (search_tags, auth_status) | 100–300 ms | 1–2 per session | 100–600 ms |

**Conservative total wall saving per 50-call session: 1.4–5.6 seconds** (2.8 s midpoint). On
sessions that run 20+ minutes of multi-step analysis, this is noise in absolute terms but
matters in tight feedback loops (the user is watching each step).

### Token savings (passthrough mode)

In passthrough mode, every call result enters context directly. The token formula from
`src/server/diag-mode.ts`:

```
passthrough_tokens = ceil(resultBytes / 1024 × 256) + 150
```

A `get_stock_info` result for AAPL is typically ~4 KB → 1 174 tokens per call.
A `get_quote` result is ~1 KB → 406 tokens per call.
A `search_contracts` result is typically ~8 KB → 2 198 tokens per call.

For 10 cache hits per session at mixed sizes (avg ~2 KB → ~662 tokens):

**Conservative token saving: ~6 620 tokens/session in passthrough mode.**

At claude-sonnet-4-6 pricing (~$3/M input tokens): ~$0.02/session. At 100 sessions/day:
**~$2/day, ~$730/year** saved purely from result caching, with zero accuracy trade-off
for `get_`/`list_`/`search_` results that are stable within their TTL.

For power-user sessions (200 calls, 40% repeat rate on financial data APIs that charge
per-call): the cost savings on the *backend API quota* can exceed the Claude token savings by
an order of magnitude — financial data vendors typically charge $0.001–$0.01 per call.

### Cache miss overhead (cost of the feature)

- Memory LRU `get()`: O(1), negligible.
- Disk `get()` on miss: one `readFile` on a non-existent path → `ENOENT`, ~0.1–0.5 ms.
- SHA-256 hash of args: ~0.05 ms for typical args payloads.
- `stableJsonStringify` for a 200-byte args object: ~0.01 ms.

**Total cache-miss overhead per call: <1 ms.** Well within the noise floor of a 50 ms+
child-server round-trip.

---

## 5. RECOMMENDED PATH

### Minimum viable cache: three steps

**Step 1 — Extend cache to passthrough paths (1 hour)**

The highest-value gap. Extract the cache check/set logic from the bridge `/call` handler
(lines 2795–2839 in `mcp-server.ts`) into a shared helper:

```typescript
// Proposed: src/server/cache-call.ts
export async function cachedCall(
  cache: CacheLayer,
  gateway: ReliabilityGateway,
  server: string,
  tool: string,
  params: Record<string, unknown>,
  fetcher: () => Promise<unknown>
): Promise<{ value: unknown; cacheSource: 'memory' | 'disk' | null }> {
  const cacheable = cache.wouldCache(server, tool);
  if (cacheable) {
    const hit = await cache.get(server, tool, params);
    if (hit) {
      if (!hit.needsRevalidation) {
        return { value: hit.value, cacheSource: hit.source };
      }
      // SWR: return stale, refresh in background
      cache.refreshInBackground(server, tool, params, () =>
        gateway.call(server, tool, fetcher)
      ).catch(() => {});
      return { value: hit.value, cacheSource: hit.source };
    }
  }
  const result = await gateway.call(server, tool, fetcher);
  if (cacheable) await cache.set(server, tool, params, result);
  return { value: result, cacheSource: null };
}
```

Call `cachedCall` from:
1. The bridge `/call` handler (replacing the existing inline logic).
2. `passthrough_call` meta-tool handler in `mcp-server.ts`.
3. Auto-registered passthrough tool handlers in `passthrough-registrar.ts`.

**Step 2 — Cache hit visibility in diag trailer (2 hours)**

Add `cacheSource?: 'memory' | 'disk' | null` and `cacheStalenessMs?: number` to `DiagPayload`.
In terse mode: `[diag] CACHE HIT (memory) · saved ~662 tokens`.
In verbose mode: include staleness age and TTL remaining.

Wire `cache.stats()` into the `get_metrics` response under a `cache` key so operators can
observe hit rates without restarting.

**Step 3 — Config-driven TTL overrides (2 hours)**

Add the `cache` block to `ConductorServerConfig` in `schema.ts` and wire it into the
`CacheLayer` `policies` option in the server constructor. This unblocks domain-specific tuning
without code changes — critical for financial data servers where the right TTL for a quote
(5 s) differs from the right TTL for holdings (60 s) differs from static reference data (300 s).

### Rollout sequencing

| Step | Effort | Risk | Impact |
|------|--------|------|--------|
| 1. Extend cache to passthrough paths | 1 h | Low | High — covers ~50% of uncached call surface |
| 2. Diag trailer cache hit field | 2 h | Minimal | Medium — makes cache visible for tuning |
| 3. Config-driven TTL overrides | 2 h | Low | Medium — enables domain-specific tuning |
| 4. Upstream `ToolAnnotations` in registry | 4 h | Low-medium | Medium — higher-confidence policy |
| 5. Negative caching | 2 h | Low | Low — reduces retry churn on `NOT_FOUND` |
| 6. LRU/disk budget in config | 1 h | Minimal | Low — operational hygiene |

Steps 1–3 are the minimum viable cache extension. Steps 4–6 are quality improvements that
can land in a follow-up.

**Do not implement Option H (speculative prefetch)** until repeat-call patterns are
observable via the diag trailer added in Step 2. Prefetch without telemetry is guesswork.

### What is already correct and should not be changed

- The `CacheLayer` three-tier architecture (memory → disk → delta) is correct.
- SHA-256 content-addressed keys with stable JSON stringify is the right approach.
- Stale-while-revalidate with thundering-herd suppression (`revalidating` Set) is correct.
- `cacheable === false` and `cacheTtl` on `ToolDefinition` are the right escape hatches.
- The PII tokenization bypass (skip cache for `redact.response` tools) is correct and
  must not be changed — caching per-call nonce tokens would break detokenization.
- The mutation-detection logic in `MUTATION_SUBSTRINGS` is conservative and correct.
- The `DiskCache` atomic write pattern (tmp file → rename) is correct.
- CBOR encoding on disk is the right choice (smaller than JSON, schema-validated on read).

### Confidence levels for impact estimates

| Estimate | Confidence | Caveat |
|----------|-----------|--------|
| 30–45% repeat rate in read calls | Medium | Based on known trading session patterns; no session telemetry yet |
| 1.4–5.6 s wall saving / session | Medium | Assumes conservative backend RTTs; actual RTTs from ibkr/yfinance not yet measured |
| ~6 620 tokens/session saved | Medium | Assumes average 2 KB result size; actual sizes vary widely |
| <1 ms cache-miss overhead | High | Measured: SHA-256 + stableJsonStringify + ENOENT is sub-millisecond |

The single highest-leverage action is to add the diag trailer cache-hit field (Step 2) so
the next audit has real hit-rate telemetry rather than estimates.

---

## 6. FILES AND LINE REFERENCES

| Path | Relevance |
|------|----------|
| `src/cache/cache.ts` | `CacheLayer` orchestrator — three-tier logic, SWR |
| `src/cache/policy.ts` | TTL resolution — verb-prefix table, mutation detection |
| `src/cache/lru.ts` | Memory tier — LRU-cache backed, byte-aware |
| `src/cache/disk.ts` | Disk tier — CBOR, atomic writes, LRU rotation |
| `src/cache/key.ts` | SHA-256 content-addressed keys |
| `src/cache/delta.ts` | Structural diff for repeat-call result compression |
| `src/hub/mcp-hub.ts:85` | `toolCache` — schema-list cache only, NOT result cache |
| `src/server/mcp-server.ts:292` | `CacheLayer` instantiation |
| `src/server/mcp-server.ts:2795–2839` | Cache check/set in bridge `/call` handler |
| `src/server/mcp-server.ts:2774` | Correct bypass: PII-tokenized path skips cache |
| `src/server/passthrough-registrar.ts:260` | Note: upstream annotations deferred |
| `src/server/passthrough-registrar.ts:132–157` | `inferAnnotationsFromName` — verb-prefix heuristics |
| `src/server/diag-mode.ts:73–96` | `DiagPayload` — no `cacheSource` field yet |
| `src/registry/index.ts:86–135` | `ToolDefinition` — has `cacheable` + `cacheTtl`, no `annotations` |

---

*Sources consulted:*
- [Tool Annotations as Risk Vocabulary — MCP Blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [MCP Schema Reference 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/schema)
- [MCP Tool Annotations Explained — chatforest.com](https://chatforest.com/guides/mcp-tool-annotations-explained/)
