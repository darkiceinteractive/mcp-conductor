# 06 — Connection Strategy: Lazy vs Eager vs Prewarmed

Authored: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## 1. PROBLEM

The conductor connects **all 22 configured backends simultaneously at startup**
(`hub.initialise()` → `Promise.allSettled(connectionPromises)` in
`src/hub/mcp-hub.ts:119–125`).  
Startup is blocked until every connection either succeeds, times out (10 s), or
exhausts retries — whichever takes longest.

Measured cold-start to first `tools/list` response: **10 468 ms**.

That single number dominates the user-visible latency when Claude Code launches
or reconnects. The vast majority of real sessions touch a small fraction of the
22 configured backends.

---

## 2. EVIDENCE

### 2.1 Startup sequence (from baseline probe)

```
T+0 ms       process start
T+1 294 ms   rgx connected  (7 tools)
T+1 686 ms   tv connected   (89 tools)
T+2 305–3 862 ms  remaining fast servers
T+5 628 ms   taskmaster-ai (slow — first attempt)
T+10 134 ms  srv-a handshake timed out (10 000 ms timeout fired)
T+10 468 ms  tools/list response returned
```

The tail cost is entirely from a **single** server (`srv-a`) hitting the
per-child `connectionTimeoutMs` floor. Without that one server the probe would
have completed around **T+5 700 ms**, and without the three permanent failures
(`srv-b`, `my-server`, `ansight`) retrying, likely faster still.

### 2.2 The startup critical path in code

`mcp-server.ts start()` (lines 2668–2921):

```
hub.initialise()           ← BLOCKING — all 22 concurrent connects + listTools
registry.refresh()         ← reads toolCache, already populated by hub
registerPassthroughTools() ← synchronous loop over registry, O(n tools)
setCatalogInstructions()   ← pure computation, <1 ms
server.connect(transport)  ← stdio handshake with the MCP client
```

Only `hub.initialise()` is slow. Everything downstream is sub-millisecond.

### 2.3 Why `hub.initialise()` calls `listTools` per child

`connectServer()` (mcp-hub.ts:330) calls `cacheServerTools()` immediately after
`client.connect()`. `cacheServerTools()` calls `client.listTools()` over the
child's stdio transport. This is the canonical round-trip that establishes tool
counts and schemas used by:

- `registry.refresh()` (reads `toolCache`)
- `registerPassthroughTools()` (iterates `registry.getAllTools()`)
- `setCatalogInstructions()` (calls `hub.listServers()` → `hub.getServerTools()`)
- The inline catalog in the `initialize` response instructions field (tool counts, top-5 names)

All four consumers need the tool list **before the MCP client's first
`initialize` response** under the current architecture.

### 2.4 Catalog dependency on tool counts

`buildCatalogInstructions()` (`catalog.ts:279`) produces lines of the form:

```
- ibkr (39 tools): pnl, quote, health — read-heavy — e.g. get_pnl, calculate_option_price, …
```

Both the **tool count** (`39 tools`) and the **top-5 representative names**
(`e.g. get_pnl, …`) are derived from `listTools` results stored in
`hub.toolCache`. Without a prior `listTools` call, these values are unknown.

**Key finding:** the catalog instruction block is an optional quality-of-life
hint to the model. It can safely be served with stale or cached data — the model
uses `discover_tools` for resolution and only needs the catalog as orientation.

### 2.5 Passthrough registration dependency

`registerPassthroughTools()` iterates all `registry.getAllTools()` entries with
`routing: "passthrough"`. These entries are only present after
`registry.refresh()` populates the catalog from `hub.toolCache`. If a backend
has not yet been connected, its tools are invisible to the registry and therefore
no passthrough tools are registered for it.

This is a **real constraint** for the default routing mode: if passthrough tools
must be first-class MCP tools visible to the SDK before `connect(transport)`,
they must be registered synchronously before the transport handshake. Lazy
connection removes this guarantee unless passthrough registration is deferred or
made dynamic.

**However**, `execute_code` routing does not require pre-connection — any server
can be called via `mcp.server('name').call(…)` in the sandbox regardless of
whether it connected at startup. The constraint applies only to the subset of
tools routed `passthrough`.

---

## 3. OPTIONS

### Option A — Eager (current)

Connect all backends at startup. Block transport until every child is up or
timed out.

**Pros:**
- Simple, no deferred state.
- Passthrough tools are registered exactly once, before `connect(transport)`.
- Catalog instructions are fully accurate at handshake.

**Cons:**
- Cold-start proportional to the slowest (or most broken) backend.
- Retry churn from dead servers (srv-b: 25+ WARN lines) adds noise.
- 16/22 servers currently failing adds ~3–10 s of dead weight on each startup.

---

### Option B — Pure Lazy (connect on first reference)

Do not connect any backend at startup. Connect when:
- `discover_tools` names a specific server, OR
- `execute_code` references `mcp.server('name')`, OR
- `passthrough_call` names a server.

**Pros:**
- Startup time collapses to ~50–200 ms (only conductor's own static tools +
  `server.connect(transport)` remain).
- Dead backends cause zero startup cost — they fail on first use, not at boot.
- Process startup stays fast even as the server list grows.

**Cons (non-trivial):**
- **Passthrough tool gap.** Passthrough tools are registered at startup from the
  registry. A lazy-connected backend has no tool list, so no passthrough tools
  can be registered for it before `connect(transport)`. MCP SDK does not support
  dynamic tool registration after `connect()` in a well-defined way (the
  capabilities handshake is already done). Mitigation: skip passthrough
  registration for unconnected servers; connect on first `execute_code`
  reference instead. Passthrough is already opt-in; the majority of tools
  default to `execute_code`.
- **Catalog instruction accuracy.** Tool counts and representative names in the
  `initialize` instructions will be `0` or stale for unconnected servers.
  Mitigation: use cached counts from a sidecar (see §3.D), or serve a reduced
  catalog listing servers by name only with `(lazy — call list_servers)`.
- **First-call latency spike.** The first call to any unconnected backend adds
  ~500–2000 ms for the child process to start, stdio handshake, and `listTools`.
  This is invisible on subsequent calls but is a cold-start tax per-backend
  rather than per-process.
- **Concurrency race.** Two simultaneous calls to the same unconnected backend
  could both trigger a connect. Needs a per-server "connecting" lock / promise
  dedup.

---

### Option C — Prewarmed Lazy (recommended hybrid)

Combine lazy-by-default with an explicit priority list of backends that connect
in the background immediately after `connect(transport)` responds. The MCP
client sees a fast initial response; the hot backends are ready within 1–2 s.

**Mechanism:**
1. Start conductor.
2. `hub.initialise()` connects **zero** backends synchronously.
3. `setCatalogInstructions()` uses sidecar-cached tool counts (see §3.D) for
   the catalog, or serves a reduced header-only catalog.
4. `server.connect(transport)` — client receives `initialize` response in
   ~100–200 ms.
5. Background prewarm fires: connect the `priority` list from
   `~/.mcp-conductor.json` concurrently (same `Promise.allSettled` pattern as
   today).
6. Remaining backends connect on first reference.

**Priority list example in conductor config:**
```json
{
  "prewarm": ["ibkr", "tv", "yfinance"],
  "servers": { ... }
}
```

The `prewarm` list is the top-3 hot backends (ibkr: 39 tools, tv: 89 tools,
yfinance: 9 tools). Based on the baseline probe these three connect within
T+1 700 ms from process start. After prewarm, the catalog is refreshed and
emitted as an MCP notification or cached for the next `list_servers` call.

**Passthrough registration for prewarmed servers:**
- If a prewarmed server's background connection completes before any client
  calls arrive (likely — prewarm finishes in ~2 s; a human's first tool call
  takes longer), passthrough tools can be registered before first use.
- The SDK does not prohibit registering tools after `connect(transport)` — it
  prohibits registering capabilities after `connect()`. Tools registered at any
  time are included in subsequent `tools/list` responses. The risk is a race
  window between transport connect and prewarm complete.
- Safe implementation: defer passthrough registration to after prewarm (or
  accept that prewarm-late tools are only available via `execute_code` until a
  `reload_servers` cycle).

---

### Option D — Sidecar Tool-Count Cache

Orthogonal to A/B/C. Persist `{ server: name, toolCount: N, topTools: [...] }`
to a small JSON file in the conductor state directory (e.g.,
`~/.mcp-conductor.cache.json`) after each successful `listTools`. The cache is
loaded at startup to populate the catalog instructions without requiring any
child connection.

**Effect:**
- Catalog instructions in the `initialize` response accurately reflect the last
  known state of each server even under lazy or prewarmed modes.
- Cache entry is refreshed when the server connects and `cacheServerTools()`
  completes.
- Stale risk: if a backend's toolset changes between sessions, the catalog shows
  the previous count until it reconnects. Acceptable — the model uses
  `discover_tools` for resolution.
- File size: 22 servers × ~200 bytes each = ~4 KB. Negligible I/O.

---

### Option E — Daemon-Shared Connections

Covered separately in `14-daemon-mode`. Briefly: a long-lived daemon process
holds all child connections; conductor instances attach to the daemon rather
than spawning children themselves. Startup becomes near-instant regardless of
backend count because connections are never torn down between sessions. This is
the definitive solution but requires architectural work not yet started.

---

## 4. IMPACT

### Startup time

| Mode | Cold start (first session) | Warm start (daemon) |
|------|---------------------------|---------------------|
| Eager (current) | **10 468 ms** | 10 468 ms (no caching) |
| Lazy (Option B) | **~150 ms** | ~150 ms |
| Prewarmed (Option C, top-3) | **~150 ms** (client sees) + 1–2 s background | ~150 ms + background |
| Prewarmed + sidecar cache (C+D) | **~150 ms** with accurate catalog | ~150 ms |

Lazy alone eliminates 10 s of startup cost. The remaining latency is the SDK
`connect(transport)` handshake and static tool registration (~26 calls),
estimated at 100–200 ms.

### First-call latency per backend

| Mode | Already connected | Not yet connected |
|------|------------------|-------------------|
| Eager | 0 ms overhead | n/a — all connected |
| Lazy | 0 ms | 500–2000 ms (process spawn + handshake + listTools) |
| Prewarmed top-3 | 0 ms for hot 3 | 500–2000 ms for cold 19 |

The 500–2000 ms range for an unconnected backend is the child process cold-start
cost. Most backends in this config are Node.js/Python processes. The median from
the baseline probe is ~1 500 ms for Python servers, ~600 ms for Node.js.

### When each strategy wins

| Scenario | Best mode |
|----------|-----------|
| Claude Code session, heavy ibkr/tv usage | Prewarmed (C) — hot backends instant, cold start fast |
| Automation pipeline, all 22 backends needed | Eager (A) — pay the cost once, zero per-call latency |
| Development / short interactive sessions | Lazy (B) — fast restart, tolerate first-call cost |
| Production with daemon (future) | Daemon (E) — best of all worlds |
| 16/22 servers broken (today's reality) | Any non-eager — avoid paying 10 s for servers that will never work |

### Retry churn from dead servers

Under eager mode, the three permanently-broken servers (`srv-b`, `my-server`,
`ansight`) generate 25+ WARN log lines during startup due to reconnect timer
fires within the first 16 s. Under lazy mode, these servers are only attempted
when referenced, eliminating all startup-time churn.

---

## 5. RECOMMENDED PATH

### Phase 1 — Minimum Viable Lazy (MVL)

**Scope:** Single PR, ~80–120 lines changed.

**Changes:**

1. **`src/hub/mcp-hub.ts` — add `initialise(mode)` overload.**
   Accept a `connectMode: 'eager' | 'lazy'` option (default `'eager'` for
   backward compat). In lazy mode, skip `connectionPromises`; instead register
   each server's config in a `pendingConfigs: Map<string, ServerConfig>` map
   without connecting.

2. **`src/hub/mcp-hub.ts` — add `ensureConnected(name)`.**
   Called by `callTool()`, `getServerTools()`, and any path that needs a live
   connection. If the server is in `pendingConfigs`, connect it (deduped via a
   per-server promise stored in a `connectingPromises: Map<string, Promise<boolean>>`
   map), await the result, then proceed.

3. **`src/config/schema.ts` — add `connect_mode` to `ConductorConfig`.**
   ```typescript
   connect_mode?: 'eager' | 'lazy' | 'prewarmed';
   ```

4. **`src/server/mcp-server.ts` — skip registry.refresh() and
   registerPassthroughTools() when lazy.**
   In lazy mode, passthrough registration is deferred to a `reload_servers` call
   after prewarm completes, or simply omitted (tools default to `execute_code`
   path). This is the only non-trivial semantic change: tools previously
   first-class under passthrough routing become execute_code-only until a
   `reload_servers` cycle.

5. **`setCatalogInstructions()` — serve header-only catalog when no tools cached.**
   If `toolCache` is empty (lazy mode, no prewarm yet), emit:
   ```
   mcp-conductor proxies 22 backends. Schemas not yet loaded — call list_servers
   or discover_tools to connect on demand.
   ```

**Expected outcome:** Cold start drops from 10 468 ms to ~150 ms. Zero
regressions for execute_code routing path. Passthrough tools temporarily
unavailable until post-connect.

### Phase 2 — Prewarm Hook (recommended follow-up, same sprint)

1. **Add `prewarm: string[]` to `ConductorConfig`.**
   Servers listed here are connected in the background immediately after
   `server.connect(transport)` returns.

2. **After `transport.connect()`, fire a non-blocking prewarm task:**
   ```typescript
   setImmediate(() => this.prewarmBackgrounds());
   ```
   `prewarmBackgrounds()` calls `hub.ensureConnected(name)` for each entry in
   `prewarm`, then calls `registry.refresh()` and `registerPassthroughTools()`
   for the newly-connected servers, and finally `setCatalogInstructions()` to
   update the catalog (available on the next `list_servers` or `conductor://catalog`
   read).

3. **Sidecar cache (Option D).**
   In `cacheServerTools()`, additionally persist the result to
   `~/.mcp-conductor.cache.json` (debounced, atomic rename write). Load at
   startup to seed `toolCache` before any server connects. This makes the
   catalog instructions accurate even on the first lazy session.

### Phase 3 — Tuning

- Expose `connect_mode: "prewarmed"` in the setup wizard so new users land on
  the best default without manual config edits.
- Add a `--connect-mode` CLI flag to `mcp-conductor-cli` for development
  overrides.
- Track prewarm duration in the metrics collector; surface it in `get_metrics`.

---

## Summary

| Metric | Eager (today) | Lazy MVL | Prewarmed + cache |
|--------|---------------|----------|-------------------|
| Cold start | 10 468 ms | ~150 ms | ~150 ms |
| Catalog accuracy at handshake | Full | Header only | Full (from cache) |
| First call (hot backend) | 0 ms | 500–2000 ms | 0 ms |
| First call (cold backend) | 0 ms | 500–2000 ms | 500–2000 ms |
| Dead server noise | High (25+ WARNs) | None | None |
| Passthrough tools at startup | All | None | Prewarm set only |
| Implementation risk | — | Low | Low–Medium |

**Headline: switching to lazy connect with a 3-server prewarm list reduces cold
start from 10.5 s to ~150 ms with zero regression on the execute_code path, at
the cost of a ~1–2 s window before passthrough tools for the hot set are
available.**
