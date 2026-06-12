# 00 — Baseline State

Captured: 2026-06-12T08:20 UTC (probe run) / 2026-06-12 AEDT  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5e219e99c5cd7552cebceabd18b4bcd17b`

---

## 1. Recent commits (last 20, feat/lean-defaults)

```
f12f5f5 feat(lean-defaults): add set_diag_mode for per-call token+wall telemetry
7853f39 feat(lean-defaults): rewrite meta-tool descriptions for discoverability
dd35f7a feat(lean-defaults): add default max_result_tokens guard and terse output narration
ac9e69a feat: compare mode + per-server routing config
f3aefc8 release: v3.1.1 — multi-client setup wizard (#51)
ed63124 release: v3.1.0-rc.2 — CI gate calibration (#33)
8a322a0 release: v3.1.0-rc.1 — hardening + comprehensive tests + docs site + token-savings reporter + article 1 (#28)
273c268 chore: bump to 3.0.0-beta.2 with PR #12 review fixes
484d6ce Merge pull request #12 from darkiceinteractive/feature/v3
cb66cd6 chore(ci): drop Node 18 from CI matrix and engines.node floor
12d9fdb fix(v3-pr12): ALPHA — cache wiring + test_server security + passthrough dedup + import dryRun (#15)
5315b6f fix(v3-pr12): GAMMA — MCPToolError upstream serialization + PII detokenize scrub (#14)
a706b80 fix(v3-pr12): BETA — daemon hardening (auth file mode, auth timeout, lock overwrite, broadcast envelope) (#13)
e68b466 chore(v3): Agent K STATUS.md — all 8 blocks complete, PR #12 open
83a887e chore(v3): bump to 3.0.0-beta.1 + integration deliverables (Block 4-5)
996b6f1 fix(integration): repair mcp-server.ts merge corruption + missing deps
fb76a67 feat(v3-x4): PII tokenization with built-in matchers (#9)
43e91c4 feat(v3-x2): lifecycle MCP tools + interactive CLI wizard (#10)
b7fdb0d feat(v3-phase-5): sandbox capabilities (compact/summarize/delta/budget/findTool) (#11)
169b6b9 feat(v3-phase-2): cache layer (LRU + CBOR disk + delta) (#8)
```

---

## 2. Diff stat vs main

```
 src/config/schema.ts                     |  22 ++
 src/registry/built-in-recommendations.ts |  47 +++
 src/runtime/executor.ts                  |  14 +
 src/server/diag-mode.ts                  | 215 +++++++++++
 src/server/mcp-server.ts                 | 603 +++++++++++++++++++++++++++++--
 src/server/passthrough-registrar.ts      |  77 +++-
 test/unit/compare-mode.test.ts           | 118 ++++++
 test/unit/diag-mode.test.ts              | 429 ++++++++++++++++++++++
 test/unit/per-server-routing.test.ts     | 120 ++++++
 test/unit/tool-annotations.test.ts       |   2 +
 10 files changed, 1 615 insertions(+), 32 deletions(-)
```

Net: +1 615 lines added across 10 files; no deletions of substance.

---

## 3. Phase 2 catalog presence layer

`src/server/catalog.ts` **exists** (383 lines).

No commit on `feat/lean-defaults` with subject matching `feat(lean-defaults): catalog` was found. The file was introduced in a prior branch/merge and is present on `feat/lean-defaults` by inheritance. The most recent 20 commits do not include a catalog-specific entry, so Phase 2 (catalog presence layer) was **not shipped during this session** — it arrived from the `main`/`feature/v3` merge lineage.

---

## 4. Config server count

`~/.mcp-conductor.json` defines **22 servers**.

---

## 5. Active session server status (from system context)

The conductor system instructions report:

> mcp-conductor proxies 22 backend MCP servers (176 tools total — note: session context shows 176, probe shows 498 below). 16 servers FAILED to connect.

Failed in session context: `context7, sequential-thinking, taskmaster-ai, filesystem, memory, playwright, github, serena, brave-search, clickup, yahoo-finance, my-server, srv-a, srv-b, chrome-devtools, ansight`

---

## 6. Stdio probe — startup and tools/list timing

Command: initialize → notifications/initialized → tools/list  
Node version: v26.0.0  
Config: `~/.mcp-conductor.json` (22 servers, local build `dist/index.js`)

**Wall time to first tools/list response: 10 468 ms**

Sequence (from stderr timestamps):
- T+0 ms: process start
- T+~1 294 ms: first server connected (rgx, 7 tools)
- T+1 686 ms: tv (89 tools)
- T+2 305–3 862 ms: alphavantage, yfinance, yahoo-finance, afr, sequential-thinking, ibkr, filesystem, playwright, github, memory, context7, brave-search, clickup, chrome-devtools, serena
- T+5 628 ms: taskmaster-ai (first attempt — then WARN timed out at T+10 134 ms)
- T+10 134 ms: srv-a handshake timed out (10 000 ms timeout)
- T+10 468 ms: tools/list response returned — **29 tools advertised**

**Hard failures during probe (my-server, srv-b, ansight):** These three never connected and exhausted retries within the first ~16 s. The conductor correctly continues without them but the retry churn (srv-b: 25+ WARN lines) adds noise.

**Servers connected successfully in probe: 19 of 22**  
Failed permanently: `srv-b`, `my-server`, `ansight` (3/22 = 14%)  
Timed out (srv-a): 1 additional server with 10 s handshake timeout

---

## 7. Tools advertised at tools/list

**29 meta-tools** (conductor's own registered tools, not proxied backend tools).  
Backend tools are kept out of context by design; they are discoverable via `discover_tools`.

The full set of 498 backend tools (per probe initialize response instructions) is accessible via catalog/discover pathway.

First 5 meta-tools: `execute_code, list_servers, discover_tools, get_metrics, set_mode`

---

## 8. Instructions field size

The `serverInfo.instructions` field returned in the initialize response is **3 086 characters**.  
Estimated token cost: ~770 tokens (at ~4 chars/token).  
This is injected into Claude's system context on every new MCP session.

---

## 9. Stress benchmark reference numbers (2026-06-12 runs)

### S1 — execute_code concurrency (`concurrency-2026-06-12.json`)
| concurrent | p50 ms | p95 ms | p99 ms | throughput (calls/s) |
|-----------|--------|--------|--------|----------------------|
| 10        | 52.6   | 52.9   | 52.9   | 188                  |
| 50        | 51.1   | 51.1   | 51.1   | 976                  |
| 100       | 60.4   | 60.5   | 60.5   | 1 650                |

### S3 — bridge throughput ceiling (`bridge-ceiling-2026-06-12.json`)
- Ceiling RPS: **155.3** (mock bridge capacity 200 RPS; actual ceiling 78% of config)
- Error cliff threshold: 5%; cliff hit at ~155 RPS

### Large-payload processing (`large-payload-2026-06-12.json`)
| payload | tokenizeMs | endToEndMs |
|---------|-----------|------------|
| 100 KB  | 5.4       | 6.4        |
| 1 MB    | 243.6     | 247.4      |
| 10 MB   | 2 036     | 2 582      |

### findTool scaling (`findtool-scaling-2026-06-12.json`)
| index size | buildMs | queryTop3 ms | p99 ms  |
|-----------|---------|-------------|---------|
| 100       | 4.24    | 3.82        | 0.07    |
| 1 000     | 112.35  | 0.52        | 0.46    |
| 10 000    | 70.69   | 3.37        | 359.45  |

### R1 — slow-backend cascade (`slow-backend-2026-06-12.json`)
Gateway timeout: 3 000 ms; concurrency 100  
All buckets up to backendMs=1 000 settled within ceiling. Max single-call at 100 ms backend: 161 ms wall.

---

## 10. Source file sizes (top 30 by line count)

```
   252  src/cli/clients/registry.ts
   257  src/daemon/shared-kv.ts
   257  src/utils/rate-limiter.ts
   261  src/registry/typegen.ts
   276  src/cache/disk.ts
   278  src/cli/daemon.ts
   283  src/cli/commands/doctor.ts
   283  src/utils/tokenize.ts
   285  src/reliability/gateway.ts
   294  src/bin/cli.ts
   300  src/runtime/pool/worker-pool.ts
   324  src/modes/mode-handler.ts
   327  src/config/loader.ts
   330  src/cli/wizard/setup.ts
   341  src/observability/replay.ts
   352  src/server/passthrough-registrar.ts
   360  src/registry/registry.ts
   383  src/server/catalog.ts
   386  src/daemon/client.ts
   401  src/runtime/pool/worker.ts
   449  src/streaming/execution-stream.ts
   503  src/bridge/pool.ts
   531  src/skills/skills-engine.ts
   589  src/daemon/server.ts
   763  src/bridge/http-server.ts
   815  src/hub/mcp-hub.ts
   870  src/metrics/metrics-collector.ts
 1 151  src/runtime/executor.ts
 2 992  src/server/mcp-server.ts
23 752  total
```

`mcp-server.ts` at 2 992 lines is the single largest file — ~13% of total codebase by line count.

---

## 11. Meta-tool count

`grep -c "registerTool(" src/server/mcp-server.ts` → **26 registerTool calls**  
Tools advertised at tools/list → **29** (delta of 3 likely from dynamic/late registrations or registrations in other files).

---

## Key numbers summary

| Metric | Value |
|--------|-------|
| Branch | feat/lean-defaults |
| HEAD commit | f12f5f5 |
| Servers configured | 22 |
| Servers connected (probe) | 19 |
| Hard failures (probe) | 3 (srv-b, my-server, ansight) |
| Timeout (probe) | 1 (srv-a — 10 s handshake) |
| Cold-start to tools/list | **10 468 ms** |
| Tools advertised | 29 meta-tools |
| Backend tools (catalog) | 498 |
| Instructions field | 3 086 chars (~770 tokens) |
| Largest source file | mcp-server.ts (2 992 lines) |
| registerTool() calls | 26 |
| Bridge ceiling RPS | 155 |
| findTool p99 @ 10k tools | 359 ms |
| tokenize @ 10 MB | 2 036 ms |
