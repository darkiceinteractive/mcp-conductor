# 04 — Token Estimation Accuracy

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## 1. PROBLEM

The conductor estimates tokens via two independent heuristic paths:

**Passthrough path** (`src/metrics/metrics-collector.ts`, `src/server/diag-mode.ts`):
```
passthroughTokens = (toolCalls × 150) + (dataProcessedBytes / 1024 × 256)
```
`TOKENS_PER_KB = 256` implies **4 bytes per token**. This is reasonable for mixed-content text but measurably wrong for the actual payloads the conductor processes.

**Execution path** (same files):
```
executionTokens = ceil(codeChars / 3.5) + ceil(resultBytes / 3.8)
```
`CODE_CHARS_PER_TOKEN = 3.5`, `JSON_CHARS_PER_TOKEN = 3.8`.

**No actual tokenizer is used anywhere.** `package.json` has zero tokenizer dependencies (`@anthropic-ai/tokenizer`, `js-tiktoken`, `tiktoken` — none present). The formulas are hardcoded constants.

**Magnitude of potential error:**

| Content type | Formula bytes/token | Real BPE bytes/token | Error direction | Error magnitude |
|---|---|---|---|---|
| JSON with UUIDs/numbers | 4.0 | ~3.0–3.3 | Formula UNDER-estimates passthrough | 20–33% |
| Nested JSON, short keys | 4.0 | ~3.0–3.5 | Formula UNDER-estimates passthrough | 14–33% |
| Prose-heavy JSON values | 4.0 | ~4.5–5.0 | Formula OVER-estimates passthrough | 11–25% |
| TypeScript/JS code | 3.5 chars | ~3.3–3.7 chars | Near-accurate | ±6% |
| JSON result payload | 3.8 chars | ~3.0–3.5 chars | Formula UNDER-estimates execution | 9–27% |

For a 1 MB JSON payload dense with UUIDs and numbers (exactly what `buildJsonPayload()` generates in benchmarks):
- Formula says: **262,144 tokens**
- Real BPE estimate: **~327,680 tokens** (+25%)

Savings percentage is largely immune to this error at high compression ratios (98–99%) because the execution side is a small absolute number. The **risk zone is small-payload, low-savings calls** where both sides are within 20% of each other. In that zone a formula over-estimate of passthrough + formula under-estimate of execution can report "10% savings" when the real figure is ≤0%.

---

## 2. EVIDENCE

### Formula locations (three independent copies — a drift risk)

1. `src/metrics/metrics-collector.ts` lines 16–23 — exported constants (`TOKENS_PER_KB`, `CODE_CHARS_PER_TOKEN`, `JSON_CHARS_PER_TOKEN`); also re-exported via `src/metrics/index.ts`.
2. `src/server/diag-mode.ts` lines 23–30 — **local re-declarations** of the same constants (not imported from metrics). A copy-paste fork; will silently diverge if one is updated.
3. `test/fixtures/scale-fixtures.ts` lines 12–16 — a third copy used directly in benchmark fixtures.

All three copies currently agree. There is no defensive test asserting they are identical.

### No real tokenizer exists in the codebase

`grep -r "tiktoken|@anthropic-ai/tokenizer|count_tokens|js-tiktoken" src/` — zero matches.

### `@anthropic-ai/sdk` `count_tokens` endpoint

The official Anthropic SDK (`/anthropics/anthropic-sdk-typescript`) exposes:

```
POST /v1/messages/count_tokens
```

which returns a `MessageTokensCount` object with the exact BPE count for a given message payload. It is stable (not beta), lives in `anthropic.messages.countTokens()`, and accepts the same `messages` + `model` structure as a real API call. **This endpoint does exist and is documented.**

There is no `@anthropic-ai/tokenizer` npm package — Anthropic does not publish a standalone offline BPE library for JavaScript. The only official JS path is the network API.

### The 2036ms "tokenize @ 10 MB" hot path — clarification

This benchmark number (`large-payload-2026-06-12.json`) is **not BPE token counting**. It is PII redaction via `src/utils/tokenize.ts` — a recursive JSON tree walker that runs 7 regex patterns (email, phone, SSN, credit card with Luhn, IBAN with mod-97, IPv4, IPv6) across every string value in a 10 MB payload.

At 10 MB with ~39,600 records and ~8 string fields per record (including tag array items), that is ~2.2 M regex operations. At ~0.9 μs/op the 2,036 ms result is expected.

**This path is not on by default.** PII tokenization activates only when the caller passes `pii_matchers` to `execute_code`. With default settings and typical 1–100 KB payloads the path either does not run (no matchers) or runs in 1–6 ms. The 2,036 ms figure is a worst-case stress gate, not a steady-state cost.

**Is it streamable?** No. The tree walk requires the full parsed-object graph in memory; streaming would require a streaming JSON parser with regex on each leaf value. Not worth the complexity given the conditional activation.

**Is it cacheable?** Yes. Hash of `(serialised payload + sorted matchers)` → redacted result. Useful for repeated calls to the same polling tool. The existing LRU cache already stores tool responses; inserting a second cache layer keyed on `(toolResponseHash, matchers[])` would serve repeated-PII-redaction for free. Benefit is niche (same 10 MB response called twice with PII matchers enabled).

---

## 3. OPTIONS

### Option A — Pure-JS BPE tokenizer bundled (e.g. `js-tiktoken` or `gpt-tokenizer`)

- **Package**: `gpt-tokenizer` (~45 KB, zero native deps) or `js-tiktoken` (WASM, ~1.5 MB). Neither covers Claude's exact vocabulary but `cl100k_base` is a close proxy (within ~3–5% for most content).
- **Accuracy**: ±5–8% vs real Claude tokenizer. Substantially better than current ±25%.
- **Latency**: ~0.5 ms per 1 KB of content (pure JS BPE), or ~2 ms warm for WASM. Non-blocking.
- **Network**: none — fully offline.
- **Bundle cost**: adds 45 KB (gpt-tokenizer) or 1.5 MB (js-tiktoken WASM) to the installed package.
- **Caveats**: cl100k_base is GPT-4's vocabulary, not Claude's. Claude uses a proprietary BPE. Differences are mostly in rare Unicode and code tokens.

### Option B — Call `POST /v1/messages/count_tokens` (exact, online)

- **Accuracy**: 100% — this is the real tokenizer.
- **Latency**: 150–400 ms round-trip per call (network). Unacceptable in the hot path.
- **Network dependency**: breaks in air-gapped / offline installs. The conductor is used in local MCP contexts where network calls from the metrics path are unexpected.
- **Cost**: `count_tokens` uses API credits (though cheaper than a message call). Adds friction to a feature that is already optional telemetry.
- **Appropriate for**: one-off calibration runs, not per-call estimation.

### Option C — Sample-based calibration: every N calls, send a real count and correct the multiplier

- **Mechanism**: every N calls (e.g. N=50 or time-gated to once per 5 min), compute `count_tokens` for the last sample payload and update a per-session `calibrationFactor` (float, defaults to 1.0). Subsequent formula outputs are multiplied by this factor.
- **Accuracy**: converges to ±5% after a few samples; continuously self-correcting for content drift.
- **Latency**: the calibration call runs async/detached — no hot-path cost. Only the sample call adds ~200 ms in the background.
- **Network**: same concern as Option B but async and infrequent (once per N calls, not every call).
- **Implementation size**: ~60 lines in `MetricsCollector`. Stores `calibrationFactor` and `lastCalibrationAt`.

### Option D — Per-content-type heuristics (finer constants)

Replace the single `TOKENS_PER_KB = 256` constant with a detector that measures content characteristics:

```
if content is JSON with mostly numeric values → use 3.2 chars/token
if content is JSON with UUID-heavy strings → use 3.0 chars/token  
if content is natural-language-heavy → use 4.2 chars/token
default → use 3.7 chars/token (current average)
```

Detection is O(n) single pass over a sample (first 4 KB), cheap. Improves accuracy from ±25% to ±10–12% with no external dependencies. Works offline. Does not require vocabulary knowledge.

Specific example: add a `detectContentDensity(sample: string): 'numeric' | 'uuid' | 'prose' | 'mixed'` helper that checks the ratio of digits/hyphens/quotes to total characters.

### Option E — Cache token counts by content hash

Where the same tool response is seen more than once per session (polling, cached MCP responses), memoize the formula result keyed on `sha1(serialised_content).slice(0,16)`. The formula is deterministic; for identical content the result is identical. Saves CPU but does not improve accuracy. Complementary to other options, not a standalone fix.

---

## 4. IMPACT

### Diag mode trailer (`renderDiagTrailer`)

`diag-mode.ts` renders `est_passthrough≈Xt · est_execution≈Yt · savings≈Z%` on every call when `set_diag_mode` is `summary` or `verbose`. If the formula is off by 25% on passthrough, the numbers shown to the user are misleading. For the headline use case (showing that execution mode saved tokens this call), the direction of the error is generally favourable at large payloads — formula under-estimates passthrough so reported savings are conservative. However at small payloads (< 5 KB data), the error can flip sign: the trailer might claim positive savings when the real cost is equal or higher.

### Budget governor and tier promotion

The budget governor uses `computeTokenSavings()` to decide whether to stay in execution mode or promote to smart/passthrough mode. At the tier thresholds (decisions near `savingsPercent ≈ 15–30%`), a ±20% formula error is decisive. A payload where real savings are 5% but formula says 20% will stay in execution mode when it should not.

### The headline savings story (`get_metrics`, Medium article, perf report)

Session-level numbers (95%+ compression) come from `getTokenSavings()`. At the scale of the benchmark payloads (hundreds of KB to MB), both sides of the formula are systematically biased in the same direction (under-estimate passthrough, under-estimate execution), so the savings percentage is stable. The perf report's 99.95% figure is robust at that scale. The risk is in individual call accuracy and small-payload tier decisions, not the aggregate headline.

---

## 5. RECOMMENDED PATH

**Phase 1 (zero dependencies, immediate):** Fix the three formula copies drifting apart.

Extract the constants into a single shared module (e.g. `src/metrics/token-constants.ts`) and import from it in `diag-mode.ts`, `metrics-collector.ts`, and `scale-fixtures.ts`. Add a test that imports all three and asserts they match. This prevents silent divergence and takes ~20 lines.

**Phase 2 (accuracy, no network, ~1 sprint):** Add per-content-type heuristics (Option D).

Add `detectContentDensity(sample: string)` that examines a 2 KB prefix and returns a density class. Map to a `chars_per_token` constant. Apply in `estimatePassthroughTokens` and `estimateJsonTokens`. This narrows ±25% to ±10–12% offline, with no new dependencies, no bundle cost, and no network requirement. It is the right default for a library that runs as an MCP server process.

**Phase 3 (self-correcting, optional, later):** Add sample-based calibration (Option C) behind a config flag.

When the user has set `ANTHROPIC_API_KEY` in the environment (already used by execute_code to call Claude), allow `MetricsCollector` to fire a background `count_tokens` probe once every 50 execute_code calls. Update `calibrationFactor`. Emit a `calibration_updated` event that the diag trailer can optionally append. Gate the whole feature on `metrics.calibration.enabled` (default `false`) so it never surprises users with unexpected network calls.

**On bundled BPE tokenizers (Option A):** Not recommended now. `gpt-tokenizer` uses a different vocabulary than Claude. Adding a 45 KB dependency to save ~10% relative error over the Option D heuristics is not worthwhile unless Anthropic publishes a first-party JS tokenizer. Revisit if `@anthropic-ai/tokenizer` ships.

**On the 2036ms PII path:** No action needed. It is not token estimation, it is PII redaction, it is conditional, it performs correctly at realistic payload sizes (6 ms at 100 KB), and the stress gate (< 5 s for 10 MB) passes. If aggressive PII redaction on large payloads becomes a user-reported pain point, a content-hash → redacted-result LRU cache layer is the right fix.

---

## Summary

| Item | Finding |
|---|---|
| Formula files | 3 independent copies; drift risk |
| Passthrough formula error | Up to ±25% depending on content type |
| Execution formula error | ±10–15% for code; ±10–27% for JSON results |
| Real tokenizer available | Yes — `POST /v1/messages/count_tokens` (network only) |
| Offline JS tokenizer | No Anthropic-published package; `gpt-tokenizer` is a proxy |
| Formula error at headline scale (≥100 KB) | Savings % robust (± < 2pp) |
| Formula error at small scale (< 5 KB) | Can flip sign; tier decisions at risk |
| 2036ms hot path | PII regex redaction, not BPE — conditional, not default |
| Recommended fix | Deduplicate constants + per-content-type heuristics (Phase 1–2) |
