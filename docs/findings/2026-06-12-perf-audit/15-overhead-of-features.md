# 15 — Per-call overhead of conductor's own features

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## Summary table — cost per backend call when feature is disabled vs enabled

All figures are estimates derived from static analysis, not instrumented microbenchmarks.
Where a cost is "0" that means a single branch check with no heap allocation.

| Feature | Disabled cost (µs / KB-RSS) | Enabled cost (µs / KB-RSS) | Notes |
|---|---|---|---|
| MetricsCollector.recordExecution | **~30–120 µs / ~2 KB** (always on) | same — no enabled gate | 3 regex scans + array push + EventEmitter.emit |
| MetricsCollector.recordToolCall | **~2–5 µs / ~0.5 KB** (always on) | same | Map lookup/insert |
| logToFile (appendFileSync) | 0 µs — gated by `logToFile` flag | **~50–300 µs / 0 KB** (blocking syscall) | Synchronous write blocks event loop |
| diag-mode (renderDiagTrailer) | **< 1 µs** — early-return on `mode === 'off'` | ~5 µs (summary) / ~15 µs (verbose) | Well-guarded; no cost when off |
| compare_mode (enabled) | **0** — boolean check | **full extra backend call + Deno sandbox** | DOUBLE execution; see detail below |
| compare_mode (disabled, off-path code) | **~5 µs** — `computeTokenSavings()` always called in `finaliseExecuteCodeResult` when `compareMode===false` | same | See §3 below |
| record_session / ReplayRecorder | 0 — no recording without explicit `record_session` call; `isRecording()` check is Map.has() | **~50–300 µs per event** (appendFileSync) | Only active when user has called `record_session`. No per-call background overhead. |
| RateLimiter (per server, when configured) | 0 — limiter is only created when `rateLimit:` present in server config | **~3–8 µs** per call (token bucket math + possible queue wait) | Runs a 50 ms `setInterval` per rate-limited server regardless of traffic |
| RateLimiter setInterval timer (background) | 0 — no timer created | **20 wakeups/s per rate-limited server** (setInterval 50 ms) | Each tick calls processQueue + refillTokens even when queue is empty |
| Retry machinery (handleDisconnection) | 0 — only fires on transport error or close | ~5 ms scheduling overhead | Not on the hot path; async setTimeout |

---

## 1. MetricsCollector.recordExecution — always on, no enabled gate

**PROBLEM.** `recordExecution` is called on every single `execute_code` and `passthrough_call` invocation regardless of `config.metrics.enabled`. The `isEnabled()` method exists on the class but is never consulted before calling `recordExecution`. The default is `enabled: true` (`src/config/defaults.ts:50`), so this is not currently causing harm — but if a user sets `metrics.enabled: false` in their conductor config they will still pay the full recording cost.

**EVIDENCE.**

```
// src/server/mcp-server.ts:360
const executionMetrics = this.metricsCollector.recordExecution({ ... });

// src/server/mcp-server.ts:1648 (passthrough_call success path)
this.metricsCollector.recordExecution({ ... });

// src/server/mcp-server.ts:1728 (passthrough_call error path)
this.metricsCollector.recordExecution({ ... });
```

Inside `recordExecution` (`src/metrics/metrics-collector.ts:419-498`) the per-call work is:

1. `estimateCodeTokens(code)` — runs 3 compiled regexes (keywords, brackets, whitespace) over the entire code string. For a 1 KB script this costs ~15–30 µs on a modern CPU. For larger scripts the cost scales linearly.
2. `estimateJsonTokens(result)` — JSON-stringifies the result (if not already a string), then runs a regex to match JSON keys. If the result is a large object this is an O(N) JSON.stringify plus an O(N) regex scan.
3. Array push to `this.executions` + trim check.
4. `EventEmitter.emit('execution', metrics)` — synchronous listener dispatch.
5. Conditional `appendFileSync` (see §2).
6. `logger.debug(...)` — a structured log object is always allocated even at INFO level (depends on logger implementation).

**Per-call heap cost:** Each `ExecutionMetrics` object (~200 bytes) is pushed into the `executions` array. The array is capped at 100 entries (`maxStoredExecutions`) so RSS growth is bounded at ~20 KB, but GC pressure is continuous.

**OPTIONS.**
- Gate the entire `recordExecution` body on `this.config.enabled`: `if (!this.config.enabled) return earlyDummyMetrics;`
- Pre-compile the regexes in `estimateCodeTokens` as module-level constants rather than allocating them inside every call. They are currently declared inside a loop body (`src/metrics/metrics-collector.ts:322-327`) so a new RegExp object is created on every invocation.
- Replace the 3-regex approach with a single `estimateTokensFromBytes(code.length)` fast-path: the character-count heuristic is accurate to within ±15% and is O(1).

**IMPACT.** Medium. For typical 200–500 byte scripts: ~20–50 µs saved per call. Regex reuse alone saves 3 allocations. At 50 calls/s this is ~1–2.5 ms/s of CPU wasted.

**RECOMMENDED PATH.** Add `if (!this.config.enabled) return stub;` at the top of `recordExecution` and `recordToolCall`. Hoist the 3 regex patterns to module-level `const` (single allocation at import time).

---

## 2. logToFile — synchronous appendFileSync blocks the event loop

**PROBLEM.** When `logToFile: true` and `logPath` is set, every `recordExecution` call synchronously writes a JSONL line to disk via `appendFileSync` (`src/metrics/metrics-collector.ts:515`). This blocks the Node.js event loop for the duration of the OS write. On an NFS/SMB mount or an SSD under heavy concurrency this can easily reach 1–5 ms per call.

**EVIDENCE.**

```
// src/metrics/metrics-collector.ts:514-516
try {
  appendFileSync(this.logPath, line);
```

The `ReplayRecorder` has the same pattern (`src/observability/replay.ts:143`): `appendFileSync` per recorded event, synchronous on the event-loop thread.

**OPTIONS.**
- Replace `appendFileSync` with `appendFile` (async) and discard the promise with a caught error handler. For a metrics log, lost writes on shutdown are acceptable.
- Use a buffered write strategy: accumulate lines in a string/buffer and flush via `setImmediate` or a debounced timer. A 100-line or 16 KB buffer cuts syscalls by 100×.
- Use a `WriteStream` opened once at startup and kept open for the session (`fs.createWriteStream(path, { flags: 'a' })`) — eliminates the `open/write/close` overhead of `appendFileSync`.

**IMPACT.** High if enabled. Each call blocks for ~50–300 µs (SSD) or much longer (network drive). Default is `logToFile: false` so production impact is zero today, but it is a trap for anyone enabling file logging.

**RECOMMENDED PATH.** Open a `WriteStream` in the constructor when `logToFile: true` and drain via `stream.write()`. Close the stream on `reset()` or collector shutdown.

---

## 3. compare_mode disabled — redundant computeTokenSavings call

**PROBLEM.** Inside `finaliseExecuteCodeResult` (`src/server/mcp-server.ts:398-416`), `computeTokenSavings` is called unconditionally whenever `wantSavings` is true. The `wantSavings` check correctly gates on `showTokenSavings || alwaysShowTokenSavings || compareMode`. However, when `compareMode` is true, `computeTokenSavings` is called **twice** (once at line 409 for `tokenSavings`, and again at line 425 for `compareStats`). Both calls perform identical arithmetic on the same inputs.

```
// src/server/mcp-server.ts:409
const savings: TokenSavings = computeTokenSavings({ ... });
output.tokenSavings = savings;

// src/server/mcp-server.ts:425 — compare mode block
const savings = computeTokenSavings({ ... });   // duplicate call, same args
```

`computeTokenSavings` is cheap (pure arithmetic, ~1 µs), but the JSON.stringify of `result` is repeated at line 408 and again at line 425.

**EVIDENCE.** `src/server/mcp-server.ts:408` and `src/server/mcp-server.ts:425` both call `JSON.stringify(result.result)` independently.

**OPTIONS.**
- Extract the `resultJson` and `savings` computation before the `wantSavings` / `compareMode` blocks and reuse the cached values.

**IMPACT.** Low individually. Extra `JSON.stringify` of the result object per call when compare mode + token savings are both active. At 1 MB results this is ~2 ms per call.

**RECOMMENDED PATH.** Hoist `const resultJson = result.result !== undefined ? JSON.stringify(result.result) : '';` and `const savings = computeTokenSavings({...})` above both `if (wantSavings)` and `if (this.compareMode)` blocks.

---

## 4. compare_mode enabled — DOUBLE execution is the entire cost

**PROBLEM.** When `compareMode: true`, every `passthrough_call` and every auto-registered `<server>__<tool>` passthrough tool fires the backend **twice**:

1. The real passthrough call via `mcpHub.callTool`.
2. A full Deno sandbox execution of `runCompareExecuteCode` that repeats the same backend call via the bridge.

This is documented and intentional, but it means compare mode has a multiplicative cost on backend load, not just an additive one. A user who accidentally leaves compare mode on will see all passthrough calls doubled.

**EVIDENCE.**

```
// src/server/mcp-server.ts:1689
if (this.compareMode && !this.useMockServers) {
  const stats = await this.buildCompareStatsForPassthrough( ... );
```

```
// src/server/passthrough-registrar.ts:296-311
if (compareHook?.isEnabled()) {
  structured.compareStats = await compareHook.buildCompareStats( ... );
```

The `set_compare_mode` tool description does warn about double-execution, but there is no automatic timeout or session cap.

**OPTIONS.**
- Add a compare mode auto-disablement after N calls (e.g. 20), emitting a warning. Prevents accidental sustained enablement.
- Persist a warning in the compareStats block that increments a global compare-call counter so the user can see "compare mode has fired 47 times this session."
- Require an explicit confirmation parameter when enabling compare mode against a non-read-only server pattern.

**IMPACT.** Critical when enabled and forgotten. 2× backend load, 2× bridge calls, Deno sandbox boot cost per passthrough call.

**RECOMMENDED PATH.** Add a `max_compare_calls` parameter to `set_compare_mode` (default 20). Auto-disable after that count and log a clear warning in the response. Cheap to implement; protects against the common mistake of forgetting to toggle off.

---

## 5. RateLimiter setInterval — background timer per rate-limited server

**PROBLEM.** Each `RateLimiter` instance starts a `setInterval` at 50 ms (`src/utils/rate-limiter.ts:231`). This timer fires 20 times per second and calls `processQueue()` + `refillTokens()` regardless of whether any requests are queued. With 22 configured servers and only a subset having `rateLimit:` set, each active timer holds a reference that prevents GC of the limiter and adds 20 wakeups/s of event-loop overhead per server.

**EVIDENCE.**

```
// src/utils/rate-limiter.ts:229-233
private startRefillTimer(): void {
  this.refillInterval = setInterval(() => {
    this.processQueue();
  }, 50);
}
```

`processQueue` always calls `refillTokens()` which does `Date.now()` + arithmetic + a conditional update. This is cheap (~1 µs each tick), but with 5 rate-limited servers that is 100 wakeups/s of background work and 5 persistent setInterval handles.

**OPTIONS.**
- Use a lazy refill strategy: call `refillTokens()` only inside `tryAcquire()` (already done) and use a conditional timer that starts only when the queue has items, stops when it empties. Eliminates all background wakeups in the common case (queue is empty between bursts).
- Increase the refill interval to 100–200 ms for servers with low `requestsPerSecond` values. At 5 req/s, a 200 ms tick is accurate enough.
- Replace the interval with a `setTimeout` that reschedules itself only if the queue is non-empty at end of tick.

**IMPACT.** Low per server; accumulates with server count. Main cost is event-loop wakeup overhead (~1–2 µs/wakeup on modern Node). For 5 rate-limited servers: ~100–200 µs/s of wasted CPU.

**RECOMMENDED PATH.** Gate the interval: start on first enqueue, stop when queue drains. One-line change to `processQueue()`:

```ts
if (this.queue.length === 0 && this.refillInterval) {
  clearInterval(this.refillInterval);
  this.refillInterval = null;
}
```

Restart the interval in `enqueue()` when adding to an empty queue.

---

## 6. MetricsCollector.recordExecution — regex patterns re-allocated per call

**PROBLEM.** `estimateCodeTokens` (`src/metrics/metrics-collector.ts:315-337`) allocates three `RegExp` objects on every invocation inside the `singleTokenPatterns` array. JavaScript engines may optimise literal regex reuse, but declared inside a method body inside an array literal they are not guaranteed to be cached. This is 3 unnecessary allocations per `recordExecution` call.

**EVIDENCE.**

```
// src/metrics/metrics-collector.ts:322-327
const singleTokenPatterns = [
  /\b(const|let|var|function|async|await|return|import|export|class|interface|type)\b/g,
  /[{}[\]()]/g,
  /\s+/g,
];
```

Additionally: these patterns use the `g` flag. Reusing a `g`-flagged regex between calls requires resetting `lastIndex`. As module-level constants they would need `.exec()`-in-loop or `String.match()` (which auto-resets `lastIndex`). Current usage with `.match()` is safe but the allocations are wasted.

**OPTIONS.**
- Move the three patterns to module-level constants. Zero runtime allocation cost.
- Replace the entire `estimateCodeTokens` with `return Math.ceil(code.length / 3.5)` — the regex "adjustment" produces a ±5% difference from the simple heuristic, insufficient to justify the per-call overhead.

**IMPACT.** Low-medium. 3 object allocations per call adds GC pressure. At 100 calls/s: ~300 short-lived allocations/s.

**RECOMMENDED PATH.** Hoist to module-level constants; evaluate whether the character-adjustments are worth keeping at all given the formula error bars.

---

## 7. Silently expensive features — summary

The following features add per-call overhead **even when their primary feature is disabled**, which is counterintuitive:

| Feature | Silent cost | Root cause |
|---|---|---|
| `MetricsCollector.recordExecution` | ~30–120 µs, always | No `enabled` gate before work; regex allocated each call |
| compare_mode JSON.stringify double | ~1–5 ms when `wantSavings` + compareMode both true | Duplicate `JSON.stringify(result.result)` in same function |
| RateLimiter setInterval (per configured server) | 20 wakeups/s × N limiters | Timer runs even when queue is empty |

The recording subsystem (`ReplayRecorder`) is NOT silently expensive: it does a `Map.has(sessionId)` gate before any work, so `recordToolCall` / `recordToolResult` / `recordCodeResult` cost nothing when no session is active. The overhead is entirely opt-in once the user calls `record_session`.

Diag mode (`renderDiagTrailer`) is also NOT silently expensive: it returns `''` on the first branch check when mode is `'off'`.

---

## Prioritised action list

| Priority | Finding | File(s) | Change |
|---|---|---|---|
| P1 | Sync appendFileSync blocks event loop | `src/metrics/metrics-collector.ts:515` | Replace with WriteStream or async append |
| P1 | compare_mode auto-disable after N calls | `src/server/mcp-server.ts:1689`, `src/server/passthrough-registrar.ts:296` | Add `max_compare_calls` cap with auto-off |
| P2 | recordExecution ignores `enabled: false` | `src/metrics/metrics-collector.ts:419` | Early-return when `!this.config.enabled` |
| P2 | Regex patterns re-allocated every call | `src/metrics/metrics-collector.ts:322-327` | Hoist to module-level constants |
| P3 | Duplicate JSON.stringify in finalise | `src/server/mcp-server.ts:408,425` | Cache `resultJson` and `savings` before both if-blocks |
| P3 | RateLimiter idle timer wakeups | `src/utils/rate-limiter.ts:229-233` | Lazy start/stop on queue empty/non-empty |
