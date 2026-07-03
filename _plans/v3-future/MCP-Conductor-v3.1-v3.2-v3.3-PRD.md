# MCP Conductor v3.1 / v3.2 — Combined PRD

**Status:** Approved, in execution. v3.1 first wave merged (B1, B13, D1).
**Owner:** Matt Crombie / Dark Ice Interactive
**Implementer:** Claude Code, multi-agent (per-block fan-out as before)
**Baseline:** `@darkiceinteractive/mcp-conductor@3.0.0-beta.2` on `main` (commit `273c268`)
**Predecessor PRD:** `_plans/v3-enhancements/MCP-Conductor-v3-PRD.md`
**Successor PRD:** `_plans/v4-future/MCP-Conductor-v4.0-mesh-PRD.md` (mesh deferred from v3.3 → v4.0, owner decision 2026-05-04)
**Execution model:** **flexible** — every block is its own PR, independently approvable. User triggers each block at their cadence (late-night session, fit between meetings, etc.). No calendar dates.

---

## 1. Vision

v3.0 shipped a registry-driven Conductor that hits 99.7% token reduction against Anthropic's published benchmark and adds production-grade reliability/cache/observability/daemon infrastructure. v3.1–v3.2 turn that into a **release-grade product**: hardened, comprehensively tested against real popular MCPs, fully documented at a public docs site, and accompanied by a Medium article series that takes the work from "in main" to "well-known".

Two milestones, in order:

- **v3.1 — Hardening + tests + docs site + token-savings reporter + article 1** *(makes v3 trustworthy and observable)*
- **v3.2 — Capability completion + article 2** *(annotation passthrough, pluggable PII matchers, optional ONNX `findTool`)*

Each milestone independently shippable; each gets its own beta → soak → @latest cycle.

> **Note (2026-05-04):** Cross-host mesh originally scoped as v3.3 in this PRD has been **deferred to v4.0** per owner decision. Mesh is a substantially different scope (distributed-systems concerns, daemon wire protocol changes) and benefits from a soak period on v3.1+v3.2 first. See `_plans/v4-future/MCP-Conductor-v4.0-mesh-PRD.md` for the mesh plan; the former §9 (Milestone v3.3) has been moved there in full. Sections of this PRD that referenced v3.3 have been kept for traceability with a `[DEFERRED-V3.3→V4.0]` annotation; ignore them when planning current work.

---

## 2. Decisions baked in (from session Q&A)

- **Full scope**: PRD covers all three (v3.1, v3.2, v3.3) so the trajectory is visible.
- **Test data sourcing**: recorded fixtures gate every PR; real-API tests run nightly to detect drift.
- **CI tiering**: fast tests gate PRs; heavy tests run nightly with results published to `docs/benchmarks/`.
- **Content strategy**: series of 3–4 themed Medium articles + comprehensive docs site at `docs.darkice.co`.
- **Articles in HTML + MD**: each article is authored once in MD; build pipeline emits both HTML and MD outputs, each with embedded SVG diagrams (architecture, data flow, sequence). Source is checked in; output ships to docs site + Medium.
- **Docs platform**: **Cloudflare Pages + Docusaurus** (per technical-writer research). Multi-version selector, free, custom subdomain trivial since `darkice.co` is on Cloudflare DNS, PR-preview URLs built in, Algolia DocSearch (free for OSS) for search.
- **Token-savings reporter**: new v3.1 feature — flag-controlled per-call display of actual (execute_code) vs estimated (direct MCP) token cost + savings %. Estimation without running both is fully possible (see §5 design).
- **Versioning**: `Keep a Changelog` format, semver. v3.1.0 / v3.2.0 / v3.3.0 (or v4.0.0 if mesh introduces breaking changes).
- **Execution cadence**: per-block PRs, user approves spawning each fix/feature agent, no calendar.

---

## 3. Cross-cutting concerns

### 3.1 Documentation site — `docs.darkice.co`

- **Stack**: Docusaurus 3.x on Cloudflare Pages (free tier).
- **Repo path**: `docs-site/` (separate from existing `docs/v3/` markdown — the latter becomes source content the Docusaurus build pulls from).
- **Sections**: Getting Started, Architecture, Configuration, Sandbox API, Recipes, Migration (v2→v3), Benchmarks, CLI Reference, Daemon Reference, Articles, Changelog, Contributing.
- **Versioning**: `v2`, `v3`, `v3.1`, `v3.2`, `v3.3` selectors via Docusaurus's native versioning. v3 default; older accessible via dropdown.
- **Search**: Algolia DocSearch (free for OSS).
- **Custom domain**: `docs.darkice.co` (CNAME to `mcp-conductor-docs.pages.dev`).
- **PR previews**: every PR gets a unique `*.pages.dev` URL — link in PR template.
- **Build trigger**: GitHub push to `main`, `feature/*`, and on tag.

### 3.2 Changelog (`CHANGELOG.md`)

- **Format**: Keep a Changelog 1.1.0.
- **Initial population in v3.1**: backfill v1.0.0, v1.1.0, v2.0.0-alpha.1, v3.0.0-beta.1, v3.0.0-beta.2.
- **Discipline**: every PR touches `## [Unreleased]`. Version bumps move `[Unreleased]` to a dated heading.
- **Source of truth**: this file at repo root. Docusaurus pulls it as the "Changelog" page.

### 3.3 README.md

- **v3.1 update**: refresh with v3 stats (99.7%, 1281 tests + new totals), link to docs site, link to article series, **token-savings reporter quick example**.
- **v3.2 update**: new sandbox helpers section, typegen annotation passthrough.
- **v3.3 update**: multi-host section, mesh quickstart.

### 3.4 Article series

Three themed articles + optional retrospective. Each ~1500–2000 words. Each authored in MD, built to HTML + MD + SVG.

| # | Title (working) | Lands with | Theme |
|---|---|---|---|
| 1 | "MCP Conductor v3: registry-driven, production-ready code execution" | v3.1 | Architecture overview, registry foundation, cache+reliability wiring, 99.7% benchmark, token-savings reporter |
| 2 | "Tokens, types, and tokenization: production hardening for MCP" | v3.2 | Type-driven sandbox, PII tokenization w/ custom matchers, observability |
| 3 | "Multi-agent fleet: cross-host MCP coordination over Tailscale" | v3.3 | Distributed daemon, shared KV/locks, mesh, multi-Mac/Linux deployment |
| 4 (optional) | "What we learned building Conductor" | post-v3.3 | Retrospective: review-driven dev, multi-agent sprint shape |

#### 3.4.1 Article authoring pipeline (new requirement)

Each article authored once as Markdown source under `articles/<slug>/article.md`. Build pipeline (`npm run build:articles`) produces:

| Artifact | Used for |
|---|---|
| `articles/<slug>/dist/article.html` | Standalone HTML version (self-contained, embedded SVGs, inline CSS for portability) |
| `articles/<slug>/dist/article.md` | Re-rendered MD with SVG image references resolved (for Medium copy-paste, GitHub gist, dev.to cross-post) |
| `articles/<slug>/dist/diagrams/*.svg` | Standalone SVG files referenced by both outputs |
| `articles/<slug>/dist/article.medium.md` | Medium-flavoured MD (uses Medium's `<figure>` + caption convention; SVGs converted to PNG fallbacks for Medium's image upload) |

**Diagram authoring**:
- Source: Mermaid blocks (` ```mermaid ` fenced) authored inline in `article.md`.
- Build step: `mermaid-cli` (`@mermaid-js/mermaid-cli`) converts each block to SVG. Output filename: `diagrams/diagram-<n>.svg`.
- HTML build embeds SVG inline (no external requests). MD builds reference via relative path. Medium build references hosted SVG/PNG (uploaded as part of article-publish step).
- For diagrams that Mermaid can't express well (custom architecture), source as hand-authored SVG in `articles/<slug>/svg-source/` and reference directly.

**Tooling**:
- `unified` + `remark` + `rehype` for MD → HTML transform.
- `@mermaid-js/mermaid-cli` for diagram rendering.
- `sharp` for SVG → PNG fallback (Medium build only).
- Build orchestrated by `scripts/build-articles.ts`.

**Output discipline**:
- `articles/<slug>/article.md` is hand-authored.
- `articles/<slug>/dist/` is generated, gitignored. CI rebuilds on push.
- Docs site `articles/` section pulls from `articles/<slug>/dist/article.html`.

### 3.5 Test architecture

See §6 for the full plan. User specifically called out: comprehensive coverage, token-savings validation against popular MCPs, performance (speed + memory), memory leak detection, security, functional. Existing baseline 1281 tests; v3.1 expands significantly.

### 3.6 Release process per milestone

Same loop, repeated v3.1 → v3.2 → v3.3:

1. Block-by-block PRs land on `feature/v3.X`.
2. Each PR: code + tests + `docs-site/docs/` updates + `CHANGELOG.md [Unreleased]` entry.
3. When all blocks land: bump `package.json` → `3.X.0-rc.1` → tag → CI publishes to `@next`.
4. Soak `@next` 7 days. Run nightly heavy. Surface anomalies.
5. If clean: bump → `3.X.0` → tag → publishes to `@beta`. Soak 7 more days. Promote `@beta → @latest`.
6. Open PR `feature/v3.X` → `main`. Review + merge.
7. Publish corresponding Medium article.
8. Update README.

### 3.7 CI tiering

| Tier | Triggers | Suites | Wall budget |
|---|---|---|---|
| **PR gate** (existing `validate`, expanded) | every push, every PR | unit + integration + small functional + lint + build + coverage threshold + perf assertions (no-bench mode) + fast security | <2 min |
| **Nightly heavy** (new `nightly.yml`) | scheduled 02:00 UTC + manual dispatch | memory soak (1h), real-API token-savings, security fuzzing | <90 min |
| **Release gate** (extended PR gate when tag is `v*-rc*`) | tag push to `*-rc*` | PR gate + 10-min soak + recorded-fixture popular-MCP runs + `npm pack` validation | <15 min |

Nightly results published to `docs/benchmarks/nightly-YYYY-MM-DD.{json,md}` and surfaced on the docs site.

---

## 4. Milestone v3.1 — Hardening + tests + docs site + token-savings reporter + article 1

**Goal:** turn v3.0.0-beta.2 into a release-grade product.

### 4.1 Hardening blocks (B-prefix, 13 PRs)

Each block is a single PR. Independently mergeable.

| Block | Scope | Files | Acceptance |
|---|---|---|---|
| **B1** | MED-1 daemon auth TOCTOU | `src/daemon/server.ts` | try/catch readFileSync; ENOENT path; race-window test |
| **B2** | MED-2 daemon socket buffer cap | `src/daemon/server.ts:285-294` | `MAX_BUFFER_BYTES=10MB`; destroy on breach; test |
| **B3** | MED-3 CBOR cache schema validation | `src/cache/disk.ts:76,195,223` | post-decode shape check; discard malformed; test crafted .cbor |
| **B4** | MED-4 sharedSecretPath validation | `src/daemon/server.ts:43` | absolute path inside `CONDUCTOR_DIR`; reject otherwise; test |
| **B5** | MED-5 import_servers env scrub | `src/cli/commands/import-servers.ts:118`, `src/server/mcp-server.ts:1715-1728` | summary strips env values; test |
| **B6** | MED-code-A passthrough startup race | `src/server/mcp-server.ts:134-135,1943-1948` | transport.connect() after registerPassthroughTools(); test |
| **B7** | MED-code-B worker pool recycle window | `src/runtime/pool/worker-pool.ts:243-270` | spawn replacement synchronously in 'starting' state; test |
| **B8** | LOW-1 CORS hardcoded origin | `src/bridge/http-server.ts:371-377` | `Access-Control-Allow-Origin: http://127.0.0.1:<port>`; doc credentials note |
| **B9** | LOW-2 daemon socket liveness check | `src/daemon/server.ts:178-181` | ping existing socket before unlink; abort if alive |
| **B10** | LOW-3 timestamped .bak | `src/cli/commands/import-servers.ts:72-75` | `.bak.YYYYMMDDHHMMSS` suffix |
| **B11** | LOW-code-A hmacToken scope | `src/daemon/server.ts:56` | move inside `handleAuth` |
| **B12** | LOW-code-B + C doc cleanups | `src/utils/tokenize.ts:213`, `src/server/mcp-server.ts:161` | doc-only |
| **B13** | **NEW: Token-savings reporter** (see §5) | `src/metrics/metrics-collector.ts`, `src/runtime/executor.ts`, `src/server/mcp-server.ts` | flag controls per-call report; actual vs estimated direct-MCP cost + savings %; tests |

### 4.2 Test expansion blocks (T-prefix)

| Block | Scope |
|---|---|
| **T1** | New `test/perf/`; latency suite (cold/warm/throughput) |
| **T2** | New `test/memory-leak/`; 10K-call sequential, 100K-cache-write, 10K-daemon-cycle, 1K-execute-error suites |
| **T3** | New `test/security/`; fuzzing on bridge/daemon/test_server; auth bypass; tokenization escape; path traversal |
| **T4** | New `test/popular-mcps/`; recorded-fixture suites for github, gmail, gdrive, gcalendar, filesystem, brave-search, memory, slack, notion, linear |
| **T5** | New `test/popular-mcps/token-savings/`; per-MCP token-reduction validation; assert ≥ documented thresholds |
| **T6** | Recording harness: `npm run record:fixtures -- <server>` captures real responses to `test/fixtures/recordings/<server>/`. Owner runs once with creds; CI replays. PII tokenized at recording time so fixtures are commit-safe. |
| **T7** | New nightly workflow `.github/workflows/nightly.yml`; runs T1+T2+T3+T5 against real APIs (creds from secrets) |
| **T8** | Coverage threshold raise: 82% → 88%; per-module table in `vitest.config.ts` |

### 4.3 Docs + content blocks (D-prefix)

| Block | Scope |
|---|---|
| **D1** | Scaffold `docs-site/` with Docusaurus 3.x; basic config; first build green; deploy to `*.pages.dev` |
| **D2** | Migrate `docs/v3/` content into `docs-site/docs/v3/` with sidebar/nav; configure Algolia DocSearch (apply for free OSS) |
| **D3** | Add v2 docs as separate version (read from git history at v2 tag); enable version selector |
| **D4** | Custom domain `docs.darkice.co` (Cloudflare DNS + Pages config); SSL auto |
| **D5** | `CHANGELOG.md` at repo root, Keep a Changelog format, backfilled v1.0.0 → v3.0.0-beta.2 |
| **D6** | README.md v3.1 refresh; new "v3 highlights" table; doc-site links; token-savings reporter example |
| **D7a** | **NEW: Article authoring pipeline** (see §3.4.1) — `articles/` directory layout, `scripts/build-articles.ts`, mermaid-cli + remark + rehype + sharp dependencies, npm scripts: `build:articles`, `record:fixtures`, gitignore for `articles/*/dist/` |
| **D7b** | Medium article 1 source: `articles/v3-architecture/article.md` (~1500 words, ~5 mermaid diagrams). Build emits HTML + MD + Medium MD + SVG/PNG diagrams. Owner clicks Publish on Medium. |

### 4.4 Release block

| Block | Scope |
|---|---|
| **R1** | `package.json` → `3.1.0-rc.1` → tag → CI publish to `@next` → 7-day soak → nightly clean for 5+ nights → bump → `3.1.0` → tag → `@beta` → another 7-day soak → promote `@beta → @latest` |

---

## 5. Token-savings reporter (B13) — design

### 5.1 User-facing surface

A new optional flag on `execute_code` and a new MCP tool. Two access modes:

**Mode A — per-call inline report** (flag on `execute_code`):

```typescript
// Claude calls:
execute_code({
  code: "...",
  show_token_savings: true,  // NEW (default false)
});

// Response includes a new field:
{
  result: { ... },
  metrics: {
    toolCalls: 3,
    dataProcessedBytes: 487530,
    resultSizeBytes: 246,
  },
  // NEW
  tokenSavings: {
    actualTokens: 162,                    // code tokens + final-result tokens
    estimatedDirectTokens: 124_983,       // what the same workflow would cost via direct passthrough
    savingsPercent: 99.87,
    savingsTokens: 124_821,
    breakdown: {
      codeTokens: 87,
      resultTokens: 75,
      directCallOverheadTokens: 450,      // (3 calls × 150)
      directDataTokens: 124_533,          // (487530 bytes / 1024) × 256
    },
  }
}
```

**Mode B — global metrics** (existing `get_metrics` tool, expanded):

`get_metrics` already returns aggregate counts; v3.1 adds `tokenSavings: { sessionActual, sessionEstimatedDirect, sessionSavingsPercent, perTool: { ... } }`.

**Mode C — config default**: `~/.mcp-conductor.json` `metrics.alwaysShowTokenSavings: true` makes the per-call report default-on without needing the per-call flag.

### 5.2 Can we estimate without running both? — Yes.

The estimation formula is identical to the one already used in `src/metrics/metrics-collector.ts` to compute the v3 benchmark numbers (per session memory):

```
direct_tokens   = (calls × 150) + ceil(raw_response_bytes / 1024) × 256
execution_tokens = ceil(code_chars / 3.5) + ceil(result_json_bytes / 3.8)
savings         = (direct - execution) / direct
```

The execution path **already runs**, so we have:
- `code_chars`: the user code submitted to `execute_code` (measured directly)
- `result_json_bytes`: the JSON-serialised final result (measured directly)
- `calls`: incremented by the bridge (existing `metrics.toolCalls`)
- `raw_response_bytes`: incremented by the bridge per call (existing `metrics.dataProcessedBytes`)

All four inputs exist today — we just don't expose the derived `tokenSavings` block. B13 implementation is mostly plumbing:

1. `metrics-collector.ts`: add `computeTokenSavings(metrics)` function returning the structured block. Pure function, fully testable.
2. `executor.ts`: when `show_token_savings: true`, attach the computed block to the result envelope.
3. `mcp-server.ts`: surface the field through the MCP tool response shape; add `show_token_savings` to the `execute_code` input schema.
4. `get_metrics` tool: extend output schema to include session-level savings.
5. Config option `metrics.alwaysShowTokenSavings: false` (default) → can be flipped by user.

### 5.3 Caveats — surface in the docstring + docs

The estimate is a model, not a measurement. Important caveats to document on the tool:

- The 256-tokens-per-KB constant is derived from observed Claude tokenisation of typical JSON payloads. Highly compressible / pre-summarised payloads would tokenise differently in reality.
- Per-call overhead of 150 tokens models the schema disclosure + tool-result envelope. This dominates for tiny responses (< 500B raw); savings can look smaller for those.
- For tools with `routing: "passthrough"` (X1), the actual direct path is *already* used — `tokenSavings` shows zero benefit (correct behaviour) and the report includes a note: `"This tool is passthrough — execute_code routing not applicable."`
- For **mutation** tools (write_file, send_message, etc.), the savings number is informational only — these tools should generally be called directly (or guarded by `routing: "passthrough"`) so a developer doesn't optimise them for tokens at the expense of safety.

### 5.4 Tests

- Unit: `computeTokenSavings({calls:0, bytes:0, codeChars:50, resultBytes:20})` — assert overhead-only path.
- Unit: realistic shape (3 calls, 500KB processed, 100B result) — assert > 99% savings (matches v3 benchmark math).
- Unit: shape with `routing: "passthrough"` annotations — assert "not applicable" path.
- Integration: end-to-end execute_code with `show_token_savings:true` — assert the field appears in the response and is well-formed.
- Snapshot test against the Anthropic 150K→2K fixture — assert the reporter independently calculates 99.7% (cross-check vs the standalone benchmark).

---

## 6. Detailed test plan

### 6.1 Performance suite (`test/perf/`, T1)

vitest `bench` mode + custom harness for warm-up + percentile reporting.

| Test | Target | Failure threshold |
|---|---|---|
| `cold-start.bench.ts` | First `execute_code` call after process start | > 50ms = fail |
| `warm-call.bench.ts` | Subsequent execute_code calls (worker pool warm) | p50 > 15ms or p99 > 50ms = fail |
| `cache-hit.bench.ts` | Repeat call with cached result | p50 > 2ms = fail |
| `passthrough-call.bench.ts` | Direct passthrough tool (bypasses Deno) | p50 > 30ms = fail |
| `bridge-throughput.bench.ts` | Concurrent calls/sec sustained over 60s | < 80 calls/sec = fail |
| `registry-refresh.bench.ts` | Full registry refresh (10 mock servers, 100 tools each) | > 2s = fail |
| `tokenize-throughput.bench.ts` | Tokenize 1MB JSON with all 6 matchers | > 100ms = fail |

Output: `docs/benchmarks/perf-YYYY-MM-DD.json`. Trend chart on docs site.

### 6.2 Memory leak suite (`test/memory-leak/`, T2)

RSS sampling between iterations + final assertion that growth is within tolerance.

| Test | Iterations | Growth tolerance |
|---|---|---|
| `worker-pool-soak.test.ts` | 10,000 sequential `execute_code` calls | RSS growth ≤ 10% from baseline |
| `worker-pool-recycle.test.ts` | 1000 calls, recycle every 10 jobs | RSS stable; no zombie Deno PIDs |
| `connection-pool-soak.test.ts` | 10,000 acquire/release cycles | FD count stable; no leaked sockets |
| `cache-bounded.test.ts` | 100,000 cache writes (mixed sizes) | Memory bounded by `maxMemoryBytes`; disk bounded by `maxDiskBytes` |
| `daemon-connect-cycle.test.ts` | 10,000 daemon client connect/disconnect | Server FDs + memory stable; lock handles all released |
| `streaming-cleanup.test.ts` | 1000 streamed executions, half abort mid-stream | StreamManager state cleared; no orphan streams |
| `error-path-soak.test.ts` | 1000 execute_code that throw / fail bridge / hit timeouts | No process leaks (orphan-watch confirms); no zombie Denos |

Soak tests on nightly tier (~1h total).

### 6.3 Security suite (`test/security/`, T3)

| Test | What it tries |
|---|---|
| `daemon-auth-fuzz.test.ts` | Random/malformed bytes at the auth handshake; assert connection closes, no crash |
| `daemon-auth-bypass.test.ts` | Replay old nonces, send wrong HMAC, send no auth at all; assert all rejected |
| `daemon-auth-timing.test.ts` | Measure timing of correct vs wrong HMAC; assert constant-time comparison (variance < 5%) |
| `daemon-broadcast-injection.test.ts` | Try to inject `{id:N, result:...}` payloads via broadcast; assert client-side envelope check holds |
| `bridge-cors-variations.test.ts` | Origin variations (uppercase, trailing slash, IDN, IP literals); assert only loopback accepted |
| `bridge-header-injection.test.ts` | CRLF-injection in Origin/Mcp-Session-Id; assert sanitised |
| `tokenize-leak-paths.test.ts` | Try every possible PII leak vector (return value scrub already covered; this expands to nested errors, log lines, anomaly detector output, **token-savings reporter output** — must not include real values) |
| `test-server-allowlist.test.ts` | Try to invoke `test_server` with command/args/env (should be rejected post-CRIT-5 fix); try shell-metachar names |
| `path-traversal.test.ts` | `import_servers_from_claude` with `../` paths, symlinks, weird chars |
| `cbor-poisoning.test.ts` | Write malformed CBOR to cache dir; assert validation catches and discards |
| `redos-tokenize.test.ts` | Pathological inputs to each PII matcher (catastrophic backtracking) — assert all complete in < 100ms |
| `sandbox-escape-attempts.test.ts` | Deno sandbox known-escape vectors (process spawning, network outside loopback); assert all blocked |

### 6.4 Functional — popular MCPs (`test/popular-mcps/`, T4)

10 MCP servers covered. Each has:

- `<server>/recorded.test.ts` — replays recorded fixtures (CI-gated)
- `<server>/live.test.ts` — hits real API (nightly only, requires creds)

| Server | Tools covered (subset; full list per recording session) |
|---|---|
| `github` | get_me, list_repositories, list_issues, get_issue, list_pull_requests, get_pull_request, search_code, search_issues |
| `gmail` (read-only) | list_labels, search_threads, get_thread, list_drafts, get_message |
| `gdrive` (read-only) | list_recent_files, search_files, get_file_metadata, read_file_content |
| `gcalendar` (read-only) | list_calendars, list_events, get_event, suggest_time |
| `filesystem` | list_directory, read_file, search_files, write_file (separate destructive group) |
| `brave-search` | brave_web_search |
| `memory` | store, retrieve, list, delete |
| `slack` | list_channels, get_channel_messages, search_messages (read-only) |
| `notion` | search, get_page, list_databases |
| `linear` | list_issues, get_issue, list_projects |

**Recording harness** (T6):

```bash
npm run record:fixtures -- github
npm run record:fixtures -- gmail --tools=list_labels,search_threads
```

Outputs to `test/fixtures/recordings/<server>/<tool>-<args-hash>.json`. PII tokenized at recording time so fixtures are commit-safe. Re-record on demand when tool schemas change.

### 6.5 Token-savings validation (`test/popular-mcps/token-savings/`, T5)

For each MCP tool, assert measured token reduction meets the published target. Targets derived from the v3.0 benchmark + 10% safety margin per category:

| Tool category | Target reduction |
|---|---|
| Listing tools (list_*, search_*) returning > 50 items | ≥ 95% |
| Detail tools (get_*) returning a single object | ≥ 70% |
| Read-content tools (read_file, get_file_content, get_thread) | ≥ 90% |
| Search tools | ≥ 92% |
| Tools returning < 200 tokens raw | passthrough recommended (no win from execute_code) — assert routing recommendation == "passthrough" |

Output: per-tool reduction report at `docs/benchmarks/popular-mcps-YYYY-MM-DD.md`. Trend chart on docs site. **The token-savings reporter (B13) computes exactly the same numbers — assert reporter output matches benchmark output for the same fixture.**

### 6.6 Coverage targets

| Module | v3.0 baseline | v3.1 target |
|---|---|---|
| `src/registry/` | 92% | maintain |
| `src/cache/` | 88% | maintain |
| `src/reliability/` | 90% | maintain |
| `src/daemon/` | 85% | 92% (after B1-B4 + new tests) |
| `src/runtime/` | 80% | 88% |
| `src/utils/tokenize.ts` | 95% | maintain |
| `src/observability/` | 87% | maintain |
| `src/cli/` | 65% | 80% |
| `src/metrics/` (incl. new B13 reporter) | 75% | 92% |
| **Overall** | **82%** | **≥ 88%** |

Per-module thresholds enforced via `vitest.config.ts` `coverage.thresholds`.

---

## 7. CI workflows

### 7.1 PR gate (`.github/workflows/ci.yml` — existing, expanded)

```yaml
on: [push, pull_request]
jobs:
  validate:
    matrix: [20.x, 22.x]
    steps:
      - npm ci
      - npm run lint
      - npm run build
      - npm run test:run                    # unit + integration + small functional
      - npm run test:perf -- --no-bench-mode # perf assertions only
      - npm run test:security               # fast security suite
      - npm run test:coverage:check
```

Wall budget: < 2 min.

### 7.2 Nightly heavy (`.github/workflows/nightly.yml` — new, T7)

```yaml
on:
  schedule: [{ cron: '0 2 * * *' }]
  workflow_dispatch: {}
jobs:
  memory-soak:
    timeout-minutes: 90
    steps: [..., npm run test:memory-leak ]
  real-api-popular-mcps:
    needs-secrets: [GH_TOKEN, GOOGLE_OAUTH_CREDS, BRAVE_API_KEY, ...]
    steps: [..., npm run test:popular-mcps:live, npm run benchmark:token-savings:live, upload to docs/benchmarks/]
  security-fuzz:
    timeout-minutes: 30
    steps: [..., npm run test:security:fuzz ]
```

### 7.3 Release gate (extends PR gate when tag matches `v*-rc*`)

Adds: 10-min memory soak (subset of nightly), recorded-fixture popular-MCP runs, packaging dry-run (`npm pack`).

---

## 8. Milestone v3.2 — Capability completion + article 2

| Block | Scope | Notes |
|---|---|---|
| **C1** | Phase 1 typegen extension: carry upstream MCP `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` through `ToolDefinition` to `passthrough-registrar` (proper H4 fix; replaces v3.1 name-pattern heuristic) | Touches `src/registry/registry.ts` refresh, `src/registry/typegen.ts`, `src/registry/index.ts`, `src/server/passthrough-registrar.ts`. Heuristic remains as fallback. |
| **C2** | Pluggable PII matchers — inline regex form: `redact.response: ["email", { name: "ibkr_con_id", pattern: "..." }]` | Validates regex at config load (catch ReDoS via timeout). Adds to `src/utils/tokenize.ts`. |
| **C3** | Pluggable PII matchers — function-form (matcher loaded from user-specified JS file path) | Sandboxed-of-the-sandbox concern: load matcher in a separate Deno worker with no network/fs perms. Defer to v3.3 if it bloats v3.2. |
| **C4** | ONNX-backed `findTool` upgrade | **Conditional**: only if v3.1 nightly metrics show TF-IDF top-3 hit rate < 80%. Otherwise skip. Touches `src/runtime/findtool/`. |
| **C5** | Skills directory wiring deepening | Sandbox API exposure of `skills.run/list/findByQuery`. v3.1 wired the env var; v3.2 surfaces the API. |
| **D8** | Docs site: new pages for typegen annotation passthrough, pluggable matchers, ONNX upgrade. v3.2 version on selector. |
| **D9** | Article 2 source: `articles/v3-hardening/article.md` (~1500 words). Same MD→HTML+MD+SVG pipeline. |
| **R2** | Tag v3.2.0 same release process as R1. |

---

## 9. [DEFERRED-V3.3→V4.0] Milestone v3.3 — Cross-host mesh + article 3

> **This entire section is DEFERRED to v4.0.** See `_plans/v4-future/MCP-Conductor-v4.0-mesh-PRD.md` for the canonical mesh plan. The content below is preserved verbatim for traceability only — do NOT execute it as part of v3.x. v4.0 work begins only after v3.2 hits `@latest`.

| Block | Scope | Notes |
|---|---|---|
| **M1** | Distributed lock primitive: replace single-host mutex with Tailscale-aware lock manager. Algorithm: Raft-lite or fencing tokens — pick simpler during planning. | Touches `src/daemon/shared-lock.ts`. New `src/daemon/distributed-lock.ts`. |
| **M2** | Distributed KV: replication via Tailscale peer discovery. Last-writer-wins with vector clocks for conflict detection. | Touches `src/daemon/shared-kv.ts`. New `src/daemon/distributed-kv.ts`. |
| **M3** | Tailscale peer discovery hardened: handle peer joins/leaves, partial failures, daemon-restart resilience. | Builds on existing `src/daemon/discovery.ts`. Windows daemon discovery still deferred. |
| **M4** | Multi-host integration tests: spin up 3 daemons in test (3 worker processes), assert cache sharing and lock serialisation across them. | New `test/integration/daemon/multi-host.test.ts`. |
| **M5** | Multi-host benchmark + soak: 3 connected daemons, simulated 8 agents distributed across them, 1-hour soak. | Recorded fixtures still — actual Tailscale not used in CI. |
| **D10** | Docs site: deployment guide for multi-host; Tailscale setup; topology recommendations. v3.3 version on selector. |
| **D11** | Article 3 source: `articles/v3-mesh/article.md` (~2000 words). Multi-diagram set: topology, leader election, conflict resolution. |
| **D12** (optional) | Article 4 source: `articles/v3-retrospective/article.md`. Owner's call. |
| **R3** | Tag v3.3.0 (or v4.0.0 if mesh introduces breaking changes — assess at release time). |

---

## 10. Execution model — compressed timeline

User explicit: "compress the timeline to as i execute/approve each step".

**No calendar.** Instead, **block gates**:

- Each block in §4 / §8 / §9 is independently mergeable.
- User triggers: "kick off block B3" (or similar). I spawn the relevant fix agent, monitor, post a summary, and wait for approval to merge.
- Multiple blocks can run in parallel via the multi-agent worktree pattern from the v3 sprint.
- Per-milestone `STATUS.md` in `_plans/v3-future/` tracks block state — same convention as v3.

**Milestone gates**:

- v3.1 ready to tag when: all B/T/D blocks merged, nightly heavy clean for 5+ consecutive nights, coverage ≥ 88%.
- v3.2 ready: all C blocks + D8 + D9 merged, nightly clean.
- v3.3 ready: all M blocks + D10 + D11 merged, multi-host benchmark green.

---

## 11. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Real-API tests flake on rate limits | Medium | Medium | Recorded fixtures gate PRs; live tests run nightly with retries + back-off |
| Nightly token quota exceeded | Low | Low | Per-MCP rate caps in test config; cycle through tools across nights |
| Cloudflare Pages free tier limits hit | Very Low | Low | 500 builds/month is ample for OSS scale |
| Algolia DocSearch OSS application rejected | Low | Low | Fall back to Pagefind (free, client-side) |
| Distributed lock correctness in v3.3 | High | High | Pick simpler algorithm; spike before committing; fall back to single-leader-with-failover if fully distributed proves too risky |
| Docs site versioning out of sync with code | Medium | Low | CI step validates every `src/` PR includes a corresponding `docs-site/docs/` update or has `[docs-skip]` tag |
| Medium article cadence falls behind code | Medium | Low | Article is a release-blocker per §3.6 |
| ONNX upgrade in v3.2 (C4) destabilises sandbox | Low | Medium | Conditional on v3.1 nightly metrics showing TF-IDF insufficient; skip if not needed |
| Token-savings reporter (B13) misleads users due to estimation error | Medium | Low | Document caveats prominently; cross-check vs benchmark in test suite (§5.4); consider showing a confidence interval (`±15%`) instead of a single number if estimation noise is high |
| Article SVG diagrams render differently on Medium vs HTML vs GitHub MD | Medium | Low | Build pipeline emits PNG fallback for Medium; HTML embeds inline SVG; MD references external SVG (renders on GitHub natively); test each output on its target platform once per article |

---

## 12. Definition of done

### v3.1
- [ ] All 13 hardening blocks (B1–B13) merged
- [ ] All 8 test blocks (T1–T8) merged
- [ ] All 7 docs blocks (D1–D7b) merged
- [ ] Nightly heavy suite clean for 5+ consecutive nights
- [ ] Coverage ≥ 88% overall, per-module thresholds met
- [ ] `docs.darkice.co` live with v2 + v3 + v3.1 selectors
- [ ] CHANGELOG.md backfilled and current
- [ ] README.md v3.1-refreshed
- [ ] Article 1 published (HTML + MD + SVG built; Medium draft visible to owner)
- [ ] Tag `v3.1.0` published to `@beta`, soaked 7+ days, promoted to `@latest`

### v3.2
- [ ] All capability blocks (C1–C5, conditional on C4) merged
- [ ] D8 (docs page additions) + D9 (article 2) shipped
- [ ] Nightly clean
- [ ] Tag `v3.2.0` → `@beta` → soak → `@latest`

### v3.3
- [ ] All mesh blocks (M1–M5) merged
- [ ] Multi-host integration tests green
- [ ] D10 (docs) + D11 (article 3) shipped
- [ ] D12 (article 4) optional
- [ ] Tag `v3.3.0` (or `v4.0.0` if breaking) → `@beta` → soak → `@latest`

---

## 13. Open questions (clarify before execution)

Minor, can be resolved at first-block kickoff if not addressed now.

1. **Real-API test creds**: do you want the recording harness to use your existing credentials (`~/.mcp-conductor.json`'s configured servers), or set up dedicated test accounts? Real test accounts are cleaner but more setup.
2. **Docs site repo location**: keep `docs-site/` in this monorepo (simpler), or split to a separate `mcp-conductor-docs` repo (cleaner separation, more overhead)? Recommendation: monorepo.
3. **Article publishing platform**: Medium only, or also cross-post to dev.to / Hashnode / personal blog? Recommendation: Medium primary, dev.to + GitHub gist as cross-posts (the build pipeline already produces the necessary MD variants).
4. **v3.3 mesh — fencing tokens vs Raft-lite**: pick at M1 planning. Owner can defer.
5. **License for the docs site content**: same MIT as code, or CC-BY for written content? Recommendation: MIT (consistent).
6. **Token-savings reporter default**: is `metrics.alwaysShowTokenSavings: false` (opt-in per call) the right default, or should it be `true` (always show, can opt out per call)? Recommendation: `false` default — most calls don't need it and it adds ~150 bytes to every result envelope. Toggle via config when actively benchmarking.
7. **Article diagram tool**: Mermaid for flow/sequence, hand-authored SVG for architecture (current proposal). Acceptable, or prefer Excalidraw / D2 / something else?

---

*End of PRD.*
