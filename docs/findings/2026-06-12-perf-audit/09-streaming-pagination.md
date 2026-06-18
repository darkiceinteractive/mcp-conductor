# 09 — Streaming Partial Results & Pagination for Large Tool Outputs

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## Problem

Backend tools that return large datasets (e.g. `ibkr` option chains, `tv` scanner results, `afr` article lists) currently flow through the conductor as one atomic JSON blob.  Every byte lands in the MCP tool-result content field, which the model context window ingests in full.  This creates two distinct failure modes:

1. **Token overspend**: A single `ibkr.run_market_scanner` call can return hundreds of option contracts.  Even after `trimResultToBudget` with the 2000-token default, the trimmed response may still be large — or worse, trimmed data silently drops information the caller needed.
2. **Wall-time blockage**: The `execute_code` handler blocks its entire timeout waiting for the full result before returning anything.  At 10 MB the tokenizer alone takes ~2 s (baseline table: 2 036 ms tokenize + 247 ms end-to-end = realistically 2–2.5 s serialization overhead before any result reaches the model).

There is no mechanism today for:
- a caller to ask for page 2 of a large result set,
- the conductor to stream summarised chunks back mid-call,
- user sandbox scripts to yield partial results incrementally, or
- per-server default limits being injected before results even leave the backend.

---

## Evidence

### 1. Protocol: what the MCP spec supports

**`notifications/progress`** (SDK types, `ProgressNotificationParamsSchema`):
```
{ progressToken, progress, total?, message? }
```
- `progress` and `total` are numeric — intended as progress counters, not partial data payloads.
- The `message` field is a single string.
- There is **no official MCP mechanism to stream partial tool-result content** during a single tool call.  The spec's `notifications/progress` is progress-telemetry only; the actual tool result is still delivered as one atomic `tools/call` response.

**Cursor-based pagination** (`PaginatedRequestParamsSchema`):
```
{ cursor?: string }  →  { nextCursor?: string, ... }
```
- Already defined in the MCP SDK (`CursorSchema`, `PaginatedResultSchema`).
- Used by `tools/list`, `resources/list`, `prompts/list` — but **not** by individual `tools/call` responses.  A server can return `nextCursor` in a list response; there is no standard way to paginate a single tool call's output.

**Conclusion**: The MCP protocol does not natively support streaming partial data within a single tool call, nor does it support cursor-based pagination on tool results.  The only in-spec mechanism is `notifications/progress` for telemetry, which the conductor already wires (lines 871–898 of `mcp-server.ts`).

### 2. Current progress notification wiring (line ~871, `mcp-server.ts`)

```ts
const progressToken = extra?._meta?.progressToken;
const wantProgress = progressToken !== undefined;
// ...
execStream.on('progress', (ev) => {
  forwardProgress(ev.data.percent, ev.data.message);
});
```

Progress forwarding exists and works — `mcp.progress(percent, message)` in sandbox scripts routes through `__streamEvent('/progress', ...)` → bridge → `ExecutionStream.progress()` → `sendNotification` with `notifications/progress`.  However:
- The `message` payload is a freeform string, not a partial result object.
- The client (Claude) receives progress as metadata, not as callable/referenceable partial data.
- No known MCP client currently renders partial-data progress into the conversation turn.

### 3. The `execute_code` execution path is fully atomic

In `src/runtime/executor.ts`, the Deno sandbox gathers all output into `stdoutChunks`, waits for process close, parses `__RESULT_START__` / `__RESULT_END__`, then returns a single `ExecutionResult`.  The parent (`finaliseExecuteCodeResult`) then applies `trimResultToBudget`.  There is no point in this pipeline where partial results can escape early.

The `maxOutputBytes` cap (default 10 MB, `SandboxConfig.maxOutputBytes`) silently truncates stdout at the byte level — it does not help the model because it truncates mid-JSON, producing an unparseable result.

### 4. Passthrough tools dump the full backend response

`src/server/passthrough-registrar.ts` lines 285–316: `callTool` → `JSON.stringify(result)` → content `text` field.  No size guard, no pagination, no summary.  A passthrough call to `ibkr.get_option_chain` could return 500 KB of JSON that lands verbatim in the model context.

### 5. `trimResultToBudget` is a last-resort blunt instrument

The current guard in `finaliseExecuteCodeResult` (lines 343–358) binary-searches for the largest array prefix fitting within `maxTokens`.  It:
- Silently discards the tail of the array.
- Does not attach a continuation token so the caller can fetch the next page.
- Applies only to `execute_code`, not to passthrough tools.
- Does not know which fields of a record are high-value vs. noise.

### 6. Sandbox scripts cannot yield incrementally

The sandbox runtime in `generateSandboxCode` runs `__execute()` and emits `__RESULT_START__` in one pass.  There is no `yield` / generator machinery.  `mcp.progress()` sends telemetry bytes to the bridge, but those bytes never become tool-result content.

### 7. No per-server or per-tool default limit injection

`ConductorServerConfig` has `rateLimit` and `routing`, but no `default_limit` or `max_rows` field.  Nothing injects a `limit:` param into a backend call before dispatch.  The user must know to add `limit` in their sandbox code, or accept whatever the backend returns.

---

## Options

### Option A — Pre-cap with continuation token (highest impact, in-protocol)

Add a `paginate` helper in the conductor layer that:
1. Calls the backend tool.
2. If the result exceeds a configurable byte / token threshold, stores the excess in a short-lived KV slot (the conductor already has `shared-kv.ts`).
3. Returns a trimmed first page plus a `_conductor_continuation` token.
4. Exposes a new meta-tool `fetch_continuation(token)` that returns the next page.

This is fully within MCP (no spec changes needed).  The caller — either the sandbox script or the model via passthrough — fetches further pages explicitly.

Sketch:

```ts
// In sandbox:
const page1 = await mcp.paginate(
  mcp.server('ibkr').call('run_market_scanner', { ...params }),
  { pageSize: 50, maxPages: 5 }
);
// page1.data  — first 50 items
// page1.token — opaque continuation token, or undefined if all data fit

// fetch more:
if (page1.token) {
  const page2 = await mcp.fetchPage(page1.token);
}
```

On the server side:
```ts
// New meta-tool:
this.server.registerTool('fetch_continuation', { ... }, async ({ token }) => {
  const page = sharedKv.get(`page:${token}`);
  if (!page) throw new Error('Page expired or not found');
  return { content: [{ type: 'text', text: JSON.stringify(page) }] };
});
```

**Pros**: No protocol violation. Works with passthrough and execute_code paths. Keeps context window small.  
**Cons**: Requires sandbox script awareness (or automatic wrapping). KV slot adds state. Pages expire.

---

### Option B — Stream-summarised chunks via `notifications/progress` message field

Use the existing `mcp.progress(percent, message)` mechanism to emit JSON-serialised summary chunks mid-execution.  The final result becomes a lightweight completion signal; the data was already delivered in progress messages.

```ts
// In sandbox:
const items = await mcp.server('ibkr').call('run_market_scanner', params);
const chunks = chunkArray(items, 20);
for (let i = 0; i < chunks.length; i++) {
  await mcp.progress(
    Math.round((i + 1) / chunks.length * 90),
    JSON.stringify({ chunk: i, data: chunks[i] })
  );
}
return { summary: `${items.length} contracts delivered in progress events` };
```

**Pros**: Zero new infrastructure — wiring is already live. Works today with any client that surfaces progress messages.  
**Cons**: Claude Code currently does not surface `notifications/progress` message content into the conversation turn as usable data. This is a client-side limitation, not a conductor limitation. Until clients treat progress-message JSON as structured partial results, this is display-only.

---

### Option C — Protocol-layer response size ceiling with automatic `next_page` param injection

In `handleToolCall` (bridge's `http-server.ts`), after the backend returns:
1. If `result.length > CEILING_BYTES` (configurable, e.g. 200 KB), store tail in the per-execution KV under a generated page token.
2. Return a wrapped result: `{ data: head, next_page_token: "<token>", total_items: N, page: 1 }`.
3. A new bridge endpoint `/page?token=<token>` returns the next slice, accessible via `mcp.server('_conductor').call('fetch_page', { token })` from the sandbox.

This is transparent to sandbox code that doesn't opt in, but provides a mechanism for scripts that do.

**Pros**: Works at the protocol layer without changing sandbox code.  
**Cons**: Automatically wrapping backend responses changes their schema unexpectedly. Scripts that assert `result[0].symbol` will break on the wrapped format without an opt-in flag.

---

### Option D — Per-server `default_limit` injection in conductor config

Extend `ConductorServerConfig` with:
```ts
default_params?: Record<string, Record<string, unknown>>;
// e.g.
// "ibkr": { "default_params": { "run_market_scanner": { "limit": 50 } } }
```

Before `hub.callTool(server, tool, params)`, merge `default_params[tool]` under the actual params (caller params win on conflict).  This injects `limit:50` automatically when a tool is called without an explicit limit.

**Pros**: Entirely transparent. Reduces backend payload before it ever reaches the conductor's memory or the model's context. Works for both passthrough and execute_code paths. No new endpoints needed.  
**Cons**: Requires per-tool knowledge of which param is the limit key. Misconfigured for tools that don't accept the injected param — would need a graceful fallback.

---

### Option E — Automatic array-slice + continuation token in `trimResultToBudget`

Extend the existing `trimResultToBudget` function to write the trimmed tail to the shared KV and return a `_continuation` field in `result_trimmed.meta`:

```ts
// Current:
meta: { to_tokens: maxTokens, original_length: value.length, trimmed_to: lo }

// Proposed:
meta: {
  to_tokens: maxTokens,
  original_length: value.length,
  trimmed_to: lo,
  continuation_token: "<token>",   // ← new
  expires_at: "<iso>"
}
```

The model can then call `fetch_continuation(token)` to get the next slice.

**Pros**: Minimal change to existing code. Reuses the already-proven binary-search logic. Works for execute_code results automatically at the token budget boundary.  
**Cons**: Only covers `execute_code` (passthrough tools bypass `finaliseExecuteCodeResult`). Requires the shared KV to store potentially large blobs.

---

## Impact

| Scenario | Current token cost | With Option A+D |
|---|---|---|
| `ibkr.run_market_scanner` → 300 contracts, ~150 KB | ~39 000 tokens (full pass) or ~2 000 tokens trimmed with data loss | ~2 000 tokens page 1 (50 items) + explicit fetch for more |
| `afr.latest` → 50 articles, ~80 KB | ~21 000 tokens | ~2 000 tokens summary + continuation |
| `tv` scanner, 89 tools × large result | Unbounded | Capped at protocol layer before it reaches the model |
| Wall time for 10 MB result | 2 582 ms end-to-end (baseline) | ~50 ms for first page (first 50 items serialise in < 1 ms) |

The 10 MB large-payload benchmark result (2 582 ms) is almost entirely serialization overhead from materializing the full result. Pagination at 50 items would collapse that to near zero.

---

## Recommended Path

**Phase 1 (1–2 days): Option D — per-server `default_params` in conductor config**

This is the lowest-effort highest-leverage change. Add `default_params` to `ConductorServerConfig` in `src/config/schema.ts`, wire it in the bridge's `callTool` handler before `hub.callTool(...)`, and document the pattern. No new endpoints, no KV state, transparent to all callers. Directly addresses the "backend returns 300 items nobody asked for" root cause.

**Phase 2 (2–3 days): Option E — continuation token in `trimResultToBudget`**

Extend `trimResultToBudget` to store the trimmed tail and return a `continuation_token` in the `result_trimmed` metadata block. Add a `fetch_continuation(token)` meta-tool. Wire the KV with a 5-minute TTL (matches existing `STREAM_STALE_TTL_MS` pattern). This makes data loss on trimming transparent and recoverable.

**Phase 3 (deferred): Option C at the bridge layer**

A configurable `response_size_ceiling_bytes` in `ConductorServerConfig` that auto-wraps large results before they reach the model. Needs careful opt-in design to avoid breaking schema expectations. Best addressed once Phase 1+2 prove the pagination UX.

**Do not pursue Option B (progress-message streaming) until a client renders progress-message JSON as structured data** — it is a dead-end in the current Claude Code client.

---

## Summary

| # | File | Byte count | Headline |
|---|---|---|---|
| `src/config/schema.ts` | 202 lines / ~5 KB | Add `default_params` field to `ConductorServerConfig` |
| `src/bridge/http-server.ts` | 763 lines / ~28 KB | Merge `default_params` before `hub.callTool` in `handleToolCall` |
| `src/server/mcp-server.ts` | 2 992 lines / ~115 KB | Extend `trimResultToBudget` to emit continuation token; add `fetch_continuation` meta-tool |
| `src/streaming/execution-stream.ts` | 449 lines / ~15 KB | No changes required — existing `progress` event bus already wired |

**Headline**: The MCP protocol does not support mid-call streaming. The right fix is (a) prevent oversized results entering the pipeline by injecting `default_limit` params at the conductor config layer, and (b) make the existing `trimResultToBudget` lossless by stashing the trimmed tail with a continuation token. Combined, these eliminate the token-overspend and data-loss problems without protocol changes or client support requirements.
