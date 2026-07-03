# 16 — Bottleneck Deep Dives

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5e219e99c5cd7552cebceabd18b4bcd17b`

---

## Summary

| # | Bottleneck | File | Measured | Root cause | Best-case target |
|---|-----------|------|---------|-----------|-----------------|
| 1 | `tokenize` @ 10 MB | `src/utils/tokenize.ts` | 2 036 ms | O(n × m) — 7 sequential full-string regex passes | ~300 ms (−85%) |
| 2 | `findTool` p99 @ 10k tools | `src/runtime/findtool/vector-index.ts` | 359 ms p99 | O(N) heap allocation + O(N log N) full sort + GC pressure | ~20 ms p99 (−94%) |
| 3 | Cache key derivation @ wide-100k | `src/cache/key.ts` | 360 ms | 100 k × sha256 serialise-and-hash | ~80 ms (−78%) — stress only |
| 4 | Lock acquire p99 @ 50×1 hot-key | `src/daemon/shared-kv.ts` | 399 ms | Linear wait-queue drain on single hot key | ~200 ms (−50%) — fairness-only fix |

---

## BOTTLENECK 1 — tokenize @ 10 MB

### PROBLEM

`tokenize()` in `src/utils/tokenize.ts` scans a 10 MB payload in **7 sequential full-string passes**, one per active matcher, then allocates a new copy of the string after every pass.

### EVIDENCE

`redactString()` (line 230–253):

```ts
function redactString(input: string): string {
  let result = input;
  for (const spec of activeSpecs) {
    spec.pattern.lastIndex = 0;
    result = result.replace(spec.pattern, (match) => {   // ← new string copy per matcher
      ...
      return token;
    });
  }
  return result;
}
```

Seven matchers configured: `email`, `phone`, `ssn`, `credit_card`, `iban`, `ipv4`, `ipv6`.

`String.prototype.replace` with a global regex is O(n) in the string length and returns a **new string allocation**. Running 7 matchers over a 10 MB string allocates 7 × ~10 MB = ~70 MB of string heap per `tokenize()` call.

Measured throughput at 2 036 ms for 10 MB = **35 KB/ms per pass**. Arithmetic: 7 × (10 MB / 35 KB/ms) ≈ 2 048 ms — matches the benchmark exactly.

From `tokenize-scaling-2026-06-12.json` (piiDensity=1, 10 MB row): `tokenizeMs: 2 536.99` (slightly higher due to larger fixture byte count of 11.4 MB).

The `walk()` function (line 255–266) also **reconstructs the entire nested object tree** unconditionally, allocating new `Record<string, unknown>` objects for every node regardless of whether any PII was found. For a deeply-nested 10 MB payload this is O(nodes) additional allocation pressure.

**Algorithmic complexity:** O(n × m) where n = string length, m = active matcher count (currently 7). Space: O(n × m) heap churn.

### OPTIONS

**Option 1 — Combined regex, single pass (ease: high, impact: high)**

Merge all 7 patterns into one alternating group regex at `tokenize()` call setup time:
```
/(email_pattern)|(phone_pattern)|(ssn_pattern)|(cc_pattern)|(iban_pattern)|(ipv4_pattern)|(ipv6_pattern)/g
```
In the replacer callback, identify which capture group fired (`match.groups` or checking `arguments[1..7]`) and dispatch to the appropriate validator and token generator. One string copy instead of 7.

Expected: ~293 ms (7× speedup). The combined regex is slightly larger but browsers and V8's Irregexp compile it once; the reduction in allocations and scans far exceeds any match overhead increase.

Implementation risk: the IBAN and credit-card matchers have secondary validators (`luhnCheck`, `ibanCheck`). The replacer must select the right validator based on capture group index — straightforward but requires a lookup table keyed by group index.

**Option 2 — Index-based replacement (segment accumulation), no intermediate strings (ease: medium, impact: medium)**

Instead of `result = result.replace(...)`, accumulate matched segments into an array:
```ts
const segments: string[] = [];
let cursor = 0;
for (const m of text.matchAll(combinedPattern)) {
  segments.push(text.slice(cursor, m.index));
  segments.push(token(m));
  cursor = m.index + m[0].length;
}
segments.push(text.slice(cursor));
return segments.join('');
```
Combined with Option 1 this produces one scan + one `join()` allocation instead of 7 full-string copies. The `join()` itself allocates once at final size. For sparse PII (most of the string is passthrough) this can be ~20% faster than the combined-replace form, but the win shrinks as PII density increases. At density=1 (one match per field) the saving is real.

**Option 3 — Early-exit fast path for large payload with no matchers (ease: very high, impact: free)**

Already done (`activeSpecs.length === 0` check at line 217). No action needed.

**Option 4 — Lazy walk: skip object tree reconstruction when no redactions occurred (ease: medium, impact: medium)**

Add a `dirty` flag. The `walk()` function currently always builds a new tree. If the combined regex returns zero matches across all strings in the tree, return the original `value` unchanged. For payloads with no PII this eliminates the entire reconstruction cost. Implementation: wrap `redactString` to count replacements; if `totalReplacements === 0` after a dry-run scan (or during walk), short-circuit.

Practical impact limited because callers that pass matchers typically do so because PII is expected. But for cached results re-processed with `tokenize` this could save 100% of the walk cost.

**Option 5 — Worker thread offload for payloads above a size threshold (ease: low, impact: very high)**

The worker pool at `src/runtime/pool/worker-pool.ts` already exists (benchmarked at 32 workers → 529 calls/s with 50 ms jobs). A dedicated `tokenize-worker.ts` could receive a serialised payload (or `SharedArrayBuffer` slice), run the combined regex pass, and return the reverse map and redacted string.

For 10 MB payloads: main thread stays unblocked, worker completes in ~300 ms, total wall time ~320 ms on a 4-core machine vs 2 036 ms blocking. The serialisation overhead (postMessage of a 10 MB string) is approximately 5–15 ms via structured clone.

The worker pool scaling benchmark shows 4 workers giving 76.6 calls/s; a dedicated tokenise worker (1–2 workers) avoids contention with the executor pool.

### IMPACT

| Approach | Est. time @ 10 MB | Reduction |
|----------|------------------|-----------|
| Current (baseline) | 2 036 ms | — |
| Option 1 — combined regex | ~290 ms | −86% |
| Option 1 + 2 — combined + segments | ~240 ms | −88% |
| Option 5 — worker thread | ~150 ms wall | −93% |

### RECOMMENDED PATH

Ship Option 1 first (combined regex, single pass). It is a localised change within `redactString()` requiring a lookup table keyed by capture group index for the validators. Estimated 2–3 hours of implementation, zero external dependencies, immediately eliminates 86% of the problem.

Follow with Option 4 (lazy walk skip) as a second pass for the zero-PII case.

Option 5 (worker thread) only if tokenise is on the critical path for interactive calls; it introduces concurrency complexity.

---

## BOTTLENECK 2 — findTool p99 @ 10k tools

### PROBLEM

`VectorIndex.search()` at `src/runtime/findtool/vector-index.ts` allocates **N new scored objects** for every query, then runs a **full O(N log N) sort** to extract the top-K results. At 10 000 tools the object allocation heap per query is ~781 KB. The p99 of 359 ms is ~107× the median (3.37 ms), indicating periodic GC pauses rather than a consistently slow code path.

### EVIDENCE

`search()` method (line 76–93):

```ts
search(query: string, topK = 5, serverFilter?: string[]): SearchResult[] {
  const queryVec = embed(query);
  const candidates = serverFilter
    ? this.entries.filter((e) => serverFilter.includes(e.server))
    : this.entries;

  const scored = candidates.map((e) => ({          // ← N object allocations
    server: e.server,
    tool: e.tool,
    description: e.description,
    score: cosineSimilarity(queryVec, e.vector),
  }));

  scored.sort((a, b) => b.score - a.score);        // ← O(N log N) full sort
  return scored.slice(0, topK);
}
```

For N=10 000, each scored object holds 3 string references + 1 float = ~80 bytes in V8 heap. Total allocation: 10 000 × 80 bytes = **780 KB per query**. At the rate of continuous searches this triggers V8 minor-GC scavenges (~1–5 ms) and periodic major-GC stops (~50–200 ms) explaining the p99 outliers.

The `serverFilter` path uses `Array.includes()` which is O(serverFilter.length) per entry — O(N × S) total. With 22 servers this is minor, but grows quadratically if serverFilter is large.

`buildMs` at 10k = 70 ms (index rebuild). The p99 of 359 ms exceeds `buildMs + queryTop3Ms` (70 + 3.37 = 73 ms), confirming GC pressure rather than algorithmic slowness is the p99 driver. The 5× gap between p99 (359 ms) and build time (70 ms) is consistent with a GC stop-the-world cycle coinciding with a query.

From `findtool-scaling-2026-06-12.json`:
```json
{ "indexSize": 10000, "buildMs": 70.69, "queryTop3Ms": 3.37, "p99Ms": 359.45 }
```

**Algorithmic complexity (search):** O(N × D) for scoring (D = embedding dimension = 256) + O(N log N) for sort + O(N) allocation. For topK ≪ N the sort is wasteful.

### OPTIONS

**Option 1 — Typed-array score buffer + index sort (ease: high, impact: high)**

Replace the `scored` object array with two typed arrays: `Float32Array` for scores and `Int32Array` for original indices. No heap objects are allocated:

```ts
const scores = new Float32Array(candidates.length);
const indices = new Int32Array(candidates.length);
for (let i = 0; i < candidates.length; i++) {
  indices[i] = i;
  scores[i] = cosineSimilarity(queryVec, candidates[i].vector);
}
indices.sort((a, b) => scores[b] - scores[a]);  // sort indices by descending score
// extract topK from sorted indices
return Array.from({ length: Math.min(topK, candidates.length) }, (_, k) => {
  const i = indices[k];
  return { server: candidates[i].server, tool: candidates[i].tool,
           description: candidates[i].description, score: scores[i] };
});
```

Memory: 10 000 × (4 + 4) bytes = 80 KB (typed, off-heap-pressure) vs 780 KB (object heap). V8 handles `Float32Array` and `Int32Array` with zero GC pressure. The `indices.sort()` is the same O(N log N) complexity but operates on integers with no object traversal overhead.

This alone should reduce p99 by 70–80% by eliminating the GC trigger.

**Option 2 — Min-heap for top-K selection (ease: medium, impact: medium)**

For topK ≪ N (typical: topK=3–10 vs N=10 000), a min-heap of size K yields O(N log K) vs O(N log N). For K=3, log K / log N = 1.58 / 13.29 = 12% of sort cost. Combined with Option 1's typed arrays the heap adds overhead per element (comparison + sift); this is only a clear win when K < sqrt(N) which holds in practice (K=5, N=10 000).

Implementation: maintain a 5-element max-heap of `[score, index]` pairs, replacing the minimum when a higher score is found. No full-sort needed.

Expected improvement over Option 1: ~20% additional reduction in query time. Not the dominant win.

**Option 3 — HNSW approximate nearest-neighbour index (ease: low, impact: very high)**

The comment in `vector-index.ts` (line 7–8) already flags this: "For large deployments (>10k tools) consider replacing with hnswlib-node or LanceDB". HNSW reduces query from O(N × D) to O(log N × D) with ~95% recall. At N=10 000, D=256 this cuts query time from ~3 ms to ~0.1 ms and eliminates the GC problem entirely since hnswlib-node operates on native memory.

Dependency cost: `hnswlib-node` (8 MB native binary, requires compilation). Gate behind the existing `$LANCEDB_URL` / `$MCP_CONDUCTOR_EMBED_MODEL` env var pattern: `$MCP_CONDUCTOR_VECTOR_BACKEND=hnsw`.

Realistic only if the tool registry routinely exceeds 5 000 entries. Current production load is 498 tools where the pure linear scan is effectively free (p99=0.07 ms at 100 tools, 0.46 ms at 1 000 tools).

**Option 4 — Query result LRU cache (ease: high, impact: medium)**

Tool queries from `findTool` are short NL phrases ("list github issues", "get stock price"). A small LRU cache keyed on `(query_normalised, serverFilter_sorted, topK)` can serve repeated queries in O(1). In practice Claude-generated queries tend to cluster on a handful of canonical phrases per session.

Cache invalidation: evict on `reindex()`. Size: 32–64 entries is sufficient (queries are short strings; a 64-entry cache is ~50 KB total).

**Option 5 — Pre-filter by serverFilter using a Set instead of Array.includes (ease: very high, impact: low)**

The current `serverFilter.includes(e.server)` is O(S) per entry. Convert to `Set<string>` once:
```ts
const filterSet = serverFilter ? new Set(serverFilter) : null;
const candidates = filterSet
  ? this.entries.filter((e) => filterSet.has(e.server))
  : this.entries;
```
O(1) per lookup. At 22 servers the absolute win is 1–2 ms but it's a one-line fix.

### IMPACT

| Approach | Est. p99 @ 10k | Reduction |
|----------|---------------|-----------|
| Current (baseline) | 359 ms | — |
| Option 1 — typed arrays | ~80 ms | −78% |
| Option 1 + 2 — typed arrays + heap | ~60 ms | −83% |
| Option 1 + 4 — typed arrays + query cache | ~5 ms (cache hit) / ~80 ms (miss) | −98% hits |
| Option 3 — HNSW | ~2 ms p99 | −99% |

### RECOMMENDED PATH

Ship Option 1 (typed-array score buffer) immediately — localised to `search()` in `vector-index.ts`, ~20 lines changed, zero dependencies. Eliminates the GC pressure root cause and should reduce p99 from 359 ms to ~80 ms.

Add Option 4 (query LRU cache) in the same PR — 20 lines in `index.ts`, eliminates repeated-query cost entirely for typical Claude usage patterns.

Option 5 (Set filter) is a one-line cleanup worth including.

Defer Option 3 (HNSW) until the tool count exceeds 5 000.

---

## BOTTLENECK 3 — Cache key derivation @ wide-100k (secondary)

### PROBLEM

The `buildCacheKey()` function in `src/cache/key.ts` calls `stableJsonStringify()` (recursive key-sort + `JSON.stringify`) followed by `crypto.createHash('sha256')` for every cache lookup. At 100 000 calls this costs 360 ms.

### EVIDENCE

From `deep-wide-2026-06-12.json`:
```json
{ "shape": "wide-100000", "depth": 1, "width": 100000, "keyDerivationMs": 360.32 }
```

`hashArgs()` at `src/cache/key.ts` line 51–54:
```ts
export function hashArgs(args: unknown): string {
  const str = stableJsonStringify(args ?? {});
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
```

For typical tool args (small JSON objects, <1 KB), each call is ~3.6 µs, which is acceptable. The 100k-wide stress case represents an adversarial access pattern (100 000 unique tools called simultaneously) that is unreachable in production with 498 tools. This bottleneck is **stress-only**, not production-critical.

That said, the SHA-256 is heavier than needed for a cache discriminator. A content-addressed key only requires collision resistance against accidental collision — not cryptographic strength.

### OPTIONS

**Option 1 — FNV-1a or xxHash instead of SHA-256 (ease: medium, impact: medium)**

xxHash-64 via `xxhash-wasm` or the native Node `hash` (available since v21.7.0) is ~5–10× faster than SHA-256 for short strings. At 100k keys this would cut keyDerivation to ~50 ms.

Caution: this is a **breaking change** for existing disk cache entries — all existing `.cbor` files would have keys derived from SHA-256 hex and would no longer match. Requires a cache version bump and migration or a grace period.

**Option 2 — Memoize `hashArgs` for identical args objects (ease: high, impact: medium)**

Many tool calls are issued with identical argument shapes (e.g., repeated `get_stock_price({symbol: 'AAPL'})` calls). A `WeakMap` keying on the args object reference (if args is an object) can short-circuit the hash computation for repeated references:
```ts
const argsHashCache = new WeakMap<object, string>();
export function hashArgs(args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const cached = argsHashCache.get(args as object);
    if (cached) return cached;
  }
  const str = stableJsonStringify(args ?? {});
  const hash = createHash('sha256').update(str, 'utf8').digest('hex');
  if (args !== null && typeof args === 'object') {
    argsHashCache.set(args as object, hash);
  }
  return hash;
}
```
Effective when the same args object reference is reused. Less effective if args is reconstructed on every call from parsed JSON.

**Option 3 — Accept SHA-256 cost as acceptable (ease: trivially high, impact: zero)**

At production scale (498 tools, typical 10–50 concurrent calls), key derivation is ~2–5 ms total. The 360 ms figure is an engineering stress test. No action required unless wide fan-out becomes a real workload.

### IMPACT

Production impact: negligible. Stress test impact: ~78% reduction with Option 1. Recommended: accept for now (Option 3), revisit if wide fan-out workloads materialise.

---

## BOTTLENECK 4 — Lock acquire p99 @ 50×1 hot-key (secondary)

### PROBLEM

From `lock-contention-2026-06-12.json`, the `50x1-hot-key` scenario (50 clients competing on a single KV key) shows p99 acquire latency of **399 ms** and a p50 of 191 ms.

### EVIDENCE

```json
{
  "scenario": "50x1-hot-key",
  "clientCount": 50,
  "keys": 1,
  "p50AcquireMs": 191,
  "p99AcquireMs": 399,
  "maxWaitMs": 400,
  "acquireCount": 150
}
```

This is a fairness problem, not a raw throughput problem. 50 clients queuing on one lock with typical hold durations of `holdMs` results in expected wait = `holdMs × (clients / 2)`. The 399 ms p99 is consistent with a FIFO queue where later arrivals wait for all predecessors to complete.

The 5-key spread scenario (`50x5-spread-keys`) shows p99=272 ms, and the 50-key spread shows p99=20 ms — confirming the issue is key fan-out, not the lock implementation itself.

### OPTIONS

**Option 1 — Add a configurable wait timeout and return error instead of queuing indefinitely**

If a caller has been waiting > N ms (e.g., 200 ms), reject the lock acquisition with a `LockContentionError` rather than continuing to queue. Callers can retry with exponential backoff on a different key or degrade gracefully. This caps the p99 at the timeout value.

**Option 2 — Partition hot keys into shards**

For the write path that creates the hot key: shard the key space across multiple sub-keys with a hash suffix. Callers select a shard by hashing their session ID or a random number. Reduces contention by the shard count. Requires the reader to merge across shards.

**Option 3 — Accept as a load-pattern issue rather than an implementation bug**

The 50-concurrent-same-key scenario is a degenerate workload. Production MCP calls operate on distinct keys per server+tool+args combination. The lock contention numbers are worst-case by design. The implementation correctly avoids deadlocks (`deadlockDetected: false`). No change required unless this pattern is observed in production metrics.

### IMPACT

This is a correctness / fairness concern under adversarial key distribution. The actual lock mechanism is sound. Recommended: Option 3 (accept) with Option 1 (timeout) as a hardening measure to prevent runaway queue growth under real workloads.

---

## Additional Latency Observations from Stress Benchmarks

All p95/p99 values exceeding 100 ms across the full 2026-06-12 benchmark run:

| Suite | Scenario | Metric | Value | Concern level |
|-------|---------|--------|-------|---------------|
| `large-payload` | tokenize @ 10 MB | tokenizeMs | 2 036 ms | **Critical** — primary target |
| `findtool-scaling` | query @ 10k tools | p99Ms | 359 ms | **High** — primary target |
| `deep-wide` | wide-100000 | totalMs | 415 ms | Medium — stress only |
| `deep-wide` | keyDerivation wide-100000 | keyDerivationMs | 360 ms | Low — stress only |
| `lock-contention` | 50x1-hot-key | p99AcquireMs | 399 ms | Low — adversarial pattern |
| `lock-contention` | 50x5-spread | p99AcquireMs | 272 ms | Low — adversarial pattern |

All other benchmarks (concurrency, bridge-ceiling, broadcast-storm, kv-load, circuit-storm, burst-recovery, retry-amplification, daemon-multi-agent) have p50/p99 values within acceptable bounds for their respective scenarios.

---

## Implementation Priority Matrix

| Priority | Change | Effort | Risk | Expected win |
|----------|--------|--------|------|-------------|
| P0 | `tokenize`: combined regex single pass | 3 h | Low | 2 036 → ~290 ms (−86%) |
| P1 | `findTool`: typed-array score buffer | 2 h | Low | p99: 359 → ~80 ms (−78%) |
| P2 | `findTool`: query LRU cache | 1 h | Low | p99: ~80 → ~5 ms on cache hit |
| P3 | `findTool`: Set for serverFilter | 15 min | Trivial | ~1–2 ms at large server counts |
| P4 | `tokenize`: lazy walk skip (zero-PII) | 2 h | Low | 0 ms for no-PII payloads |
| P5 | Lock contention: acquire timeout | 2 h | Medium | Caps p99 at configured limit |
| Defer | `findTool`: HNSW backend | 2–3 d | High | −99% at >5k tools only |
| Defer | Cache key: xxHash | 1 d | Medium (cache break) | −78% stress-only scenario |
