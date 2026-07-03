# 14 — Daemon Mode: Shared Persistent Conductor

Authored: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## 1. PROBLEM

Every Claude window (Claude Code session, Claude Desktop conversation) that uses
mcp-conductor **spawns its own fresh conductor process**. That process must:

1. Read and parse `~/.mcp-conductor.json` (22 servers)
2. Spawn or connect to each child MCP server via `StdioClientTransport`
3. Perform the JSON-RPC `initialize` / `tools/list` handshake with each child
4. Populate `toolCache`, `registry`, `catalogInstructions`
5. Register 26+ meta-tools and all passthrough tools
6. Respond to the MCP client's first `tools/list`

**Measured cost of steps 1–6: 10 468 ms** (baseline probe, `00-baseline.md`).

Open two Claude Code tabs simultaneously: you pay that cost twice. Open three: three times. A developer working across terminals + a web browser tab + an agent orchestration window easily triggers four or more concurrent conductors. Each one holds its own child processes, its own in-memory `toolCache`, its own metrics state, its own `SharedKV` snapshot — nothing shared.

The pain compounds further because child MCP servers (ibkr, tv, taskmaster-ai, etc.) are themselves stateful processes with their own warm-up cost and connection limits. Multiple conductor instances competing for the same child server connection can produce authentication races, rate-limit collisions, and duplicate process trees.

The underlying question: **is there a design where the expensive startup work is paid once and shared?**

---

## 2. EVIDENCE

### 2.1 Where the 10.5 s actually goes

From the baseline probe (`00-baseline.md §6`):

```
T+0 ms         process start, Node.js VM init, module load
T+~400 ms      config parse, MCPHub / MCPExecutorServer construction
T+1 294 ms     rgx: first child connected + listTools (7 tools)
T+1 686 ms     tv: connected + listTools (89 tools)
T+2 305–3 862  alphavantage, yfinance, afr, sequential-thinking, ibkr,
               filesystem, playwright, github, memory, context7,
               brave-search, clickup, chrome-devtools, serena
T+5 628 ms     taskmaster-ai: first attempt (slow Python server)
T+10 134 ms    srv-a: handshake timeout fires (10 s ceiling)
T+10 468 ms    tools/list returned to caller
```

The **critical path** is: spawn 22 children concurrently, wait for every
`Promise.race([client.connect(), timeout])`, call `cacheServerTools()` per child
(one `listTools` RPC per), then `registerPassthroughTools()`.

Node.js is single-threaded so all 22 spawns happen in the same event loop. The
concurrent spawn batch is fast (~400 ms); the tail is completely dominated by
**the slowest single child** (`srv-a` → 10 000 ms timeout).

### 2.2 The daemon infrastructure already exists

`src/daemon/` contains a complete implementation:

| File | Lines | Role |
|------|-------|------|
| `server.ts` | 589 | `DaemonServer` — Unix socket + optional TCP, HMAC-SHA256 auth, KV, locks, pub/sub |
| `client.ts` | 386 | `DaemonClient` — challenge-response auth, RPC, KV/lock/subscribe API |
| `shared-kv.ts` | 257 | `SharedKV` — in-memory store, TTL, disk persistence (~/.mcp-conductor/kv/) |
| `shared-lock.ts` | ~180 | `SharedLock` — in-process distributed locks |
| `discovery.ts` | 142 | `TailscaleDiscovery` — peer IP resolution via `tailscale status --json` |
| `sandbox-api.ts` | ~80 | `mcp.shared.*` surface injected into sandbox workers |
| `index.ts` | 20 | barrel export |

`src/cli/daemon.ts` (278 lines) provides the CLI:
- `daemon start` — detached spawn, PID file, socket wait
- `daemon stop` — SIGTERM + SIGKILL fallback
- `daemon status` — live stats via `client.ping() + stats()`
- `daemon logs` — tail `~/.mcp-conductor/daemon.log`

`src/bin/cli.ts` wires up `registerDaemonCommands()` and has a
`--daemon-server` flag path.

**The current daemon is a KV/lock/pubsub side-car, not a conductor broker.** It
exists for inter-agent coordination (sandbox `mcp.shared.*`). Its socket is at
`~/.mcp-conductor/daemon.sock`.

The daemon does **not** currently:
- Hold child MCP server connections
- Broker MCP tool calls from multiple conductor instances
- Route `tool.call` RPCs (the `case 'tool.call'` in `server.ts:562` throws
  `'tool.call not implemented in daemon v3.0 (agents use direct mode)'`)

### 2.3 The daemon multi-agent benchmark

`docs/benchmarks/stress/daemon-multi-agent-2026-06-12.json`:

```json
{
  "suite": "D1 — daemon-multi-agent-storm",
  "sustainedMs": 30000,
  "scenarios": [
    { "clientCount": 5,  "successRate": 1, "totalOps": 77812,   "heapUsedMbAfter": 13 },
    { "clientCount": 10, "successRate": 1, "totalOps": 35833,   "heapUsedMbAfter": 18 },
    { "clientCount": 25, "successRate": 1, "totalOps": 546250,  "heapUsedMbAfter": 40 },
    { "clientCount": 50, "successRate": 1, "totalOps": 240300,  "heapUsedMbAfter": 49 }
  ]
}
```

The daemon achieves **100% success rate under 50 concurrent clients** with only
49 MB heap at peak. These numbers are for KV/lock ops (the current scope) — not
tool proxying — but they confirm the socket server and connection management are
solid. Contrast May 2026 numbers (470 K ops at 5 clients vs. 77 K in June) — the
June figure likely reflects a test parameter change, not regression; both show
100% success.

The daemon socket is **production-hardened** per commit history: HMAC auth (B11),
auth timeout to prevent FD exhaustion (CRIT-3), buffer cap at 10 MB (B2), stale
socket detection (B9), path traversal guard (B4), lock orphan cleanup on
disconnect.

### 2.4 State that currently lives per-conductor instance

When reasoning about what a daemon-then-broker architecture must share vs.
isolate, these are the per-instance state objects in `MCPExecutorServer`:

| State | Type | Share? | Notes |
|-------|------|--------|-------|
| `hub` (MCPHub) | child connections + toolCache | YES | This is the expensive shared resource |
| `registry` (ToolRegistry) | in-memory tool metadata | YES, derived from hub |
| `catalogInstructions` | string, injected into initialize | YES, derived from hub |
| `currentMode` (`ExecutionMode`) | enum field | NO | Per-window preference |
| `compareMode` | boolean | NO | Per-window toggle |
| `diagMode` (via `getDiagMode()`) | module-global in diag-mode.ts | NO (currently process-global) |
| `metricsCollector` (MetricsCollector) | session stats | NO (per-session) |
| `modeHandler` (ModeHandler) | counters for auto-mode | NO (per-session) |
| `cache` (CacheLayer) | LRU + disk CBOR | Disk layer YES, memory layer optional |
| `gateway` (ReliabilityGateway) | circuit breaker state | Arguable — could share CB state |
| `skills` (SkillsEngine) | loaded skills | Read-only → sharable |

**The dominant shared resource is the MCPHub**: child processes, their stdio
transports, and their listTools caches. Everything else is either
per-session state (mode, diag, metrics) or derived data that rebuilds instantly
from the hub.

---

## 3. OPTIONS

### Option A — Full Daemon-Then-Broker (Daemon owns the Hub)

**Architecture:**

```
Claude Code window 1 ─┐
Claude Code window 2 ─┤──► stdio ──► MCPExecutorServer (thin)
Claude Code window 3 ─┘                    │
                                     Unix socket
                                           │
                                  DaemonBroker process
                                  ├── MCPHub (shared)
                                  │     ├── child: ibkr  [stdio]
                                  │     ├── child: tv    [stdio]
                                  │     └── child: ...22 servers
                                  ├── ToolRegistry
                                  ├── CacheLayer (shared memory LRU)
                                  └── SharedKV / SharedLock (existing)
```

Each Claude window spawns a **thin conductor** process (stdio MCP server). The
thin conductor delegates all hub operations to the daemon via a new
`BrokerClient` that replaces direct `MCPHub` method calls.

**Warm startup path:**
1. Claude spawns thin conductor (Node.js module load: ~200 ms)
2. Thin conductor connects to existing daemon socket (Unix socket connect: <1 ms)
3. Thin conductor calls `broker.getToolList()` — daemon returns cached registry
   data (one IPC round-trip: <5 ms)
4. Thin conductor registers meta-tools + passthrough tools
5. `server.connect(transport)` — responds to Claude's `initialize`

**Total warm startup: ~300 ms** (down from 10 468 ms).

**Cold startup** (daemon not running, or first ever start):
1. First thin conductor detects no socket or stale socket
2. Thin conductor auto-starts daemon as detached process
3. Daemon connects all children (pays the 10 468 ms cost once)
4. Thin conductor waits for daemon to signal readiness
5. Proceeds as warm startup path

**Session state isolation per Claude window:**
The thin conductor process still owns:
- `currentMode`, `compareMode`, `diagMode` (per-window prefs)
- `metricsCollector`, `modeHandler` (per-session stats)
- The MCP SDK `McpServer` + `StdioServerTransport` (these are inherently per-session)

The daemon owns:
- `MCPHub` with all child connections
- `ToolRegistry` (shared, read-mostly with per-server routing annotations)
- `CacheLayer` shared disk layer; memory LRU can be per-instance or shared
- `SharedKV` / `SharedLock` (already there)

**Routing annotations (per-server routing overrides) are shared** — they come
from `~/.mcp-conductor.json` and are the same for all sessions. The only case
where isolation matters is if a user calls `set_mode` or `set_compare_mode` in
one window and does not want that to bleed into another. Both of those are
already in-process per-session; the daemon never touches them.

**Tool call proxying:**
When a thin conductor's `execute_code` sandbox calls
`mcp.server('ibkr').call('get_pnl', {...})`, the call currently routes to
`MCPHub.callTool()` which writes to the child's stdio transport directly.
Under the daemon model, `MCPHub.callTool()` is inside the daemon process — the
thin conductor must proxy the call over the broker socket.

This adds one Unix socket round-trip per tool call. Measured overhead: Unix
domain socket RTT on macOS is typically 0.05–0.3 ms for small payloads. At 100
calls/s (benchmark ceiling is 155 RPS) this adds 5–30 ms/s of latency. For
interactive use (1–5 calls/s) it is imperceptible.

**Complexity:**
- New `BrokerProtocol` on top of `DaemonServer` dispatch (extend `case` switch)
- New `BrokerClient` wrapper over `DaemonClient` (exposes `callTool`,
  `listServers`, `getToolList`, `reloadServers`)
- Thin conductor wires `MCPHub`-shaped interface to `BrokerClient`
- Daemon auto-start logic in thin conductor when socket absent
- `tool.call` dispatch in `DaemonServer` (the stub already exists at line 562)
- Lifecycle plumbing: `daemon start` needs to wait for hub.initialise() completion
  before accepting broker connections to prevent a race where a thin conductor
  connects before backends are ready

---

### Option B — Daemon Caches Only, Each Conductor Owns Its Hub

**Architecture:**

```
Claude Code window 1 ─► MCPExecutorServer (full, own MCPHub)
Claude Code window 2 ─► MCPExecutorServer (full, own MCPHub)

                              Both connect to ↓
                          DaemonServer (existing role)
                          ├── SharedKV (session cross-talk)
                          ├── SharedLock
                          └── NEW: ToolListCache
                                   └── ~/.mcp-conductor/tool-cache.json
```

Each conductor instance still owns its own `MCPHub` and child connections. The
daemon adds a **ToolListCache** service: after each `cacheServerTools()` the
instance pushes the result to the daemon, which persists it to disk. On next
startup, the conductor fetches the cache from the daemon (or directly from disk)
before calling `hub.initialise()`, allowing the catalog to be served immediately
while connections proceed in the background.

This does **not** eliminate the 10.5 s startup cost for each new process — it
only makes the catalog accurate at handshake time under lazy-connect mode (see
`06-lazy-vs-eager-connect.md` Option D). The startup cost is paid N times for N
windows.

**When this makes sense:** As a companion to lazy-connect (finding 06). The
sidecar cache makes the catalog accurate at handshake time (tool counts, top-5
names) without requiring a completed connection. Complexity: very low.

---

### Option C — Hybrid: Daemon Holds Connections, Thin Conductors Re-use

Same as Option A but with a softer fallback: if the daemon is not running, the
thin conductor falls back to owning its own `MCPHub` (current behaviour). The
broker client and full hub code coexist in the same binary.

**Feature flag in `~/.mcp-conductor.json`:**
```json
{
  "daemon_mode": "broker"  // or "standalone" (current default)
}
```

On startup, the thin conductor checks `daemon_mode`. If `broker`, it connects to
the socket. If the socket is absent, it either fails with a helpful message or
auto-starts the daemon. If `standalone`, it behaves as today.

This gives a migration path: ship the daemon broker behind a flag, iterate on
the protocol, flip the default to `broker` once stable.

---

### Option D — Per-Machine Scope (Recommended for Initial Implementation)

All three options above are **per-user** (socket at `~/.mcp-conductor/daemon.sock`)
which is also effectively **per-machine** for single-user workstations. This is
the correct default:

- Unix socket permissions (`chmod 0600`) already restrict to the owning user
- Multiple users on the same machine would each have their own daemon
- Multiple machines (Mac Mini + MacBook Pro in the machines table) each run their
  own daemon; cross-machine is not needed for the core use case
- Tailscale TCP path in `DaemonServer` already supports cross-machine if needed
  (optional, not in initial scope)

**Per-project scope** would require a socket per project directory
(`$PWD/.mcp-conductor.sock` or a hash of `$PWD`). This would prevent sharing
across two terminal windows open to the same project. There is no use case for
project-scoped daemon isolation given that tool routing config is global.

---

## 4. STATE ISOLATION: What Each Claude Window Must Own

### 4.1 Per-session state (never shared)

These live in the thin conductor process and are never visible to other windows:

| State | Why isolated |
|-------|-------------|
| `currentMode` (`ExecutionMode`) | User A might be in `passthrough` while User B is in `execution`. Different windows = different contexts. |
| `compareMode` | Benchmark toggle; should not affect a colleague's parallel session. |
| `diagMode` (process-global in `diag-mode.ts`) | Per-call overhead toggle; must be per-session. Currently implemented as a module-global which is fine because each process is its own instance. Under the broker model the thin conductor process still has its own `getDiagMode()`. |
| `metricsCollector` (session tokens saved, call counts) | Session stats are per-session by definition. |
| `modeHandler` (auto-mode counters) | Tracks call patterns for the current conversation; must restart per session. |
| The MCP SDK `McpServer` + `StdioServerTransport` | These are inherently one-to-one with a Claude window. The MCP protocol is per-process. |
| Tool results in transit | In-flight RPC calls are owned by the thin conductor's request lifecycle. |

### 4.2 Safely shared via daemon

| State | Sharing model |
|-------|---------------|
| `MCPHub` child connections | One connection per child server, shared by all thin conductors |
| `ToolRegistry` (tool schemas, routing annotations) | Read-mostly; annotations come from config, not runtime mutation. Write on `reload_servers` (need daemon-side lock). |
| `CacheLayer` disk tier | Already disk-persisted; any process can read it. Under daemon model, the LRU memory tier lives in the daemon. |
| `SharedKV` / `SharedLock` | Already in daemon. |
| Catalog instructions string | Derived from registry; daemon computes once, thin conductors fetch on connect. |
| Skills definitions | Read-only from disk; safe to share. |

### 4.3 The `set_mode` / `set_compare_mode` / `set_diag_mode` tools

All three toggle state on the **current conductor instance**. Under the thin
conductor model, these mutations still happen in-process in the thin conductor
that received the call. No broadcast to other windows. This is the right
behaviour — a `set_mode passthrough` in one Claude Code window should not bleed
into a parallel window running a different task.

If cross-window mode sync is ever desired (e.g., a global "turn off compare mode
everywhere") it can be implemented via `SharedKV.set('global.compareMode', true)`
and read by thin conductors on each tool call. This is a separate feature, not a
requirement for the initial daemon broker.

---

## 5. LIFECYCLE: launchd, systemd, autostart

### 5.1 macOS — launchd

The preferred way to ensure the daemon starts at login and stays alive:

**`~/Library/LaunchAgents/com.darkiceinteractive.mcp-conductor.plist`:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.darkiceinteractive.mcp-conductor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/dist/index.js</string>
    <string>--daemon-server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/.mcp-conductor/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/.mcp-conductor/daemon.log</string>
</dict>
</plist>
```

`launchctl load ~/Library/LaunchAgents/com.darkiceinteractive.mcp-conductor.plist`
`launchctl unload ~/Library/LaunchAgents/com.darkiceinteractive.mcp-conductor.plist`

`KeepAlive: true` means launchd respawns the daemon if it crashes. Existing
`daemon.sock` probe logic (`_probeSocketLiveness`) already handles stale socket
cleanup.

The `mcp-conductor-cli daemon start` command already provides a manual start
path. The launchd plist is generated by the setup wizard (`mcp-conductor-cli
setup`) — no new CLI surface needed for MVP.

### 5.2 Linux — systemd (user session)

**`~/.config/systemd/user/mcp-conductor.service`:**
```ini
[Unit]
Description=MCP Conductor Daemon
After=default.target

[Service]
ExecStart=/path/to/node /path/to/dist/index.js --daemon-server
Restart=always
RestartSec=3
StandardOutput=append:/home/USERNAME/.mcp-conductor/daemon.log
StandardError=append:/home/USERNAME/.mcp-conductor/daemon.log

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable mcp-conductor
systemctl --user start mcp-conductor
systemctl --user status mcp-conductor
```

`Restart=always` mirrors launchd `KeepAlive`.

### 5.3 Windows — Task Scheduler

Windows does not have launchd or systemd. The closest equivalent for a per-user
background service is Task Scheduler with a trigger on "At log on":

```
Action: Start a program
Program: node.exe
Arguments: C:\path\to\dist\index.js --daemon-server
Trigger: At log on (current user)
Settings: Run whether user is logged on or not = No (interactive logon required)
          If the task is already running, do not start a new instance
```

Alternatively, `mcp-conductor-cli daemon start` on Windows spawns a detached
Node.js process (`detached: true, stdio: 'ignore'`). This survives terminal
closure but not logoff. For the current user base (macOS primary, Linux secondary
per machine table) Windows autostart is low priority.

### 5.4 Auto-start from thin conductor (no user action required)

The lowest-friction approach for initial rollout:

When the thin conductor checks for the broker socket and finds nothing, it
auto-starts the daemon inline and waits:

```typescript
// In MCPExecutorServer.start(), broker mode:
const brokerClient = new BrokerClient();
const connected = await brokerClient.tryConnect(200); // 200 ms timeout

if (!connected) {
  logger.info('Daemon not running — starting...');
  await spawnDaemonAndWait({ maxWaitMs: 15_000 }); // waits for socket to appear
  await brokerClient.connect();
}
```

The first window of the day pays the 15 s daemon cold start. All subsequent
windows skip it. This is equivalent to the current behaviour except the cost is
paid once instead of per-window.

**Edge case:** Two Claude windows open simultaneously on a cold machine. Both
detect no socket. Both attempt to start the daemon. `DaemonServer.start()` has
the stale-socket probe (`_probeSocketLiveness`) which already handles this: if a
race causes both to attempt binding the same socket, one will discover the other
is live (within the 200 ms probe window) and abort cleanly with
`'another daemon is already listening'`. The loser falls back to connecting as a
client.

---

## 6. HEALTH MONITORING: Child Backend Respawn Without Disconnecting Claude

### 6.1 Current behaviour

`MCPHub.handleDisconnection()` fires when `transport.onclose` or `transport.onerror`
triggers. It schedules a `connectServer()` retry after `reconnectDelayMs` (5 s
default) up to `maxReconnectAttempts` (3). While reconnecting, calls to the
affected server fail with an error. This is correct for per-process operation.

### 6.2 Under daemon broker

The daemon owns the `MCPHub`. When `ibkr` disconnects unexpectedly:
1. `MCPHub.handleDisconnection('ibkr')` fires in the daemon process
2. Daemon schedules reconnect (same 5 s timer)
3. **Claude windows are unaffected** — they see the next `callTool('ibkr', ...)` 
   fail with a transient error, the same as today

The key improvement: reconnect happens **once** in the daemon rather than
independently in every thin conductor. A crash of `taskmaster-ai` does not
trigger 3 simultaneous reconnect storms (one per Claude window).

### 6.3 Transparent reconnect for non-destructive calls

For read-only tools, the thin conductor can retry a failed call immediately:

```
thin conductor: broker.callTool('ibkr', 'get_pnl', {})
daemon: hub.callTool('ibkr', 'get_pnl', {})
         → MCPToolError: server not connected
daemon: schedules reconnect; returns error to thin conductor
thin conductor: waits 1 s, retries once
               (ibkr likely reconnected in <5 s)
```

The `ReliabilityGateway` already handles retry logic. Under the daemon model,
the gateway can live in the daemon (shared circuit breaker state) or in each
thin conductor (per-session isolation). Daemon-side circuit breakers prevent
thundering-herd retries from multiple windows.

---

## 7. HOT RELOAD: Config Change Without Dropping Claude Connections

### 7.1 Current behaviour

`reload_servers` MCP tool (registered in `mcp-server.ts`) calls `hub.reload()`,
which diffs the current server map against the config, disconnects removed
servers, and connects new ones. The caller's Claude session is unaffected (reload
is in-process).

### 7.2 Under daemon broker

`reload_servers` call from any thin conductor proxies to the daemon's
`broker.reload()`. The daemon runs `hub.reload()` and notifies all thin
conductors via the existing pub/sub broadcast mechanism:

```json
{ "__broadcast__": true, "channel": "conductor.reload", 
  "message": { "added": ["newserver"], "removed": ["oldserver"] } }
```

Thin conductors receive the broadcast and re-fetch the tool list from the daemon,
then re-register any new passthrough tools. Tools removed from the config are
de-registered (MCP SDK supports `server.tool.remove()` in v0.6+; verify version
in use).

**Config hot-reload without any tool call:**

For an advanced workflow, the daemon can watch `~/.mcp-conductor.json` for
changes using `fs.watch()` and auto-reload. This is optional — the manual
`reload_servers` path is sufficient for v1.

### 7.3 Version skew between daemon and thin conductors

If the user upgrades the npm package:
- New thin conductors start; they send a protocol version in their first
  broker handshake
- Old daemon is still running on the old binary

**Mitigation strategy:**
1. Add `protocolVersion: "1"` to the auth handshake (currently just nonce + HMAC)
2. Daemon rejects connections from thin conductors with a higher major version
3. Thin conductor detects rejection, logs `'daemon version mismatch — restart
   the daemon with: mcp-conductor-cli daemon restart'`, falls back to standalone
   mode (Option C hybrid)

For minor/patch version differences (no breaking protocol changes), the daemon
accepts the connection. This is a graceful degradation path — worst case is
standalone mode, not a broken session.

---

## 8. FAILURE MODES

### 8.1 Daemon crash — all Claude windows affected

If the daemon process crashes, all thin conductor broker clients lose their
socket connection simultaneously. The `DaemonClient.onData` path calls
`rejectAllPending()` on disconnect, which surfaces an error to any in-flight
tool call.

**Recovery path:**
1. Each thin conductor detects socket closure via `DaemonClient`'s `'close'` event
2. Thin conductor logs `'Daemon disconnected — reconnecting...'`
3. Thin conductor waits for daemon to restart (launchd/systemd will restart it
   within 3–5 s) and polls the socket (`_probeSocketLiveness` pattern)
4. Once socket appears, thin conductor re-authenticates and re-fetches tool list
5. Ongoing Claude sessions see a brief gap (the tool call in progress returns an
   error; the user retries)

The reconnect window of 3–5 s is comparable to the current per-session reconnect
behavior for a crashed child server. It is worse in one respect: **all windows**
are affected simultaneously rather than just one.

**Mitigations:**
- Daemon should be highly stable (Node.js process, no CPU-bound work). In
  practice, daemon crashes should be rare.
- Each thin conductor's `MCPExecutorServer` retains its session state (mode,
  metrics) during daemon reconnect — no session loss, only a brief tool
  unavailability.
- Failover to standalone mode (Option C) avoids the all-or-nothing failure by
  keeping a fallback `MCPHub` per thin conductor. On daemon reconnect, the
  standalone hub is torn down and the broker path resumes.

### 8.2 Daemon socket permissions changed

If `~/.mcp-conductor/daemon.sock` permissions are widened (e.g., by a runaway
`chmod`), other local users could connect. The HMAC auth mitigates this: they
would need the shared secret from `~/.mcp-conductor/daemon-auth.json` (mode
0o600, not readable by other users) to authenticate.

### 8.3 Child server holds exclusive resource

Some MCP servers acquire exclusive OS resources (file locks, TCP ports, user
sessions). Under the daemon model, the daemon holds one connection per child
server. If the daemon is restarted, the child is restarted too, re-acquiring its
resource. This is identical to current per-process behaviour, except it happens
once rather than per-window. Net effect: positive (fewer resource contention
events).

### 8.4 Daemon memory growth under long uptime

The daemon holds all child process handles in `MCPHub.connections`. Over hours of
uptime across many sessions, `SharedKV` with TTL entries and `SharedLock` could
accumulate state. Mitigations already present:
- `SharedKV` sweeps expired entries every 30 s
- `SharedLock` releases on client disconnect
- `MCPHub.toolCache` is bounded by the number of servers (22 × ~400 bytes each
  = ~9 KB — negligible)

The daemon should expose memory stats via `daemon status` and log a warning if
heap exceeds a configurable threshold (e.g., 512 MB).

---

## 9. SIMPLER WIN: Tool-List Sidecar Cache

Before committing to the full daemon broker, there is a cheaper option that
addresses the stated problem partially.

### Problem recap

The 10.5 s cold-start tax comes from spawning and handshaking 22 child servers.
The daemon broker amortises this across sessions. An alternative: **skip the
listTools calls on second and subsequent startups within a session window**, by
caching the results to disk between runs.

### Proposed file: `~/.mcp-conductor/tool-cache.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-12T04:00:00Z",
  "servers": {
    "ibkr": {
      "cachedAt": "2026-06-12T03:55:12Z",
      "toolCount": 39,
      "tools": [
        { "name": "get_pnl", "description": "...", "inputSchema": {...} },
        ...
      ]
    },
    "tv": { ... },
    ...
  }
}
```

### When is the cache hot?

The cache is written by `cacheServerTools()` after each successful `listTools`.
On next conductor startup, before calling `hub.initialise()`:

1. Load `~/.mcp-conductor/tool-cache.json`
2. For each server in cache, if `cachedAt` is within the staleness threshold
   (e.g., 10 minutes), **inject into `MCPHub.toolCache` directly** before
   connecting
3. Proceed with hub.initialise() as normal, but `cacheServerTools()` is skipped
   for servers with a fresh cache entry (connections still happen; listTools
   round-trip is skipped)

**Effect on startup time:**

The connection phase still happens (child process spawn, stdio handshake) — this
is the bulk of the 10.5 s. But `listTools` is one RPC per server after the
handshake. From the probe, the total listTools time is embedded in the
`T+1 294 ms` to `T+3 862 ms` range per server. If we skip listTools on warm
startup, we save perhaps 100–500 ms per server across 22 servers — rough estimate
200 ms aggregate, since the handshake dominates.

**Bigger win:** Cache enables lazy-connect to serve an accurate catalog
(tool counts, names in the initialize instructions) on the very first startup
after a cold launch. Without the cache, lazy mode must serve a stub catalog.
With the cache, even the first lazy-mode session sees correct tool metadata.

### What this does NOT solve

The 10 468 ms startup cost is dominated by:
- Child process spawn time (OS fork/exec): ~200–600 ms per server
- The MCP SDK `initialize` + `initialized` handshake round-trip: ~100–300 ms
- `srv-a`'s 10 000 ms timeout: **single biggest contributor**

Skipping `listTools` on warm start saves at most ~500 ms of the 10 468 ms. The
sidecar cache is a **complement to lazy-connect** (finding 06), not a substitute.

### Implementation cost

Low. Changes required:

1. **`src/hub/mcp-hub.ts`** — in `cacheServerTools()`, additionally write the
   tool schema to a sidecar file (debounced atomic-rename write, ~15 lines):
   ```typescript
   await writeSidecarCache(name, tools); // ~15 lines
   ```
   
2. **`src/hub/mcp-hub.ts`** — in `initialise()`, load sidecar before connecting
   (~20 lines):
   ```typescript
   const sidecar = await loadSidecarCache();
   for (const [serverName, entry] of Object.entries(sidecar.servers)) {
     if (isFresh(entry.cachedAt, this.config.sidecarTtlMs ?? 600_000)) {
       this.toolCache.set(serverName, entry.tools);
     }
   }
   ```

3. **`src/config/schema.ts`** — add `sidecar_cache_ttl_ms?: number` to
   `ConductorConfig`.

4. **`src/server/mcp-server.ts`** — `setCatalogInstructions()` can now use
   populated toolCache on cold start (lazy mode). No code change needed here —
   it already reads from toolCache.

**Total: ~50 lines, zero architectural change, zero risk.**

---

## 10. IMPACT

### 10.1 Daemon broker wins

| Metric | Per-process (today) | Daemon broker (Option A/C) |
|--------|--------------------|-----------------------------|
| Cold start (first session) | 10 468 ms | 10 468 ms (paid once at daemon start) |
| Warm start (2nd+ session) | **10 468 ms** | **~300 ms** |
| N concurrent windows | N × 10.5 s startup | 1 × 10.5 s + N × 300 ms |
| Child server process count | 22 × N windows | 22 (shared) |
| Memory (hub + children) | ~50–80 MB × N | ~50–80 MB (shared) |
| Reconnect storm on child crash | 1 per window simultaneously | 1 total |
| Tool list consistency across windows | Independent | Consistent (one source of truth) |
| `reload_servers` blast radius | 1 window | All windows (via broadcast) |
| Installation complexity | None (current) | Daemon process management |

For a single-window user: no win. For a 2-window user: 10.5 s saved per second
window. For a 4-window power user (common for agent orchestration): 3 × 10.5 s =
31 s saved, every time Claude Code restarts.

### 10.2 Sidecar cache wins

| Metric | No cache (today) | Sidecar cache |
|--------|-----------------|---------------|
| Cold start | 10 468 ms | 10 468 ms (unchanged) |
| Lazy-mode catalog accuracy at handshake | Stub only | Full (uses cached counts) |
| Warm start under eager mode | 10 468 ms | ~10 000 ms (listTools skip: ~200–500 ms saved) |
| Warm start under lazy mode (finding 06) | ~150 ms | ~150 ms (no change) |
| Implementation risk | — | Very low |

The sidecar cache is most valuable as a **companion to lazy-connect** (finding 06),
not as a standalone startup optimization.

---

## 11. RECOMMENDED PATH

### Phase 0 — Sidecar cache (ship this week, 1 PR)

**File:** `src/hub/mcp-hub.ts` + `src/config/schema.ts`  
**Lines changed:** ~50  
**Risk:** Near zero  
**Value:** Enables lazy-connect to serve accurate catalog; marginal startup
savings under eager mode; foundation for daemon broker's catalog pre-population.

Implementation: add `writeSidecarCache()` + `loadSidecarCache()` helpers,
call them from `cacheServerTools()` and the top of `initialise()` respectively.
TTL defaults to 10 minutes, configurable via `sidecar_cache_ttl_ms`.

---

### Phase 1 — Daemon broker: foundation (1–2 sprints)

**Goal:** The `DaemonServer` in `src/daemon/server.ts` gains the ability to own
an `MCPHub` and broker `tool.call` RPCs. A feature flag (`daemon_mode: "broker"`)
enables the new path.

**Changes:**

1. **`src/daemon/server.ts`** — implement `tool.call` dispatch:
   - Inject `MCPHub` instance via constructor option
   - Add `case 'tool.call': return this.hub.callTool(p.server, p.tool, p.args)`
   - Add `case 'broker.listServers': return this.hub.getStats()`
   - Add `case 'broker.getToolList': return this.hub.getAllTools()`
   - Add `case 'broker.reload': return this.hub.reload()`
   - Broadcast `conductor.reload` event after reload completes

2. **`src/daemon/broker-client.ts`** (new, ~100 lines) — wraps `DaemonClient`
   with MCPHub-shaped interface:
   ```typescript
   class BrokerClient {
     async callTool(server: string, tool: string, args: unknown): Promise<unknown>
     async listServers(): Promise<ServerStats>
     async getAllTools(): Promise<ToolEntry[]>
     async reload(): Promise<{ added: string[]; removed: string[] }>
   }
   ```

3. **`src/server/mcp-server.ts`** — in `start()`, when `daemon_mode === 'broker'`:
   - Connect `BrokerClient` instead of direct `MCPHub`
   - Fetch tool list from broker for `registerPassthroughTools()` and
     `setCatalogInstructions()`
   - Remove `hub.initialise()` call (daemon already did it)

4. **`src/bin/cli.ts`** — when `--daemon-server` flag is set, start hub inside
   the daemon before accepting connections.

5. **`src/cli/daemon.ts`** — `daemon start` waits for
   `hub.initialise()` to complete (not just socket appearance) before returning.
   Add `--no-wait` flag for background launch.

6. **`src/config/schema.ts`** — add `daemon_mode?: 'standalone' | 'broker'`
   to `ConductorConfig`. Default: `'standalone'`.

---

### Phase 2 — Daemon broker: stability (1 sprint)

1. Protocol version in auth handshake (version skew detection)
2. Thin conductor reconnect loop on daemon crash with exponential backoff
3. Daemon health monitoring in `daemon status` (hub stats, child status)
4. `launchd` plist generation in `mcp-conductor-cli setup --daemon`
5. `systemd` service file generation for Linux
6. Metrics: track how many thin conductor sessions are connected to daemon

---

### Phase 3 — Default flip (after stability validation)

Change `daemon_mode` default from `'standalone'` to `'broker'` in the setup
wizard output. Add a "daemon running" badge to `get_metrics` output.

---

## Summary

| Approach | Startup win | Complexity | Risk | Recommended timing |
|----------|-------------|------------|------|--------------------|
| Sidecar tool-list cache | Marginal standalone; enables lazy catalog accuracy | Very low (~50 lines) | Near zero | This week |
| Daemon broker (Option A/C) | **~10 s per additional window** | High (protocol, lifecycle, version skew) | Medium | 1–2 sprints after lazy-connect (finding 06) |
| launchd/systemd autostart | Daemon survives restarts | Low (file generation) | Low | With Phase 2 |

**Headline:** The daemon broker is the definitive answer to amortising the 10.5 s
cold-start cost across multiple Claude windows. The infrastructure is 70% there
(`DaemonServer`, `DaemonClient`, socket, auth, KV, locks, pub/sub all exist). The
gap is that the daemon does not yet own an `MCPHub` or broker `tool.call` RPCs —
a 200–300 line addition. The simpler near-term win is the **sidecar tool-list
cache** (~50 lines), which should land first as it enables accurate lazy-connect
catalogs and poses zero risk.
