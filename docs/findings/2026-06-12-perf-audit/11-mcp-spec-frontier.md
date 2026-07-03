# 11 — MCP Spec Frontier

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`  
Spec versions surveyed: `2025-03-26` and `2025-11-25`

---

## Scope and Method

This document audits every significant MCP specification feature against conductor's
current implementation. For each feature the audit reports:

- **(a)** What the spec feature is and how it works  
- **(b)** Conductor's current implementation status — file:line or "no"  
- **(c)** Why it matters for tokens, speed, or UX  

Sources: `modelcontextprotocol.io/specification/2025-03-26/*` and
`/specification/2025-11-25/*`, the MCP blog, and live grep of
`src/` at HEAD `f12f5f5`.

---

## Summary Table

| Feature | Spec introduced | Conductor status | Impact tier |
|---------|----------------|-----------------|-------------|
| Resources (static) | 2025-03-26 | **PARTIAL** — catalog only | Medium |
| Resources (subscribe/notify) | 2025-03-26 | **NOT USED** | Medium |
| Resource annotations (audience/priority/lastModified) | 2025-11-25 | **NOT USED** | Low |
| Prompts | 2025-03-26 | **NOT USED** | High |
| Sampling | 2025-03-26 | **NOT USED** | Medium |
| Roots | 2025-03-26 | **NOT USED** | Low |
| Elicitation (form mode) | 2025-11-25 | **NOT USED** | Medium |
| Elicitation (URL mode) | 2025-11-25 | **NOT USED** | Low |
| Progress notifications | 2025-03-26 | **PARTIAL** — execute_code only | High |
| Logging notifications | 2025-03-26 | **NOT USED** | Medium |
| Cancellation | 2025-03-26 | **NOT USED** | Medium |
| Tool annotations (4 hints) | 2025-03-26 | **USED** — on all tools | Low (already done) |
| Structured content / outputSchema | 2025-11-25 | **USED** — on all tools | Low (already done) |
| Tool icons | 2025-11-25 | **USED** — server-level | Low (already done) |
| Tasks (durable async execution) | 2025-11-25 exp. | **NOT USED** | High |
| Resource links in tool results | 2025-11-25 | **NOT USED** | Medium |
| JSON-RPC batching removal | 2025-06-18 | N/A (SDK handles) | Low |
| OAuth resource server / PKCE | 2025-06-18 | N/A (stdio only) | Low |
| MCP-Protocol-Version header | 2025-06-18 | N/A (SDK handles) | Low |

---

## 1. Resources

### (a) What the spec says

Resources are the "read-only data" primitive of MCP — conceptually analogous to REST
`GET` endpoints, but surfaced as URIs with optional subscriptions. The spec
(`/specification/2025-03-26/server/resources`) defines:

- **`resources/list`** — paginated discovery of available resources (static list).
- **`resources/templates/list`** — RFC 6570 URI template discovery.
- **`resources/read`** — fetch the contents of a URI (text or base64 binary).
- **`resources/subscribe`** — client subscribes to change notifications for a URI.
- **`notifications/resources/updated`** — server notifies client the content changed.
- **`notifications/resources/list_changed`** — server notifies client the list changed.

Capability declaration required at init:
```json
{ "capabilities": { "resources": { "subscribe": true, "listChanged": true } } }
```

The 2025-11-25 spec adds **resource annotations** on both resource definitions and
content blocks:
```json
{
  "annotations": {
    "audience": ["user", "assistant"],
    "priority": 0.8,
    "lastModified": "2025-06-12T00:00:00Z"
  }
}
```
`audience` controls who sees the content; `priority` (0–1) guides inclusion; `lastModified`
enables recency-based sorting.

Resource templates support RFC 6570 expansion, and arguments can be auto-completed via
the completion API (not separately audited here). The 2025-11-25 spec also adds `icons`
and `title` fields to resource and template definitions.

### (b) Conductor status

**PARTIAL — catalog resources registered; subscriptions not implemented.**

`src/server/mcp-server.ts:734–795` registers:

1. **Static resource** `conductor://catalog` — full backend tool catalog as
   `text/markdown`. Read callback is lazy; reflects live hub state.
2. **Resource template** `conductor://catalog/{server}` — per-server markdown tool
   list, with a `list:` callback that enumerates all connected servers.

Both use `server.registerResource(...)` from the SDK's `@modelcontextprotocol/sdk/server/mcp.js`.

What is **not** implemented:
- No `subscribe: true` in capability declaration (cannot confirm without reading the
  SDK's init call at line 238; `McpServer` constructor passes `{ name, title, version,
  websiteUrl, icons }` — no explicit capability override, so the SDK defaults apply,
  which are tools-only unless resources are registered, which they are).
- No `notifications/resources/updated` emission — the catalog content changes when
  servers connect/disconnect but no subscriber notification is sent.
- No `listChanged` notification when servers connect or drop.
- No `audience`/`priority`/`lastModified` annotations on catalog resources.

### (c) Why it matters

**Tokens:** Resources are pulled by the client on-demand and only when explicitly
referenced. A `conductor://catalog` resource that Claude Desktop can pin to its context
window costs 0 tokens until read — versus the current 3 086-char (~770-token) system
instructions that are injected on *every* session. If the catalog were purely a resource
(not embedded in instructions), the caller controls when to load it.

**UX:** Claude Desktop's resource picker UI would show `conductor://catalog` as a
named, clickable item. Users could pin the catalog for a session without any tool call.

**Live updates:** If conductor fired `notifications/resources/updated` when a server
reconnected, Claude Desktop would know to re-fetch the catalog without the user
calling `reload_servers`. This closes the "stale catalog" UX bug.

**Concrete opportunities:**

| New resource URI | Content | Benefit |
|-----------------|---------|---------|
| `conductor://health` | live server health JSON | replaces `list_servers` for monitoring |
| `conductor://metrics` | current session metrics | replaces `get_metrics` for dashboards |
| `conductor://config` | sanitised conductor config | avoids a tool call for "what's configured" |
| `conductor://cache/stats` | cache hit/miss rates | visibility without a round-trip tool |

These resources would allow context-building tools (like rgx or Serena) to read
conductor state via the resource interface rather than burning a tool call slot.

---

## 2. Prompts

### (a) What the spec says

Prompts are server-defined, parameterised message templates that clients surface
directly in their UI — most commonly as **slash commands** in Claude Desktop's composer
(the `/code_review` pattern in the spec screenshot). Spec:
`/specification/2025-03-26/server/prompts`.

Protocol:
- **`prompts/list`** — paginated discovery; response includes `name`, `description`,
  and a typed `arguments` array.
- **`prompts/get`** — fetch a prompt with filled-in arguments; response is an array of
  `PromptMessage` objects (role=user/assistant) containing text, image, audio, or
  embedded-resource content.
- **`notifications/prompts/list_changed`** — server signals the prompt list changed.

Example prompt definition returned by `prompts/list`:
```json
{
  "name": "cond:summarise-server",
  "description": "Show a compact summary of all tools on a specific backend server",
  "arguments": [
    { "name": "server", "description": "Server name", "required": true }
  ]
}
```

The resulting `prompts/get` response would be a pre-built user message with the catalog
content embedded, ready to inject into the conversation.

### (b) Conductor status

**NOT USED.**

`grep -rn "registerPrompt\|prompts/list\|prompts/get" src/` → zero results.

No prompt registration, no capability declaration for `prompts`.

### (c) Why it matters

**UX (critical gap):** Every conductor meta-tool is currently invocable only by the
model — the user cannot trigger them without asking Claude to call them. Prompts close
this gap. A user could type `/cond:summarise` in Claude Desktop's composer to get the
catalog without a model turn.

**Token savings:** A `prompts/get` response that embeds catalog markdown is returned
outside the tool-call mechanism — it adds context directly without appearing in the
`<tool_result>` path. This matters for discovery-type workflows where the user wants to
see available servers without the overhead of a model decision loop.

**Concrete candidates** — prompts conductor could register today:

| Prompt name | Arguments | Purpose |
|------------|-----------|---------|
| `cond:status` | _(none)_ | Health, connected servers, mode |
| `cond:catalog` | `server?` | Full or per-server tool catalog |
| `cond:how-to` | `task` | "How would you call X?" — usage guide |
| `cond:diag` | _(none)_ | Last diag trailer content |
| `cond:savings` | _(none)_ | Session token savings summary |

**Implementation cost:** Low. The SDK exposes `server.setRequestHandler('prompts/list',
...)` and `server.setRequestHandler('prompts/get', ...)`. Conductor already builds all
the underlying content (catalog text, metrics, health) — connecting prompts is ~50 lines
of plumbing.

**Capability declaration** required at init:
```json
{ "capabilities": { "prompts": { "listChanged": true } } }
```

---

## 3. Sampling

### (a) What the spec says

Sampling is the inverse of tool calling: the **server** requests an LLM completion
from the **client**, without needing its own API key. Spec:
`/specification/2025-03-26/client/sampling`.

Protocol — server sends `sampling/createMessage`:
```json
{
  "method": "sampling/createMessage",
  "params": {
    "messages": [{"role": "user", "content": {"type": "text", "text": "..."}}],
    "modelPreferences": {
      "hints": [{"name": "claude-haiku"}],
      "costPriority": 0.8,
      "speedPriority": 0.9
    },
    "systemPrompt": "You are a summariser.",
    "maxTokens": 256
  }
}
```

The client executes the LLM call (with user approval) and returns the generated text.
The server never sees API keys. The spec requires a human-in-the-loop: clients must
offer UI to review the request and the response before forwarding.

Client declares: `{ "capabilities": { "sampling": {} } }`.

### (b) Conductor status

**NOT USED.**

`grep -rn "sampling\|createMessage" src/` → zero results.

### (c) Why it matters

Sampling enables server-side **agentic loops** that call the LLM without surfacing that
complexity to the model currently using conductor.

**Conductor-specific use cases:**

1. **Auto-routing inference.** When `recommend_routing` is called, conductor today
   returns heuristic recommendations. With sampling it could send tool descriptions to
   a cheap model (haiku, `costPriority: 0.9`) and request JSON back classifying each
   tool as `execute_code`/`passthrough`/`skip`. The user never sees this sub-call; the
   result populates routing config automatically.

2. **Compact/summarise sub-call.** The `execute_code` sandbox currently inlines raw
   results. With sampling, conductor could call haiku to compress a large result in-band
   before returning it to the primary model, saving tokens on the primary context.

3. **Error diagnosis.** When a backend tool returns an error, conductor could use
   sampling to ask a cheap model "is this retryable?" and auto-retry or not, rather
   than surfacing the raw error.

**Token impact:** Sub-calls via sampling do not appear in the primary conversation
context. They consume tokens at the sub-model tier but keep the primary context clean.

**Implementation cost:** Medium. Requires the client (Claude Desktop / Claude Code) to
declare `sampling` capability, and conductor to call
`extra.sendRequest('sampling/createMessage', ...)` inside a tool handler. The TypeScript
SDK has full support for this.

---

## 4. Roots

### (a) What the spec says

Roots let the **client** tell the server which filesystem directories it has access to.
The server calls `roots/list` to discover these workspace boundaries. The client can
emit `notifications/roots/list_changed` when the user adds/removes directories.
Spec: `/specification/2025-03-26/client/roots`.

The spec requires roots to be `file://` URIs. Typical use: a filesystem MCP server
limits its file operations to the declared roots.

### (b) Conductor status

**NOT USED.**

`grep -rn "roots/list\|roots\b\|rootsCapability" src/` → zero results.

Conductor does not call `roots/list` on the client, and does not pass root information
to proxied backends.

### (c) Why it matters

**Direct applicability: low.** Conductor is a proxy, not a filesystem server. It does
not read or write files on behalf of the client.

**Indirect applicability: moderate.** When conductor's `execute_code` sandbox runs
Deno scripts, those scripts call backend tools (filesystem, playwright, etc.) which may
be roots-aware. If conductor retrieved roots from the client during initialisation, it
could:
- Restrict which filesystem servers are available based on declared roots.
- Pass root URIs into the Deno sandbox's `mcp` API so scripts can validate paths.
- Prevent `execute_code` from calling filesystem tools on paths outside declared roots
  (a security hardening).

**Recommendation:** Low priority. File-gating via roots would require changes to the
sandbox API and the hub call path. Worth noting but not a near-term item.

---

## 5. Elicitation

### (a) What the spec says

Elicitation lets the **server** ask the **user** for input mid-call, while a tool
invocation is in flight. This is a key new feature in the `2025-11-25` spec revision.
Spec: `/specification/2025-11-25/client/elicitation`.

Two modes:

**Form mode** — structured in-band data collection. Server sends:
```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "Please provide your GitHub username",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "username": {"type": "string"}
      },
      "required": ["username"]
    }
  }
}
```
Response actions: `"accept"` (with `content` filled), `"decline"`, or `"cancel"`.

Schema is restricted to **flat objects with primitive fields** only (string, number,
boolean, enum). No nested objects — intentional to keep client UI simple.

**URL mode** — out-of-band interaction. Server redirects the user to a URL (OAuth flow,
payment, API key entry). Data never transits through the MCP client. Response is just
`"accept"` (indicating user consented to open the URL) without content.

Client declares:
```json
{ "capabilities": { "elicitation": { "form": {}, "url": {} } } }
```

### (b) Conductor status

**NOT USED.**

`grep -rn "elicitation" src/` → zero results.

### (c) Why it matters

**Form mode — conductor-specific use cases:**

1. **Dynamic server configuration.** The `add_server` tool currently takes all
   parameters in one shot. With elicitation, if the user types "add a postgres server"
   conductor could prompt step-by-step: connection string → optional name → routing
   preference. This reduces long, hard-to-remember argument lists.

2. **Confirm destructive passthrough calls.** When a passthrough tool has
   `destructiveHint: true`, conductor could use elicitation to ask "Are you sure you
   want to delete X?" before forwarding the call. Currently there is no in-band
   confirmation mechanism.

3. **Budget alerts.** If `execute_code` is about to call a tool that `predict_cost`
   estimates will cost > $N, conductor could ask the user to confirm rather than silent-
   proceed.

**URL mode — conductor-specific use case:**

OAuth re-authorization for backend servers. When a backend MCP server returns a 401,
conductor could fire a URL-mode elicitation directing the user to the server's auth
page. The server's callback would complete the flow and conductor could retry the call.
This is the "re-auth without restart" pattern.

**Implementation cost:** Medium. Requires the Claude Desktop / Code client to support
the `elicitation` capability (Claude Code does as of early 2026). Server-side, conductor
would call `extra.sendRequest('elicitation/create', ...)` inside tool handlers. The
feature is experimental in the TypeScript SDK but available.

---

## 6. Streaming Responses / `notifications/progress`

### (a) What the spec says

Progress notifications let either party report incremental completion status for long-
running operations. Requester includes `progressToken` in `_meta`:
```json
{ "_meta": { "progressToken": "abc123" } }
```
Server emits:
```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "abc123",
    "progress": 0.6,
    "total": 1.0,
    "message": "Fetching page 3 of 10..."
  }
}
```
`progress` must increase monotonically. `total` is optional. `message` should be
human-readable. Spec: `/specification/2025-11-25/basic/utilities/progress`.

The 2025-11-25 spec update adds that for **task-augmented requests** (see §10), the
`progressToken` remains valid for the task's entire lifetime (not just until the initial
response returns).

### (b) Conductor status

**PARTIAL — wired only for `execute_code`.**

`src/server/mcp-server.ts:871–893`:
```typescript
const progressToken = extra?._meta?.progressToken;
const wantProgress = progressToken !== undefined;
// ...
if (!wantProgress || !extra?.sendNotification) return;
extra.sendNotification({
  method: 'notifications/progress',
  params: { progressToken, progress, total, message },
});
```

The `execute_code` handler reads `_meta.progressToken` from the call's `extra` context
and, when present, forwards progress ticks from the Deno sandbox's `mcp.log()` calls as
MCP progress notifications.

What is **not** implemented:
- No progress forwarding from backend tool calls via `passthrough_call` or auto-registered
  passthrough tools (`src/server/passthrough-registrar.ts`).
- No progress notification when `reload_servers` is in flight (which can take 10+ s).
- No progress notification for `test_server` or `diagnose_server` (both involve multiple
  sequential calls).

### (c) Why it matters

**UX:** Claude Desktop renders progress notifications as a live progress bar during tool
invocation. For `execute_code` calls that run multi-step Deno scripts against slow
backends, the user sees incremental updates rather than a frozen spinner for 30 s.

**The gap:** Passthrough tool calls do not forward progress from the backend. If a
backend server (e.g. `taskmaster-ai`, `playwright`) emits `notifications/progress`,
conductor currently discards those notifications instead of forwarding them to the client.

**Concrete wins:**
- `reload_servers`: emit progress as each backend connects (1/22... 2/22...).
- `test_server`: emit per-step progress (init... tools/list... first call...).
- Passthrough hub: intercept backend `notifications/progress` and re-emit with the
  client's original token.

**Token impact:** Zero. Progress notifications do not consume tokens; they are
notification-type messages with no response.

---

## 7. Logging Notifications

### (a) What the spec says

Servers can send structured log messages to clients via `notifications/message`. Clients
can set the minimum level with `logging/setLevel`. Eight RFC 5424 syslog levels:
`debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. Spec:
`/specification/2025-03-26/server/utilities/logging`.

Message format:
```json
{
  "method": "notifications/message",
  "params": {
    "level": "warning",
    "logger": "conductor.hub",
    "data": { "server": "taskmaster-ai", "reason": "handshake timeout" }
  }
}
```

Server declares: `{ "capabilities": { "logging": {} } }`.
Client calls `logging/setLevel` to filter noise.

### (b) Conductor status

**NOT USED as an MCP primitive.**

`grep -n "notifications/message\|logging/setLevel\|\"logging\"" src/` → zero results in
production paths (only references in tests).

Conductor has a rich internal logger (`src/utils/index.ts`) that writes to stderr. But
this is entirely outside the MCP protocol — Claude Desktop cannot filter or surface
conductor's internal logs at all.

### (c) Why it matters

**Observability:** Claude Desktop has a server log panel. If conductor declared the
`logging` capability and emitted `notifications/message` for key events (server
connect/disconnect, cache hit/miss, gateway circuit trips, PII scrub events), the
operator could see them in the client UI without tailing stderr.

**Token savings:** Diagnostic information in `notifications/message` does not appear in
the model's context window. Currently, conductors's `set_diag_mode` appends diagnostic
trailers to tool *results*, which means they go into the LLM context. Routing equivalent
information via logging notifications would keep the context clean while retaining
visibility.

**Concrete candidates for `notifications/message` emission:**

| Event | Level | logger | When |
|-------|-------|--------|------|
| Server connected | `info` | `conductor.hub` | On successful handshake |
| Server disconnected | `warning` | `conductor.hub` | On drop/timeout |
| Cache hit | `debug` | `conductor.cache` | Per cache-hit call |
| Circuit breaker tripped | `error` | `conductor.gateway` | On circuit open |
| PII token scrubbed | `notice` | `conductor.pii` | Per scrub event |
| Rate-limit applied | `notice` | `conductor.ratelimit` | Per throttle |

**Implementation cost:** Low. Add `{ capabilities: { logging: {} } }` to the
`McpServer` constructor options, then call `extra.sendNotification(...)` with
`method: 'notifications/message'` at the relevant points. The SDK already exposes
`sendNotification` in every tool handler's `extra` context.

---

## 8. Resource Subscriptions (`notifications/resources/updated`)

### (a) What the spec says

When a client subscribes to a resource URI, the server tracks the subscription and emits
`notifications/resources/updated` when the content changes. The client then calls
`resources/read` to get fresh content.

Subscribe request:
```json
{ "method": "resources/subscribe", "params": { "uri": "conductor://catalog" } }
```
Update notification:
```json
{ "method": "notifications/resources/updated", "params": { "uri": "conductor://catalog" } }
```

Capability: `{ "resources": { "subscribe": true } }`.

### (b) Conductor status

**NOT USED.**

The `conductor://catalog` and `conductor://catalog/{server}` resources are registered
(§1 above) but the server never emits `notifications/resources/updated`. The SDK's
`McpServer.registerResource(...)` does not automatically emit update notifications.

`grep -n "notifications/resources\|resources/subscribe" src/` → zero results.

### (c) Why it matters

**Live catalog.** When `reload_servers` completes and a backend server reconnects,
the `conductor://catalog` content changes but no client gets notified. Claude Desktop
would need the user to explicitly re-fetch the resource. With subscriptions, the client
automatically re-reads the catalog when it changes.

**Compound effect with §1:** Together, static resources + subscriptions + update
notifications form the basis of a "live dashboard" that Claude Desktop can pin. A
pinned `conductor://health` resource that auto-updates when server status changes would
eliminate the need to call `list_servers` at the start of every session.

**Implementation path:** In `MCPHub.ts`, when `onServerConnected`/`onServerDisconnected`
fires, call `server.sendNotification({ method: 'notifications/resources/updated',
params: { uri: 'conductor://catalog' } })`. This is ~5 lines.

---

## 9. Cancellation

### (a) What the spec says

Either party can cancel an in-flight request by sending `notifications/cancelled`:
```json
{
  "method": "notifications/cancelled",
  "params": { "requestId": "123", "reason": "User requested cancellation" }
}
```
The receiver should stop processing and not send a response. Race conditions are
expected and both sides must handle gracefully (cancelled notification may arrive after
response already sent). Spec: `/specification/2025-03-26/basic/utilities/cancellation`.

### (b) Conductor status

**NOT USED — neither sent nor handled.**

`grep -n "notifications/cancelled\|cancelRequest" src/` → zero results.

Conductor does not:
- Forward `notifications/cancelled` from the client to backend servers via the hub.
- Terminate in-flight Deno sandbox processes when the client cancels an `execute_code`
  call.
- Cancel pending backend tool calls when the client drops a passthrough call.

### (c) Why it matters

**Resource leakage:** If a client (Claude Desktop) sends a `notifications/cancelled`
for an in-flight `execute_code` call, the Deno subprocess keeps running, consuming
memory and CPU, potentially holding a backend connection open. The client gets no
result, but conductor pays the execution cost.

**Backend side-effects:** For destructive passthrough calls (`destructiveHint: true`),
a cancellation that arrives mid-execution may mean the backend tool has already been
invoked. Conductor should log this as a warning rather than silently discarding the
cancellation.

**Token savings:** Cancelling a `execute_code` call that is halfway through a multi-
step Deno script stops the token metering early. For scripts that call many backends
sequentially, early cancellation could save significant result-accumulation tokens.

**Implementation notes:**

The TypeScript SDK surfaces incoming `notifications/cancelled` via an `AbortSignal` on
the `extra.signal` property of tool handlers (added in SDK 1.10+). The `execute_code`
handler can pass this signal to the `DenoExecutor` to send SIGTERM to the subprocess.

Priority: medium. The Deno executor already has a `timeout_ms` abort path; wiring
`AbortSignal` into it is straightforward.

---

## 10. Tool Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)

### (a) What the spec says

The `annotations` field on a tool definition carries four boolean **hints** about a
tool's behaviour. Spec: `/specification/2025-03-26/server/tools` + blog post (2026-03-16).

| Annotation | Default | Meaning |
|-----------|---------|---------|
| `readOnlyHint` | `false` | Tool only reads, does not modify environment |
| `destructiveHint` | `true` | Modifications may be irreversible (delete/overwrite) |
| `idempotentHint` | `false` | Repeated identical calls have no extra effect |
| `openWorldHint` | `false` | Tool interacts with external entities (internet/APIs) |

Key spec note: annotations are **hints**, not guarantees. Clients must treat them as
untrusted unless the server is trusted. The MCP Tool Annotations Interest Group is
working on extended annotations addressing the "lethal trifecta" (private data + untrusted
content + external communication).

### (b) Conductor status

**FULLY USED — on all tools.**

Meta-tools in `src/server/mcp-server.ts` all carry explicit annotations. Examples:
- `execute_code` (line 803): `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`
- `list_servers` (line 946): `{ readOnlyHint: true, idempotentHint: true, openWorldHint: false }`
- `discover_tools` (line 1012): `{ readOnlyHint: true, idempotentHint: true, openWorldHint: false }`

Auto-registered passthrough tools in `src/server/passthrough-registrar.ts:266`:
```typescript
const annotations = inferAnnotationsFromName(tool.name);
```
The `inferAnnotationsFromName` function (lines 132–157) uses prefix/suffix regex to
classify tool names into read-safe, mutating, or destructive buckets. Upstream
annotations from backend servers are not yet carried through the `ToolDefinition`
schema (noted as deferred in a comment at line 263).

### (c) Why it matters

**Already implemented** — no immediate action required. However two gaps exist:

**Gap 1 — upstream annotation passthrough.** The passthrough registrar uses heuristic
name matching because the registry (`ToolDefinition`) does not store the upstream
annotations from the backend's `tools/list` response. The fix is to carry the
`annotations` field through the hub's tool introspection into `ToolDefinition`, then
use those instead of inference. This would catch non-obvious destructive tools that
use opaque names.

**Gap 2 — cache leveraging read-only hint.** The cache layer (`src/cache/cache.ts`)
does not currently consult `readOnlyHint` to decide what to cache. A tool marked
`readOnlyHint: true, idempotentHint: true` is a perfect cache candidate (deterministic
output given same input). The cache key could include the tool name, and cache eviction
policy could be loosened for idempotent read-only tools (longer TTL, higher priority
retention). This is an architectural enhancement not yet implemented.

---

## 11. Structured Content and `outputSchema` (2025-11-25)

### (a) What the spec says

The `2025-11-25` spec formalises **structured content**: tools can return data in both
a `content` array (text/image for backward compatibility) and a `structuredContent`
object (typed JSON). An optional `outputSchema` field on the tool definition carries a
JSON Schema describing the expected `structuredContent` shape.

```json
{
  "name": "get_metrics",
  "outputSchema": {
    "type": "object",
    "properties": {
      "totalCalls": { "type": "number" },
      "tokensSaved": { "type": "number" }
    }
  }
}
```
If `outputSchema` is present, the server **must** return conforming `structuredContent`;
clients **should** validate.

### (b) Conductor status

**FULLY USED — on almost all meta-tools.**

`grep -n "outputSchema\|structuredContent" src/server/mcp-server.ts` shows `outputSchema`
defined on lines 833, 954, 1022, 1117, 1257, 1300, 1372, 1422, 1495, 1591, 1788 and
`structuredContent` returned alongside `content` on lines 481, 1001, 1097, 1233, 1276,
1330, 1405, 1473, 1565, 1722, 1764.

Passthrough tools (`passthrough-registrar.ts:336`) also return `structuredContent:
{ success: true, result }`.

### (c) Why it matters

**Already well-implemented.** The main gap: passthrough tools return `structuredContent:
{ success: true, result }` which is generic — the `result` field is untyped. If the
upstream backend's `tools/list` carried an `outputSchema` annotation, conductor could
proxy it through to the passthrough tool definition. This would enable clients to
validate passthrough results and give the LLM a schema to parse against rather than
opaque JSON.

---

## 12. Tool Icons (2025-11-25)

### (a) What the spec says

The 2025-11-25 spec adds an optional `icons` array to tool and resource definitions:
```json
{
  "icons": [
    { "src": "https://example.com/icon.png", "mimeType": "image/png", "sizes": ["48x48"] }
  ]
}
```
Icons are display hints for client UIs — no protocol semantics.

### (b) Conductor status

**USED at the server level.**

`src/server/mcp-server.ts:243–263`: the `McpServer` constructor receives an inline SVG
data URI as the server icon. Individual tools do not carry icons.

### (c) Why it matters

**Low priority.** Icons are purely cosmetic in current clients. No token or performance
impact. No action required.

---

## 13. Tasks — Durable Async Execution (2025-11-25 experimental)

### (a) What the spec says

Tasks are a **major new primitive** introduced experimentally in `2025-11-25`. They
allow a `tools/call` request to be converted into a **polling-based async job**. The
client sends the request with a `task` field:

```json
{
  "method": "tools/call",
  "params": {
    "name": "execute_code",
    "arguments": { "code": "..." },
    "task": { "ttl": 300000 }
  }
}
```

The server immediately returns a `CreateTaskResult` with a `taskId` and `status:
"working"`. The client can then:
- Poll with `tasks/get` for status transitions.
- Retrieve results with `tasks/result` (blocking until terminal).
- Cancel with `tasks/cancel`.
- Receive `notifications/tasks/status` push notifications.

Task statuses: `working → input_required → working → completed/failed/cancelled`.

The `input_required` status integrates with **elicitation** (§5): when the server needs
user input mid-task, it transitions to `input_required` and sends an
`elicitation/create` on the same session.

Tool-level negotiation: tools declare `execution.taskSupport` as `"forbidden"` (default),
`"optional"`, or `"required"`.

### (b) Conductor status

**NOT USED.**

`grep -rn "tasks/get\|tasks/result\|taskId\|tasks/cancel\|CreateTaskResult\|taskSupport" src/` → zero results.

No task capability declaration, no task protocol handling.

### (c) Why it matters

**This is the highest-value unused feature in the spec for conductor specifically.**

**Problem it solves:** `execute_code` calls that run complex multi-step Deno scripts
against slow backends currently block for up to 30 seconds (or more with custom
`timeout_ms`). During this time, Claude Desktop shows a spinner, cannot process other
requests, and has no visibility into intermediate state. If the user closes Claude
Desktop mid-execution, the result is lost.

**With tasks:**
1. Claude Desktop fires `tools/call` with `task: { ttl: 300000 }`.
2. Conductor returns `taskId` immediately (< 1 ms).
3. The Deno script runs in the background.
4. Claude can process other messages while the task executes.
5. Conductor emits `notifications/tasks/status` when steps complete.
6. The user can close and reopen Claude Desktop; the task result is still retrievable.

**Token impact:** The `io.modelcontextprotocol/model-immediate-response` field in
`CreateTaskResult` can carry a short "acknowledged, running..." message to the model
immediately, consuming ~10 tokens, while the full result (potentially thousands of
tokens) is only retrieved via `tasks/result` when it completes. This is a *pull* model
for large results — no result token cost until explicitly requested.

**Integration with elicitation:** Long-running tasks that need user input (e.g.,
"confirm before deleting 200 items") can use the `input_required` → elicitation flow
without blocking.

**Implementation cost:** High. Requires:
- A task registry (in-memory map of `taskId → { status, result, abortSignal }`)
- Modified `execute_code` handler to check for `params.task` field
- `tasks/get`, `tasks/result`, `tasks/cancel` request handlers
- Optional `notifications/tasks/status` emission
- Capability declaration at init

The SDK does not yet provide a high-level `Tasks` API (as of TypeScript SDK v1.x); the
protocol messages must be handled via lower-level `server.setRequestHandler` calls.

**Recommended approach:** Implement tasks for `execute_code` only first (mark
`execution.taskSupport: "optional"`). This captures 90% of the value with ~30% of the
work. Extend to passthrough tools in a second iteration.

---

## 14. Resource Links in Tool Results (2025-11-25)

### (a) What the spec says

The `2025-11-25` spec adds `resource_link` as a content type in tool results:

```json
{
  "type": "resource_link",
  "uri": "conductor://catalog/ibkr",
  "name": "ibkr tool catalog",
  "mimeType": "text/markdown"
}
```

A resource link tells the client *where* to fetch content rather than inlining it in the
tool result. The client can follow the link (call `resources/read`) only if it needs
the content. If the client already has a cached copy or the user does not need it, the
link costs zero tokens beyond the small metadata object (~50 chars).

### (b) Conductor status

**NOT USED.**

`grep -n "resource_link" src/` → zero results.

Current behaviour: `discover_tools` and `list_servers` inline full catalog text
directly in their tool result content. A large `discover_tools` result for all 498 tools
across 22 servers can be 20–50 KB.

### (c) Why it matters

**Direct token savings opportunity.** `discover_tools` returns inline markdown today.
With resource links, it could return:
```json
[
  { "type": "resource_link", "uri": "conductor://catalog/ibkr", "name": "ibkr (39 tools)" },
  { "type": "resource_link", "uri": "conductor://catalog/tv",   "name": "tv (89 tools)" }
]
```
The client only fetches the content for servers the model actually needs. For a session
where only `ibkr` tools are used, the other 21 catalog entries are never loaded into
context. Estimated savings: 10–40 KB per discovery call that doesn't need the full
catalog.

**Implementation coupling:** Resource links only work if the `conductor://catalog/{server}`
resources are registered (they are — §1). This is a low-cost change to the `discover_tools`
response builder: return `resource_link` items instead of inlining markdown when the
caller omits a `server` filter.

---

## 15. Experimental Capabilities — 2025-06-18 Spec Update

The `2025-06-18` spec update (post-2025-03-26 but pre-2025-11-25 in publication order)
introduced three security and protocol changes. Source: forgecode.dev recap of the spec
diff.

### 15a. OAuth 2.0 Resource Server Classification

MCP servers are formally classified as OAuth 2.0 resource servers. Clients must include
an RFC 8707 `resource` parameter when requesting tokens, binding each token to a
specific server URL. PKCE is now mandatory for all clients. Token audience validation
is required.

**Conductor status:** N/A. Conductor runs over `stdio` only. The OAuth changes apply
to HTTP/SSE transports. If conductor ever exposes an HTTP endpoint for multi-client use,
this becomes relevant.

### 15b. Structured Tool Output (`structuredContent` + `outputSchema`)

Formalised in this update; already covered in §11.

**Conductor status:** Fully implemented.

### 15c. `MCP-Protocol-Version` Header

All HTTP requests must include the `MCP-Protocol-Version` header (default `2025-03-26`
if absent). Server rejects mismatched versions.

**Conductor status:** N/A — stdio transport; SDK handles version negotiation at
initialisation.

### 15d. JSON-RPC Batching Removal

Batch requests (`[{...}, {...}]`) are no longer supported. Individual requests only.

**Conductor status:** N/A — the TypeScript SDK never relied on batching.

---

## Priority Matrix

Ranked by (impact × implementation ease), not novelty.

| Rank | Feature | Why now | Est. effort |
|------|---------|---------|------------|
| 1 | **Resource subscriptions** (`notifications/resources/updated`) | 5-line change in hub's server-connect callback. Makes catalog live. | XS (~1 h) |
| 2 | **Logging notifications** | Removes diag-trailer tokens from model context; gives Claude Desktop operator visibility. | S (~4 h) |
| 3 | **Prompts** | Slash commands in Claude Desktop for catalog/status/how-to. Zero token cost per invocation. | S (~6 h) |
| 4 | **Cancellation forwarding** | Stops Deno orphans; critical for long-running sandbox calls. SDK `AbortSignal` path. | S (~4 h) |
| 5 | **Resource links in tool results** | Cuts `discover_tools` inline cost; requires §1 resources (done). | S (~3 h) |
| 6 | **Progress for all tools** | Forward backend progress to client; wire `reload_servers` progress. | M (~8 h) |
| 7 | **Elicitation (form mode)** | Destructive-tool confirmation; step-by-step `add_server`. | M (~1 day) |
| 8 | **Tasks (`execute_code`)** | Non-blocking long scripts; pull-model for large results. | L (~3 days) |
| 9 | **Upstream annotation passthrough** | True annotations on passthrough tools; enables cache-by-hint. | M (~1 day) |
| 10 | **Sampling** | Server-side LLM sub-calls for routing inference / result compression. | L (~2 days) |
| 11 | **Elicitation (URL mode)** | OAuth re-auth for backend servers without restart. | L (~2 days) |
| 12 | **Roots** | Filesystem sandboxing; security hardening for execute_code. | M (~1 day) |

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Spec features fully used | 4 (annotations, structuredContent, outputSchema, icons) |
| Spec features partially used | 2 (resources, progress) |
| Spec features not used | 10 (prompts, sampling, roots, elicitation×2, logging, resource subscriptions, cancellation, tasks, resource links) |
| Quickest high-value win | Resource subscription notifications — ~5 lines |
| Highest-value unused feature | Tasks — non-blocking `execute_code` with pull-result model |
| Second-highest-value unused feature | Prompts — slash commands for catalog/status |
| Zero-implementation-cost fix | Logging notifications replaces diag-trailer tokens in context |
