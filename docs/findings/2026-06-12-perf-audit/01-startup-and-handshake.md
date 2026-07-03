# 01 — Startup & Per-Child Handshake

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## 1. PROBLEM

**Baseline wall time to first tools/list response: 10 468 ms** (from 00-baseline.md §6).

The cost breaks down as follows:

| Phase | Owner | Wall time |
|---|---|---|
| First child connects (rgx, 7 tools) | `hub.connectServer()` | ~1 294 ms |
| Bulk of 22 children finish | `hub.initialise()` Promise.allSettled | ~3 862 ms (T+0 to T+3 862) |
| One child (srv-a) forced to timeout | `connectionTimeoutMs = 10 000 ms` | 10 134 ms |
| First tools/list returns | End of `start()` | 10 468 ms |

The single srv-a timeout is the dominant cost. With the current 10 s timeout the entire startup wall time can never be less than the timeout of the slowest lagging child that does not fail fast.

Secondary problem: 3 permanently-failed servers (srv-b, my-server, ansight) generate noisy retry churn (srv-b: 25+ WARN lines). Each retry costs 5 000 ms before giving up (reconnectDelayMs = 5 000 ms, maxReconnectAttempts = 3). This is background work but contributes to log noise and CPU during the post-startup window.

**If srv-a were dropped to a 2 000 ms timeout, cold startup would fall to ~3 900 ms — a ~6 600 ms improvement (63%).**

---

## 2. EVIDENCE

### 2.1 start() sequential waterfall

File: `src/server/mcp-server.ts`

```
Line 2668: async start(): Promise<void> {
Line 2672:   await this.hub.initialise();           // ← BLOCKS until all children succeed or timeout
Line 2682:   await this.registry.refresh();          // ← reads hub's in-memory toolCache (sync path, ~0 ms)
Line 2683:   applyBuiltInRecommendations(...)        // ← synchronous, ~0 ms for 498 tools
Line 2692:   const conductorCfg = loadConductorConfig(); // ← sync disk read #3 in startup path
Line 2706:   registerPassthroughTools(...)           // ← synchronous loop, ~0 ms
Line 2727:   this.setCatalogInstructions();           // ← sync string concat, ~0 ms
                                                 // ↑ all of 2682–2727 runs AFTER hub completes
Line 2904:   await this.bridge.start();              // ← TCP bind, ~1–2 ms
Line 2918:   await this.server.connect(transport);   // ← stdio handshake, ~1–2 ms
```

Everything from line 2682 onward is effectively zero-cost; the entire startup time budget lives inside `hub.initialise()`.

### 2.2 hub.initialise() — parallel connect with serial-equivalent timeout ceiling

File: `src/hub/mcp-hub.ts`

```javascript
// Line 119–125
const connectionPromises = filteredServers.map((name) => {
  const serverConfig = serverMap[name];
  if (!serverConfig) return Promise.resolve(false);
  return this.connectServer(name, serverConfig);       // ← all 22 spawned concurrently
});

await Promise.allSettled(connectionPromises);          // ← waits for the LAST one to settle
```

Conclusion: **connect is parallel** — all 22 children are spawned simultaneously via `Promise.allSettled`. But `allSettled` does not return until every promise resolves or rejects. A single child with a 10 s timeout therefore imposes a 10 s floor on the whole `hub.initialise()` call.

### 2.3 Per-child timeout — recently added, fixed at 10 000 ms

File: `src/hub/mcp-hub.ts`

```javascript
// Line 69–80 (DEFAULT_HUB_CONFIG)
connectionTimeoutMs: 10000,   // was 30 s; comment says reduced, but 10 s still dominates

// Line 315–323 (connectServer, the actual race)
const timeoutMs = this.config.connectionTimeoutMs;
await Promise.race([
  client.connect(transport),
  new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(new Error(`Server '${name}' handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs)
  ),
]);
```

The comment in `DEFAULT_HUB_CONFIG` (line 73) says "was 30 s; reduced to 10 s" — this was added recently. The config key is `connect_timeout_ms` in `ConductorConfig` (schema.ts line 154), wired at constructor time (mcp-server.ts lines 275–276). The user can override it in `~/.mcp-conductor.json` but the default is 10 000 ms.

### 2.4 listTools() — called exactly once per child, NOT repeated at registry.refresh()

File: `src/hub/mcp-hub.ts`

```javascript
// Line 408–427: cacheServerTools — called from connectServer line 330
private async cacheServerTools(name: string, client: Client): Promise<void> {
  const response = await client.listTools();   // ← single network call per child per connect
  const tools = response.tools || [];
  this.toolCache.set(name, tools);             // ← stored in-memory Map
  ...
}
```

File: `src/registry/registry.ts`

```javascript
// Line 98–107: refresh()
async refresh(): Promise<void> {
  const servers = this.options.bridge.listServers();
  await Promise.all(
    servers.filter((s) => s.status === 'connected')
          .map((s) => this.refreshServer(s.name))
  );
}

// Line 122: refreshServer reads from bridge.getServerTools() — NOT client.listTools()
rawTools = this.options.bridge.getServerTools(serverName);
```

File: `src/hub/mcp-hub.ts`

```javascript
// Line 590–592: getServerTools reads the in-memory cache
getServerTools(serverName: string): Tool[] {
  return this.toolCache.get(serverName) || [];   // ← no network call
}
```

`registry.refresh()` issues **zero** additional `listTools()` calls. It reads the hub's in-memory `toolCache`. The only place `listTools()` is called is `cacheServerTools()` during initial connect — once per child.

### 2.5 Per-child handshake sequence and cost estimate

Inside each `connectServer()` call:

| Step | Code location | Estimated cost |
|---|---|---|
| Spawn child process (stdio) | SDK `StdioClientTransport` | 20–100 ms (process fork) |
| MCP `initialize` handshake | `client.connect(transport)` | 50–500 ms (child startup time) |
| `client.listTools()` | `cacheServerTools` line 410 | 5–50 ms (round-trip on same stdio) |
| Total per fast child | | 75–650 ms observed (baseline: 1 294 ms for first, ~2 600 ms avg) |
| srv-a (timed out) | | 10 000 ms (full timeout consumed) |

The MCP `initialize` exchange happens inside `client.connect()`. The SDK sends `initialize`, waits for the server's `initialize` response, then sends `notifications/initialized`. `listTools()` is a second separate round-trip over the same stdio pipe, but at this point the process is warm so it typically completes in under 50 ms.

### 2.6 Redundant loadConductorConfig() calls in startup path

The conductor config JSON is read from disk at:

1. `mcp-server.ts:275` — in the constructor (sync)
2. `mcp-hub.ts:150` — inside `discoverServers()` (sync)
3. `mcp-server.ts:2692` — inside `start()` for per-server routing overrides (sync)
4. `mcp-server.ts:700` — inside `setCatalogInstructions()` (sync)
5. `mcp-hub.ts:774` + `mcp-hub.ts:792` — in `reload()` paths (not startup)

That is **4 synchronous `readFileSync` calls** against the same `~/.mcp-conductor.json` file during a single cold start. With a 22-server config this file may be a few KB but the repeated reads are architecturally unnecessary. They are not on the critical path (all happen before or after the async hub init) but they contribute ~1–5 ms total.

### 2.7 No snapshot loading at startup

`ToolRegistry.loadSnapshot()` is never called in `start()` — there is no snapshot-based warm start. Every cold start re-issues `listTools()` to every child, even if the catalog has not changed since the last session.

### 2.8 registerPassthroughTools() — synchronous, bounded by tool count

File: `src/server/passthrough-registrar.ts` lines 216–352: a synchronous `for` loop that calls `mcpServer.registerTool()` for each passthrough-annotated tool. With the default routing table (only 3 servers have passthrough tools: github/2, filesystem/2, brave-search/1) this registers at most ~5 tools. Even if all 498 backend tools were passthrough this loop runs in under 5 ms. Not a bottleneck.

---

## 3. OPTIONS

### Option A — Aggressive per-child timeout (2 000 ms default)
**WHAT:** Reduce `DEFAULT_HUB_CONFIG.connectionTimeoutMs` from 10 000 ms to 2 000 ms. Override available via `connect_timeout_ms` in `~/.mcp-conductor.json`.

**WHY:** The baseline shows all healthy children connect within 3 862 ms; the 10 s timeout is only hit by srv-a (a non-essential test server). A 2 000 ms ceiling lets the 19 healthy servers connect (first one at 1 294 ms, last healthy at ~3 862 ms — but only srv-a reached the old timeout). With a 2 s ceiling, srv-a fails at 2 000 ms, hub settles at ~3 900 ms.

Impact estimate: **6 500 ms reduction** on this config. On a healthy config (no laggards) the impact is zero.

**RISK:** Low. Any real child that needs more than 2 s to start would be marked failed and excluded from the catalog. The user can raise `connect_timeout_ms` in config for slow-but-healthy children. The existing timeout comment even says the reduction from 30 s was intentional.

**EFFORT:** S (one line change in `DEFAULT_HUB_CONFIG`).

---

### Option B — Tiered startup timeout: fast floor + background completion
**WHAT:** Add a `startup_timeout_ms` (e.g. 3 000 ms) that caps how long `hub.initialise()` blocks `start()`. Children that have not connected by `startup_timeout_ms` continue connecting in the background; when they connect, the registry auto-updates (the `serverConnected` event wiring in `ToolRegistry` constructor at lines 60–73 already handles this).

**WHY:** `Promise.allSettled` waits for every child. A tiered approach would let `start()` return as soon as the "fast" cohort is done, while slow children self-complete later. The `setCatalogInstructions()` call at line 2727 would need to run again once the slow children join — the `reload_servers` handler (mcp-server.ts:1386) already does this.

**RISK:** Medium. The passthrough registrar runs after `hub.initialise()` (B6 invariant). If slow children are passthrough-annotated, their tools would not be registered as first-class MCP tools until after transport.connect(). Dynamically registering tools after the SDK transport is live is not currently supported. This means slow children would only be accessible via `execute_code`, not via auto-registered passthrough tools.

**EFFORT:** M. Requires a new config field, changes to `initialise()`, and a post-connect hook to re-run `registerPassthroughTools()` for newly-arrived children (SDK support for post-connect tool registration needs verification).

---

### Option C — Deferred/lazy connect (connect on first reference)
**WHAT:** Do not connect any child servers at startup. Instead, spawn a connection to `<server>` on the first `callTool(server, ...)` call that targets it.

**WHY:** If most user sessions use only a subset of the 22 configured servers (e.g. 3–4 active ones), 18 servers are connected at startup and never used. Lazy connect amortizes this cost to actual usage.

**RISK:** High. The first call to any previously-unused server would stall for 1–2 s (child spawn + handshake). Claude would experience unexpected latency on first use. The catalog/instructions shown at initialization would be empty or stale — Claude would have no idea which servers are available. Passthrough tool registration (which must happen pre-transport-connect) cannot be lazy.

**EFFORT:** L. Requires redesigning the hub, catalog, and passthrough registration ordering.

---

### Option D — Snapshot-based warm start (skip listTools() on cached catalog)
**WHAT:** Call `registry.loadSnapshot()` in `start()` before `hub.initialise()`. If a valid snapshot exists, skip `cacheServerTools()` for servers present in the snapshot. Add a config flag `skip_list_tools_on_startup: true` for users with stable catalogs.

**WHY:** `listTools()` is an extra round-trip per child (50–200 ms each × 22 children). With a warm snapshot, 22 × ~100 ms ≈ 2 200 ms could be skipped. The tools data is already in the snapshot from the previous session.

**RISK:** Medium. Stale catalogs: if a backend server adds or removes tools between sessions the snapshot is wrong. Fix: do an async background re-fetch after startup and emit `toolsCached` events to update the registry. The B6 invariant is safe as long as the snapshot-loaded tools are used for initial passthrough registration; any background corrections come after transport.connect() and would be apply only to `execute_code` callers.

**EFFORT:** M. `loadSnapshot()` already exists (registry.ts line 306). The hub needs a `skipListTools` flag in `cacheServerTools`, wired from a config option. Background reconciliation needs care.

---

### Option E — Connection pre-warming via the conductor daemon
**WHAT:** The conductor daemon (already exists at `src/daemon/`) could hold persistent connections to all configured child servers and export them to new conductor process instances via IPC. Cold start would attach to pre-warmed connections rather than spawning new ones.

**WHY:** The per-child `initialize` handshake + `listTools()` cost (75–650 ms per child × 22 = 1 650–14 300 ms) would collapse to near-zero for a process that inherits connections.

**RISK:** High. MCP stdio connections are not shareable across processes without a proxy layer. The daemon would need to become a multiplexing proxy (already partially implemented in `src/bridge/pool.ts`), but the SDK `StdioClientTransport` owns the child process and its stdio FDs — these cannot be handed off cross-process. A socket-based approach (converting stdio children to TCP) would work but is a significant architecture change.

**EFFORT:** L. Requires fundamental transport architecture change.

---

### Option F — Eliminate redundant loadConductorConfig() calls
**WHAT:** Load the conductor config once in the constructor, store as `this.conductorConfig`. Pass it as a parameter to `discoverServers()` and use the already-loaded value in `start()` instead of reloading.

**WHY:** 4 redundant `readFileSync` calls (each involves a `findConductorConfig()` which itself calls `existsSync` on 2 paths). Eliminates ~6 sync filesystem operations from the critical path.

**RISK:** None. The config is not expected to change between constructor and `start()`.

**EFFORT:** S. Pure refactor, no behavior change.

---

### Option G — Reduce reconnect attempts for permanently-failed servers
**WHAT:** Add a `max_reconnect_attempts: 0` config option (or `auto_reconnect: false` at global level) to suppress retry churn for servers that are known to be permanently unavailable.

**WHY:** The 3 permanently-failed servers (srv-b, my-server, ansight) each attempt 3 reconnects at 5 000 ms intervals. This generates 25+ WARN log lines and 3 × 3 × 5 000 = 45 000 ms of timers running in the background. The actual CPU cost is negligible, but the log noise obscures real signal.

**RISK:** None.

**EFFORT:** S. Already configurable via `autoReconnect: false` at the hub level; needs per-server support or a documented global override.

---

### Option H — Parallel registry.refresh() already done, but post-hub only
**WHAT:** `registry.refresh()` (mcp-server.ts:2682) already uses `Promise.all()` internally (registry.ts:100). However, it runs after `hub.initialise()` completes. Consider folding it into the hub's `serverConnected` event (already wired in `ToolRegistry` constructor lines 60–73 via the `onConnect` handler).

**WHY:** The `serverConnected` event fires for each child as it connects during `hub.initialise()`. `ToolRegistry` already subscribes to this event and calls `refreshServer()` per child. This means by the time `hub.initialise()` resolves, the registry is already populated via the event handler. The explicit `await this.registry.refresh()` at line 2682 is therefore partially redundant — it will find all tools already in the catalog and simply re-emit change events.

**RISK:** Low. Verify that the `onConnect` handler fires before `connectServer()` returns. If it does, the explicit `refresh()` call can be eliminated (or reduced to a no-op guard).

**EFFORT:** S. Audit the event ordering; if confirmed redundant, remove the explicit call.

---

## 4. IMPACT

Adopting Option A (2 000 ms timeout) alone on the current 22-server config:

| Metric | Before | After (A only) |
|---|---|---|
| srv-a timeout contribution | 10 000 ms | 2 000 ms |
| Total hub.initialise() wall time | ~10 134 ms | ~3 900 ms (last healthy child + 2 000 ms overlap) |
| Cold startup (tools/list response) | 10 468 ms | **~3 900 ms** |
| Reduction | — | **~6 500 ms (62%)** |

Adding Option D (snapshot warm start, removes 22 × listTools() calls):

| Metric | After A | After A+D |
|---|---|---|
| listTools() per child | 1 × ~100 ms avg | 0 ms (cache hit) |
| Total savings from D | — | ~800–2 200 ms |
| Projected startup | ~3 900 ms | **~2 500–3 100 ms** |

Adding Option F (deduplicate config reads) adds ~5 ms — negligible but free.

Combined realistic target with A + D + F: **~2 500–3 000 ms** (from 10 468 ms baseline).  
Conservative target with A alone: **~3 800–4 200 ms**.

---

## 5. RECOMMENDED PATH

**Immediate (this sprint): Option A — drop `connectionTimeoutMs` default to 2 000 ms.**

### Rationale

The 10 s timeout is the only reason cold startup takes 10 s. All 19 healthy servers connect within 4 s. A 2 s ceiling correctly classifies srv-a as "too slow to be useful at startup" and continues without it. The existing config override (`connect_timeout_ms` in `~/.mcp-conductor.json`) lets users raise it for known-slow-but-healthy children.

### Concrete edits

**File:** `src/hub/mcp-hub.ts`

Line 76 — change the default:
```typescript
// BEFORE
connectionTimeoutMs: 10000,

// AFTER
connectionTimeoutMs: 2000,
```

Update the comment at line 73–75 to reflect:
```typescript
// Per-child connect timeout. 2 s is sufficient for locally-installed MCP
// servers. Raise via connect_timeout_ms in ~/.mcp-conductor.json for
// servers with longer startup times (e.g. remote proxies, heavy runtimes).
connectionTimeoutMs: 2000,
```

**File:** `src/config/schema.ts`

Line 154 — update the JSDoc comment to reflect the new default:
```typescript
/**
 * Maximum time to wait for an individual child server's stdio handshake
 * before marking it as failed and continuing startup. Default: 2000 ms.
 * Raise to 5000–10000 for remote or heavy-runtime children.
 */
connect_timeout_ms?: number;
```

**File:** `src/server/mcp-server.ts`

Line 276 — update the fallback to match:
```typescript
const connectTimeoutMs = conductorCfgForHub?.connect_timeout_ms ?? 2000;
```

### Follow-on (next sprint): Option D — snapshot warm start

After the timeout fix ships, implement `ToolRegistry.loadSnapshot()` call in `start()`:

```typescript
// src/server/mcp-server.ts, inside start(), before hub.initialise()
await this.registry.loadSnapshot();   // no-op if no snapshot or stale
```

And save a snapshot on clean shutdown:

```typescript
// src/server/mcp-server.ts, inside stop(), after hub.shutdown()
await this.registry.saveSnapshot();
```

This requires `snapshotPath` to be wired into the `ToolRegistry` constructor options — currently it is set to `''` (mcp-server.ts line 289 implies default). Add a default path:

```typescript
// mcp-server.ts constructor, ToolRegistry init
this.registry = new ToolRegistry({
  bridge: this.hub,
  snapshotPath: join(homedir(), '.mcp-conductor', 'tool-catalog.snapshot.json'),
});
```

The snapshot will eliminate the `listTools()` round-trips on the second and subsequent cold starts, saving ~800–2 200 ms depending on child count.

### Option F — free cleanup (fold into any PR)

In `mcp-server.ts`, load `conductorCfg` once near the top of `start()` and pass it through to `setCatalogInstructions()` and the hub constructor rather than reloading it 4 times. This is a pure refactor with no behavior change.

---

*Byte count will be reported by the calling agent.*
