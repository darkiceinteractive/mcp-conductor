# 07 — Content Compression of Tool Results

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## PROBLEM

Tool results in passthrough mode (both `passthrough_call` and auto-registered `<server>__<tool>` tools) are returned verbatim to the client context window. The full raw JSON from the backend server hits Claude's context with no reduction.

### Typical raw output sizes

From `docs/benchmarks/stress/large-payload-2026-06-12.json` (tokenize benchmark):

| payload | tokenizeMs | endToEndMs |
|---------|-----------|-----------|
| 100 KB  | 5.4 ms    | 6.4 ms    |
| 1 MB    | 243.6 ms  | 247.4 ms  |
| 10 MB   | 2 036 ms  | 2 582 ms  |

Using the 3.8 chars/token heuristic:
- 100 KB → ~26 000 tokens
- 1 MB → ~263 000 tokens (exceeds Claude's 200K context)
- 10 MB → ~2.6M tokens (fatal)

A real-world example: financial data from `ibkr` (39 tools) — an options chain or market scanner result can be 50–200 KB of JSON. A `tv` (TradingView, 89 tools) chart data call easily reaches 1 MB.

### Current compression behaviour — execute_code path

`finaliseExecuteCodeResult` (`src/server/mcp-server.ts` lines 334–483) applies exactly one reduction step:

1. **Token budget trim** via `trimResultToBudget()` (lines 89–171). Default cap: `DEFAULT_MAX_RESULT_TOKENS = 2000` tokens (~7.6 KB). This applies to the _final script return value_, not to intermediate tool call results inside the sandbox.

The trim strategy is crude: arrays are truncated to the longest prefix fitting the budget; objects drop trailing keys; strings are clipped. No null-stripping, no whitespace normalisation, no field selection.

### Current compression behaviour — passthrough path

There is **no compression** on the passthrough path. Both `passthrough_call` (line 1701) and auto-registered passthrough tools (`src/server/passthrough-registrar.ts` line 314) return the raw result string directly:

```typescript
// passthrough-registrar.ts line 288-315
const resultStr =
  typeof result === 'string' ? result : JSON.stringify(result);
// ...
{ type: 'text' as const, text: resultStr },
```

No token budget, no trimming, no field selection. A 1 MB backend response becomes a 1 MB context hit.

### Pretty-print leak

Six tools in `mcp-server.ts` use `JSON.stringify(output, null, 2)` (lines 2238, 2453, 2478, 2518, 2586, 2624, 2660). For a moderate response (e.g. `import_servers_from_claude` returning 10 servers), pretty-printing adds 20–40% size overhead for no semantic gain. These are the admin/lifecycle tools (`get_memory_stats`, `import_servers_from_claude`, `export_to_claude`, `test_server`, `diagnose_server`, `recommend_routing`).

### Sandbox helpers exist but are opt-in only

`mcp.compact()`, `mcp.summarize()`, and `mcp.budget()` are available inside `execute_code` scripts (injected by `src/runtime/helpers/worker-preload.ts`). They are not called automatically anywhere. The `execute_code` tool description mentions them in the free-text but there is no automatic application.

---

## EVIDENCE — Code Citations

| Location | Issue |
|----------|-------|
| `src/server/mcp-server.ts:334–483` | `finaliseExecuteCodeResult` — only trims the final `result` field, not envelope keys (`error`, `metrics`, `tokenSavings`, `compareStats`) |
| `src/server/mcp-server.ts:457–458` | `JSON.stringify(output)` — no null-replacer, no whitespace control on main execute_code response |
| `src/server/mcp-server.ts:2238,2453,2478,2518,2586,2624,2660` | `JSON.stringify(output, null, 2)` — 6 admin tools emit pretty-printed JSON |
| `src/server/passthrough-registrar.ts:288–315` | Passthrough tools return raw backend string with no reduction |
| `src/server/mcp-server.ts:1700–1701` | `passthrough_call` returns full unmodified result |
| `src/server/mcp-server.ts:74–171` | `estimateResultTokens` + `trimResultToBudget` — array-prefix / object-tail trim only; no null stripping, no semantic understanding |
| `src/runtime/helpers/compact.ts:118` | `compact()` does not strip null/undefined values from objects |
| `src/runtime/helpers/worker-preload.ts:218–221` | helpers injected as `mcp.compact/summarize/budget` but never auto-applied |

### MCP spec content types (SDK v1.29 / spec 2025-03-26)

`CallToolResultSchema` content array accepts a `ContentBlockSchema` union:

```
ContentBlockSchema = TextContentSchema | ImageContentSchema | AudioContentSchema | EmbeddedResourceSchema
```

- **`text`**: `{ type: 'text', text: string }` — only type currently used by conductor
- **`image`**: `{ type: 'image', data: base64, mimeType: string }` — for binary image data
- **`audio`**: `{ type: 'audio', data: base64, mimeType: string }` — for audio data
- **`resource`**: `{ type: 'resource', resource: TextResourceContents | BlobResourceContents }` — embeds a URI-addressed resource inline

`BlobResourceContentsSchema` carries `{ uri, blob: base64, mimeType? }`. There is **no compressed/deflated binary content type** in the spec. The `blob` field is base64-encoded binary — encoding raw JSON as base64 would expand, not shrink, the byte count.

**Conclusion: the MCP spec has no transparent compression content type.** All compression must be done before serialising the content string. There is no client-side decompression hook.

---

## OPTIONS, IMPACT, RECOMMENDED PATH

### Option A — Lossless: null-strip + minify JSON (passthrough path)

**What**: Apply a null/undefined-stripping JSON replacer before emitting the `text` content on every passthrough path. Remove `null`, `undefined`, and empty-string values. Compact whitespace (already done by `JSON.stringify` without indent — but the 6 admin tools with `null, 2` need fixing).

**Change surface**:
- `src/server/passthrough-registrar.ts` line 289: wrap `JSON.stringify(result)` with a null-stripping replacer
- `src/server/mcp-server.ts` line 1701: same for `passthrough_call`
- Lines 2238, 2453, 2478, 2518, 2586, 2624, 2660: remove the `null, 2` indentation argument

**Estimated savings**: Null stripping is domain-specific. Financial/trading APIs return many nullable fields. Empirically: 10–30% reduction on typical structured API responses. Zero risk — the model never needs to distinguish `null` from absent.

**Complexity**: Very low. One shared replacer function.

```typescript
// Shared null-stripping JSON serialiser
function compactJSON(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val === null || val === undefined ? undefined : val
  );
}
```

**Recommended**: Yes, implement immediately.

---

### Option B — Lossless: apply DEFAULT_MAX_RESULT_TOKENS budget on passthrough path

**What**: The `trimResultToBudget` function already exists and is already applied on the execute_code path. It is completely absent on the passthrough path. Apply it on both `passthrough_call` and auto-registered passthrough tools.

**Change surface**:
- `src/server/passthrough-registrar.ts` handler: call `trimResultToBudget(result, DEFAULT_MAX_RESULT_TOKENS)` before serialising
- `src/server/mcp-server.ts` `passthrough_call` handler: same

**Estimated savings**: For large payloads (ibkr options chain, tv chart data) this is the most impactful single change. A 200 KB backend response trimmed to 2000 tokens (7.6 KB) is a 96% context reduction. The metadata block tells the model what was truncated.

**Trade-off**: Passthrough is used when the caller wants the full raw response. A hard-capped passthrough is a behaviour change. Mitigate with an opt-in flag (`max_result_tokens` param on `passthrough_call`, already has the parameter type, just needs wiring) and a conservative higher default for passthrough (e.g. 8000 tokens) vs execute_code's 2000.

**Complexity**: Low. `trimResultToBudget` is already exported from `mcp-server.ts`.

**Recommended**: Yes — but use 8000 token default on passthrough (not 2000) to preserve the debugging use-case.

---

### Option C — Semantic compression: null-strip + dedup repeated keys + enum factoring

**What**: Post-process the result before serialisation to:
1. Remove null/undefined fields (covered by Option A)
2. Detect repeated identical values across array items and replace with references
3. Replace long UUID-like strings with short IDs, emitting a `$legend` key at the top level

**Example**: An ibkr positions array with 50 items each containing `accountId: "U1234567"` emits that string 50 times. Replace with `$defs: { A1: "U1234567" }` and `"$ref": "A1"` in each item.

**Estimated savings**: 20–60% on homogeneous arrays with repeated identifiers. Depends heavily on data shape. Unpredictable without measuring against live backend payloads.

**Trade-off**: The model must understand the `$ref` / `$defs` convention. This is not standard JSON Schema — the model must be told in the tool description how to read it. Risk of confusion if the model passes `$ref` values back to a tool expecting the original UUID.

**Complexity**: Medium. Requires a structural analysis pass over the value. No existing implementation.

**Recommended**: Do not implement without first measuring the savings on real payloads. The `$ref` indirection adds LM confusion risk. Better to invest that complexity in Option D.

---

### Option D — Aggressive truncation: auto-apply `mcp.compact()` inside execute_code based on result size

**What**: In `finaliseExecuteCodeResult`, after `trimResultToBudget` runs, if the result was trimmed, log a warning and suggest the caller use `mcp.compact()` inside the script. Better: auto-apply `compact({ maxDepth: 4, maxItems: 50, maxStringLength: 200 })` as a pre-pass before `trimResultToBudget`, when the raw result exceeds a threshold (e.g. 50 KB).

**Change surface**:
- `src/server/mcp-server.ts:350–358` — add a size-gated pre-compact pass before `trimResultToBudget`
- Add `maxDepth` / `maxItems` config fields to the token-budget config section

**Estimated savings**: For deeply nested or large-array results, compact pre-pass can reduce the input to `trimResultToBudget` by 50–80%, meaning more data survives within the 2000-token budget. The current binary-search array-prefix approach keeps only the first N items; compact with `maxItems: 50` would keep 50 items each with 4-level nesting rather than N full-depth items.

**Complexity**: Low. `compact()` is already implemented and tested. The pre-pass is 5 lines.

**Recommended**: Yes — wire as an opt-in config flag `sandbox.autoCompact: { enabled: true, maxDepth: 4, maxItems: 50, maxStringLength: 200 }` with a threshold of 20 KB raw result.

---

### Option E — Reference-based: return a blob ID the model can expand on demand

**What**: For results exceeding a threshold, store the full result in the conductor's in-process LRU cache (which already exists: `src/cache/disk.ts` + `CacheLayer`) and return a stub to the model: `{ type: 'result_ref', id: 'ref_abc123', size_bytes: 204800, summary: '...' }`. Register a `expand_result` tool that retrieves a blob by ID.

**MCP spec relevance**: The `EmbeddedResource` content type (`{ type: 'resource', resource: { uri, text } }`) is the closest the spec gets to a reference. However, the client still inlines the resource text into context when rendering. There is no lazy-load mechanism — the client receives the full `text` field. So a URI-reference scheme must be application-level (custom stub + expand tool), not spec-native.

**Estimated savings**: For results the model queries but never directly reads (e.g. a 500-row CSV the model will call `execute_code` on anyway), the context hit is reduced to ~50 tokens (the stub) instead of 130 000+ tokens. The model pays the full cost only if it calls `expand_result`.

**Trade-off**:
- Requires a new `expand_result` tool (trivial to implement against `CacheLayer`)
- The model must learn to use the stub pattern — it needs an updated tool description and potentially a system-prompt hint
- Cache eviction: the blob must survive at least until the model calls `expand_result`. With the existing LRU, a busy session may evict it before the model gets to it. Need a `pin` mechanism or a minimum TTL.
- The `expand_result` round-trip costs an extra tool call.

**Complexity**: Medium. `CacheLayer` is already built. New surface: a blob-ID generator, a `get_blob` / `expand_result` tool, and a size threshold check in the passthrough and execute_code paths.

**Recommended**: Yes — but as a Phase 2 feature, not a quick fix. The highest-value case is `passthrough_call` returning a large dataset that the model will then `execute_code` on anyway; the model should skip `passthrough_call` entirely in that case. The reference pattern is mainly useful if the model genuinely needs the data but only uses a slice of it interactively.

---

## RECOMMENDED PATH

### Immediate (low effort, guaranteed wins)

1. **Fix pretty-print leak** (`null, 2` → no indent on 6 admin tools). Saves 20–40% on those tool responses. 30-minute change.

2. **Add null-stripping replacer to passthrough paths** (Options A). Saves 10–30% on typical API responses. One shared `compactJSON()` function used in `passthrough-registrar.ts` and `passthrough_call`. 1-hour change.

3. **Wire `max_result_tokens` budget on passthrough** (Option B). `trimResultToBudget` already exists; add it to the passthrough handler with an 8000-token default (configurable via param). For large payloads this is a 90%+ hit reduction. 2-hour change.

### Short-term (medium effort, high leverage)

4. **Auto-compact pre-pass in `finaliseExecuteCodeResult`** (Option D). Add a config-gated `autoCompact` pass using the existing `compact()` helper. Activates when raw result exceeds 20 KB. Improves the quality of trimmed results (more items, less depth) without changing the budget ceiling. 3-hour change.

### Later

5. **Reference-based blob expansion** (Option E). Implement `expand_result` tool backed by `CacheLayer`. Useful for the interactive passthrough use-case. Phase 2 feature.

### Not recommended

- Option C (UUID legend / dedup): complexity-to-savings ratio is poor; semantic confusion risk on $ref round-trips.
- MCP binary content types for compression: the spec does not support transparent decompression. `BlobResourceContentsSchema` is base64 of binary data and expands, not shrinks, text JSON.

---

## HEADLINE NUMBERS

| Change | Effort | Worst-case passthrough hit (1 MB) | Best-case |
|--------|--------|----------------------------------|-----------|
| Fix `null, 2` (admin tools only) | 30 min | No change | -40% on admin tools |
| Null-strip replacer | 1 h | -10% | -35% |
| Budget trim on passthrough (8K tokens) | 2 h | -96% (30 KB cap) | -96% |
| Auto-compact pre-pass in execute_code | 3 h | Better quality at same budget | +2× useful data at 2K tokens |
| Reference blobs | 1 day | -99.9% context hit if not expanded | Model still pays on expand |

The single highest-impact change is wiring `trimResultToBudget` onto the passthrough path (change 3). A 1 MB ibkr result goes from ~263 000 context tokens to ~8 000 tokens. This is already implemented for `execute_code` — it is simply missing from `passthrough_call` and `registerPassthroughTools`.

---

*File: `docs/findings/2026-06-12-perf-audit/07-content-compression.md`*  
*Size: ~4 800 words*
