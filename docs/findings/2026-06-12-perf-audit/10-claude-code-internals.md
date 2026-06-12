# 10 — Claude Code Internals: MCP Tool Loading, Token Costs, and Client Behaviour

Captured: 2026-06-12  
Research method: primary-source fetch (docs.anthropic.com, code.claude.com, platform.claude.com, modelcontextprotocol.io, anthropics/claude-code GitHub issues)  
Scope: how the Claude Code CLI / Agent SDK client actually handles MCP tool schemas, system prompts, token windows, and dynamic updates — with implications for mcp-conductor tuning.

---

## Table of Contents

1. [Session startup: what loads and when](#1-session-startup-what-loads-and-when)
2. [Tool definitions: in system prompt or dynamic?](#2-tool-definitions-in-system-prompt-or-dynamic)
3. [Token cost per MCP tool](#3-token-cost-per-mcp-tool)
4. [Tool search: fuzzy / BM25 / regex discovery](#4-tool-search-fuzzy--bm25--regex-discovery)
5. [Deferred loading: `defer_loading` and `ENABLE_TOOL_SEARCH`](#5-deferred-loading-defer_loading-and-enable_tool_search)
6. [Dynamic tool updates: `notifications/tools/list_changed`](#6-dynamic-tool-updates-notificationstoolslist_changed)
7. [Prompt caching and MCP tools](#7-prompt-caching-and-mcp-tools)
8. [`serverInfo.instructions` field budget](#8-serverinfoinstructions-field-budget)
9. [Tool selection accuracy degradation](#9-tool-selection-accuracy-degradation)
10. [MCP server best practices from Anthropic](#10-mcp-server-best-practices-from-anthropic)
11. [Tool annotations (`readOnlyHint`, etc.)](#11-tool-annotations-readonlyhint-etc)
12. [`alwaysLoad` per-server exemption](#12-alwaysload-per-server-exemption)
13. [Hard tool caps and client limits](#13-hard-tool-caps-and-client-limits)
14. [Claude Desktop vs Claude Code: MCP handling differences](#14-claude-desktop-vs-claude-code-mcp-handling-differences)
15. [Skills and plugins vs MCP servers](#15-skills-and-plugins-vs-mcp-servers)
16. [Official Anthropic cost guidance](#16-official-anthropic-cost-guidance)
17. [Context engineering principles](#17-context-engineering-principles)
18. [Hidden features and undocumented behaviours](#18-hidden-features-and-undocumented-behaviours)

---

## 1. Session startup: what loads and when

Source: [code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window) (interactive simulation, 2026)

Claude Code builds the context window in a fixed layer order on every API call. Each layer is a stable prefix for prompt-caching purposes. Token counts below are from the official interactive simulator:

| Order | Layer | Tokens (typical) | Mutable mid-session? |
|-------|-------|-------------------|----------------------|
| 1 | System prompt (core instructions, tool defs, output style) | ~4 200 | No — locked at session start |
| 2 | Auto memory (MEMORY.md) | ~680 | No — reloads after `/clear` or `/compact` |
| 3 | Environment info (cwd, OS, git status) | ~280 | No |
| 4 | MCP tools **(deferred — only tool names)** | ~120 | Only changes when server connects/disconnects |
| 5 | Skill descriptions (one-liner per skill) | ~450 | Survives compaction only for invoked skills |
| 6 | `~/.claude/CLAUDE.md` | ~320 | No — reloads after clear/compact |
| 7 | Project CLAUDE.md | ~1 800 | No — reloads after clear/compact |
| 8+ | Conversation turns, tool results, file reads | variable | Every turn |

Key facts:
- The system prompt layer is assembled once at session start. Changes to tool definitions, model, or effort level invalidate it and bust the cache.
- MCP tools in deferred mode contribute only **~120 tokens** of tool-name stubs to the system prompt, not full schemas.
- The subagent system prompt is **smaller** (~900 tokens) — it skips auto-memory and loads only brief environment details plus the task prompt.

### Implication for mcp-conductor

mcp-conductor's `serverInfo.instructions` field (currently 3 086 chars / ~770 tokens — see baseline §8) sits inside layer 1 and is evaluated before any user turn. It is one of the most expensive non-negotiable tokens in the session. The baseline number is already competitive; it should not grow. Any reduction here directly improves the session prefix that the cache must warm over.

---

## 2. Tool definitions: in system prompt or dynamic?

Source: [platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [code.claude.com/docs/en/prompt-caching](https://code.claude.com/docs/en/prompt-caching)

The architecture changed fundamentally in early 2026 (Claude Code 2.1.x):

**Pre-2026 (legacy) behaviour:** Every MCP tool definition — name, description, full JSON Schema — was serialised into the system-prompt prefix on every API call. This meant all tool overhead was paid upfront, unconditionally. With 7+ MCP servers this reached 67 300 tokens (33.7% of a 200k window) before a single user message.

**Current behaviour (deferred / tool search):**

1. Tool definitions are sent to the API with `defer_loading: true`.
2. Only tool names (not schemas) appear in the system prompt prefix — approximately 120 tokens total for all MCP servers.
3. Full schemas are withheld from the cached prefix. When Claude needs a tool, it emits a `server_tool_use` call to `tool_search_tool_regex` or `tool_search_tool_bm25`.
4. The API returns 3–5 `tool_reference` blocks; these are auto-expanded into full definitions in the conversation turn (not the prefix).
5. Discovered tools are reused across subsequent turns in the same session without re-searching.
6. If the conversation is compacted, previously discovered tool definitions may be dropped and re-searched on next need.

The critical insight: **full tool schemas never appear in the cacheable prefix**. They are injected as conversation-turn content. This means:
- Adding a new tool to an already-running session does not bust the cache.
- Disconnecting a deferred-server mid-session also does not bust the cache.
- Only connecting a server whose tools are `alwaysLoad: true` (see §12) busts the cache.

### Implication for mcp-conductor

mcp-conductor's design — where 29 meta-tools are advertised at `tools/list` while 498 backend tools are hidden behind `discover_tools` — is **architecturally aligned with the deferred-loading model**. However, the 29 meta-tool schemas are **not currently deferred**; they load into the prefix on every session. Profiling the size of these 29 schemas and evaluating whether the least-used ones should be marked with `"anthropic/alwaysLoad": false` in `_meta` is a concrete optimisation.

---

## 3. Token cost per MCP tool

Sources: [MCP spec issue #2808](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2808), [jdhodges.com blog](https://www.jdhodges.com/blog/claude-code-mcp-server-token-costs/), [mindstudio.ai](https://www.mindstudio.ai/blog/claude-code-mcp-server-token-overhead), [github.com/anthropics/claude-code/issues/3406](https://github.com/anthropics/claude-code/issues/3406)

### Measured per-tool costs (pre-deferral, loaded into prefix)

| Server / Tool | Tools | Tokens |
|---------------|-------|--------|
| Playwright (22 tools) | — | ~3 442 |
| Gmail (7 tools) | — | ~2 640 |
| Codex (2 tools) | — | 610 |
| SQLite (6 tools) | — | 385 |
| **4-server total** | 37 | ~7 077 |
| **7 servers (reported in GH issue)** | — | 67 300 |

### Per-tool cost range

| Tool complexity | Token cost |
|-----------------|-----------|
| Minimal (SQLite avg) | ~64 tokens |
| Moderate | 100–300 tokens |
| Rich description (Gmail draft) | ~820 tokens |
| Heavy (browser automation w/ examples) | 370–800 tokens |
| Heavy (reported ~1 000 tokens/tool) | up to 1 024 tokens |

### Estimation formula

From community measurement:

```
tokens ≈ (number_of_tools × 200) + (total_chars_of_all_descriptions ÷ 4)
```

From the MCP spec issue, with 10× variance between a minimal schema and a heavily documented one, the description field is the dominant cost driver.

### Impact of deferral

With deferred loading, the 7-server / 67 300-token scenario collapses to ~120 tokens of stubs. The tool schemas are still paid when discovered, but only for the 3–5 tools actually used per query, and only once in the conversation turn (not in the cached prefix).

### Implication for mcp-conductor

mcp-conductor's 29 meta-tools are non-deferred (loaded via MCP `tools/list` response). The conductor must track schema size for each meta-tool. The ~770-token `serverInfo.instructions` baseline shows the "free" namespace overhead; the meta-tool schemas on top will dominate. The next audit priority is measuring the byte count of the full `tools/list` response (all 29 tool schemas serialised). Every 4 000 chars in a tool description ≈ 1 000 tokens. Aiming for the SQLite-tier (~65 tokens/tool) on the 10 least-used meta-tools and a moderate 200-token target on high-frequency ones would be a meaningful saving.

---

## 4. Tool search: fuzzy / BM25 / regex discovery

Sources: [platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [code.claude.com/docs/en/agent-sdk/tool-search](https://code.claude.com/docs/en/agent-sdk/tool-search), [anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use)

### The two search variants

**`tool_search_tool_regex_20251119`**
- Claude generates a Python `re.search()` pattern (not natural language)
- Common patterns: `"weather"`, `"get_.*_data"`, `"database.*query|query.*database"`, `"(?i)slack"`
- Maximum query length: 200 characters
- Best when Claude has prior knowledge of tool naming conventions

**`tool_search_tool_bm25_20251119`**
- Claude provides a natural language query
- BM25 scoring against tool names, descriptions, argument names, and argument descriptions
- Better for exploratory search when tool names are unknown

### What gets indexed

Both variants search across **all four fields**:
1. Tool name
2. Tool description
3. Argument names
4. Argument descriptions

This means token budget for discovery quality is best spent on descriptions, not just tool names. Keywords buried in argument descriptions are searchable.

### Search result format

Returns 3–5 `tool_reference` blocks per query:
```json
{
  "type": "tool_search_tool_result",
  "content": {
    "type": "tool_search_tool_search_result",
    "tool_references": [
      { "type": "tool_reference", "tool_name": "get_weather" }
    ]
  }
}
```

References are auto-expanded to full definitions before Claude sees them. The prefix cache is untouched. This means each tool search costs one extra round-trip but does not contaminate the cache.

### Limits

- Maximum catalog size: 10 000 tools
- Returns 3–5 tools per search
- No limit on how many search calls per conversation

### When tool search activates in Claude Code (`ENABLE_TOOL_SEARCH`)

| Setting | Behaviour |
|---------|-----------|
| (default / unset) | Tool search on; defers all MCP tools; falls back to upfront on Vertex AI and non-Anthropic `ANTHROPIC_BASE_URL` |
| `auto` | Checks combined token count vs 10% of context window; defers only if threshold exceeded |
| `auto:N` | Same, with custom % (e.g. `auto:5` = defer if tools >5% of window) |
| `true` | Forces tool search even on Vertex AI / proxy hosts |
| `false` | Loads all tools into prefix on every turn |

One extra round-trip per first discovery is acceptable for large tool sets but adds latency for sessions with ≤10 tools. Below that threshold, upfront loading is faster.

### Implication for mcp-conductor

mcp-conductor's existing `discover_tools` meta-tool is a **client-side implementation of the same pattern** the official tool search uses. When Claude Code (with `ENABLE_TOOL_SEARCH` active) connects to mcp-conductor, it will defer mcp-conductor's own 29 meta-tool schemas behind the official tool search mechanism. This creates a two-layer discovery path:

1. Claude searches the tool-search index, finds `discover_tools` or `execute_code`.
2. Claude calls `discover_tools("weather tools")`, which runs mcp-conductor's internal BM25/findTool index.
3. mcp-conductor returns a result; Claude calls `execute_code` to invoke the found backend tool.

The implication: mcp-conductor's meta-tool descriptions should be optimised for the official regex/BM25 index. Service-prefix keywords (`ibkr`, `tv`, `alphavantage`) in tool descriptions will surface the right meta-tool faster. The `discover_tools` description should contain keywords that align with the kinds of natural language queries users type, because tool-search is the outer discovery gate.

---

## 5. Deferred loading: `defer_loading` and `ENABLE_TOOL_SEARCH`

Source: [platform.claude.com tool-search-tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [code.claude.com prompt-caching](https://code.claude.com/docs/en/prompt-caching)

### How deferral works internally

> "Deferred tools are not included in the system-prompt prefix. When the model discovers a deferred tool through tool search, the API appends a `tool_reference` block inline in the conversation, then expands it into the full tool definition before passing it to Claude. The prefix is untouched, so prompt caching is preserved."

The grammar for strict mode (constraining tool-call output to match schemas) builds from the full toolset at request time, so `defer_loading` and strict mode compose without grammar recompilation.

### Cache preservation guarantee

> "Deferred tools: a server connecting, disconnecting, or changing its tool list only appends new content and doesn't disturb anything already cached."

This is the crucial cache guarantee. Conversely, tools loaded into the prefix invalidate the cache on any change.

### Error case: all tools deferred

If every tool including the search tool itself has `defer_loading: true`, Claude Code returns HTTP 400:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "All tools have defer_loading set. At least one tool must be non-deferred."
  }
}
```

The tool-search tool itself must never be deferred.

### Implication for mcp-conductor

The `execute_code` and `discover_tools` meta-tools are the analogues of the tool-search tool — they must always remain in the non-deferred set. In practice, mcp-conductor already achieves this since it returns all 29 meta-tools in a flat `tools/list` response. The question is whether Claude Code's own tool-search layer wraps those 29 schemas with deferral. If `ENABLE_TOOL_SEARCH` is default-on, the whole 29-tool set gets deferred by the client before Claude sees them — which means mcp-conductor's own discovery layer fires only after the outer layer resolves `discover_tools` or `execute_code`. Measurement of actual token spend with `/usage` in Claude Code is the next validation step.

---

## 6. Dynamic tool updates: `notifications/tools/list_changed`

Sources: [GH issue #13646](https://github.com/anthropics/claude-code/issues/13646), [GH issue #50339](https://github.com/anthropics/claude-code/issues/50339), [GH issue #31893](https://github.com/anthropics/claude-code/issues/31893), [Claude Code 2.1.0 release notes](https://www.contextstudios.ai/blog/claude-code-210-the-biggest-update-for-ai-developers-all-features-with-practical-examples/)

### Current status

| Client | Status | Notes |
|--------|--------|-------|
| Claude Code (CLI) 2.1+ | Partially supported | Notification received; tool-list refresh triggered on supported models. Edge cases remain (GH #13646 closed as duplicate of #4118 — not fully fixed). |
| Claude Desktop 1.3109.0 | **Broken** | Notification parsed but silently discarded. Root cause: empty `capabilities: {}` at construction time; handler gated on `onChanged` callback never supplied; tool list captured in frozen closure at connect time. |

### Claude Desktop root-cause detail (for server authors)

Three bugs combine to make `notifications/tools/list_changed` a no-op on Claude Desktop:

1. All five MCP client construction sites pass `capabilities: {}` — no `tools.listChanged` subscription is advertised.
2. The `_setupListChangedHandler` gating exists but `config.tools` is never provided by the caller.
3. The tool list (`const { tools }`) is captured as a `const` in the connect closure, never mutated.

**Workaround until fixed:** Declare all tools at startup. If server-side tool list must change, force the stdio process to exit — `LocalMcpServerManager` will reconnect. Document that users must restart Claude Desktop after server changes.

### Implication for mcp-conductor

mcp-conductor advertises `capabilities: { tools: { listChanged: true } }` to support dynamic tool registration (e.g., `add_server` adding new backend tools). This capability is **not respected by Claude Desktop** and only partially respected by Claude Code CLI. The practical consequence:

- For Claude Code CLI sessions, if mcp-conductor sends `notifications/tools/list_changed` after `add_server` succeeds, the tool list *may* refresh (model-dependent, not guaranteed).
- For Claude Desktop sessions, the notification is silently dropped. New tools from `add_server` are invisible until session restart.
- **Design recommendation:** mcp-conductor should not rely on `notifications/tools/list_changed` for correctness. Instead, the `list_servers` and `discover_tools` meta-tools provide an always-reliable alternative path. After `add_server`, Claude should call `discover_tools` to discover the new server's tools rather than waiting for the client to re-query `tools/list`.

---

## 7. Prompt caching and MCP tools

Source: [code.claude.com/docs/en/prompt-caching](https://code.claude.com/docs/en/prompt-caching) (comprehensive official doc)

### Cache layer structure

```
System prompt (tool defs, core instructions)
    └── Project context (CLAUDE.md, auto-memory)
         └── Conversation turns (changes every turn)
```

A change in any layer invalidates everything below it in the cache. Tool definitions sit in the system prompt layer — the most expensive layer to invalidate.

### Actions that bust the cache (MCP-relevant)

| Action | Cache impact | Notes |
|--------|-------------|-------|
| Connect or disconnect MCP server (deferred tools) | **No impact** | Only new content appended |
| Connect or disconnect MCP server (prefix-loaded tools) | **Full invalidation** | All conversation history must be reprocessed |
| `alwaysLoad: true` server tool list changes | **Full invalidation** | Same as prefix-loaded |
| Dynamic tool update via `notifications/tools/list_changed` (deferred) | **No impact** | Appended, not prefixed |
| Denying a bare tool name like `Bash` | Full invalidation | Removes from prefix |
| Switching model mid-session | Full invalidation | Each model has its own cache |
| Claude Code upgrade | Full invalidation | System prompt changes |

### Cache TTL

| Authentication | Default TTL | Extended TTL |
|----------------|-------------|-------------|
| Claude subscription (Pro/Max) | 1 hour (automatic) | — |
| API key / Bedrock / Vertex | 5 minutes | `ENABLE_PROMPT_CACHING_1H=1` for 1 hour |

### Cache scope

The cache is scoped to machine + working directory. The system prompt embeds `cwd`, platform, shell, OS version, and git status. Parallel sessions in the same directory share the cache. Different worktrees do not.

### Implications for mcp-conductor

1. **Instruction field stability matters.** The `serverInfo.instructions` field (3 086 chars) is part of the system prompt. If the content changes between sessions (e.g., server list varies because backends are flaky), the cached prefix is invalidated for every new session. The instructions should describe stable capabilities, not the live server count. The baseline already does this well (it lists 22 servers by name), but flaky-server lists that vary run-to-run would be harmful.

2. **Meta-tool schema stability.** Because the 29 meta-tool schemas sit in the prefix, any mcp-conductor upgrade that changes a tool description invalidates the cache for all users. Description changes should be batched in releases rather than deployed incrementally.

3. **deferred meta-tools would unlock a caching superpower.** If mcp-conductor registered the least-used meta-tools with `defer_loading: true` (via the `_meta` field: `"anthropic/alwaysLoad": false`), Claude Code would handle those tools as deferred. The stable set of high-frequency tools (e.g., `execute_code`, `discover_tools`, `list_servers`, `get_metrics`) would stay in the prefix, while rarely-used diagnostic tools (`set_diag_mode`, `set_compare_mode`, `compare_modes`, etc.) would not pollute the prefix or bust the cache.

---

## 8. `serverInfo.instructions` field budget

Sources: community measurement, code.claude.com docs, GH issues

### What the field is

The `serverInfo.instructions` field is returned in the MCP `initialize` response. Claude Code injects it into the system prompt for the session. It is the MCP server equivalent of a "persistent system prompt prefix."

### Reported constraints

- Claude Code **truncates** tool descriptions and server instructions at **2 KB each**.
- Keep them concise to avoid truncation; put critical details near the start.
- The field is loaded once and stays in the system prompt layer (prefix-cached).

### mcp-conductor baseline

- Current size: 3 086 characters → **above the 2 KB truncation threshold**.
- Estimated token cost: ~770 tokens.
- Content: catalog of 22 servers with capabilities summary, usage instructions, 6 backend server mini-descriptions.

### Implication for mcp-conductor

The instructions field is over the 2 KB limit. Claude Code is likely truncating it. This is a **live bug**: the bottom portion of the instructions (likely the bulk of backend server descriptions) is being silently dropped for every Claude Code session. The fix is to cut the instructions to ≤2 048 chars. Priority order for the kept content:

1. Single-sentence purpose statement
2. The `discover_tools` / `execute_code` usage pattern
3. At most 3–4 server-capability bullet points
4. Discard per-server example tool names from the instructions — those are discoverable

The server mini-descriptions and example tool names should be surfaced via the `conductor://catalog` resource instead, not the instructions field.

---

## 9. Tool selection accuracy degradation

Sources: [anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use), [startdebugging.net](https://startdebugging.net/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)

### Measured accuracy improvement with tool search

| Model | Without tool search | With tool search |
|-------|---------------------|-----------------|
| Opus 4 | 49% | 74% (+25 pp) |
| Opus 4.5 | 79.5% | 88.1% (+8.6 pp) |

### Threshold

Tool selection accuracy degrades significantly above **30–50 tools loaded in context simultaneously**. Below that threshold, upfront loading plus tool selection performs well. Above it, tool search not only saves tokens but **qualitatively improves correctness**.

### Context preservation improvement

| Scenario | Context tokens consumed |
|----------|------------------------|
| Traditional upfront (5-server, ~55k tool tokens) | 122 800 remaining |
| Tool search deferred | 191 300 remaining |
| Savings | 68 500 tokens (85%) |

At Anthropic's own scale: "we've seen tool definitions consume 134K tokens before optimisation."

### Implication for mcp-conductor

mcp-conductor exposes **29 meta-tools** in a flat list. This is safely below the 30-tool accuracy cliff. However, if `ENABLE_TOOL_SEARCH=false` were set by a user and mcp-conductor's backend tools were also exposed (e.g., if passthrough mode is enabled), the effective tool count could easily exceed 50 and degrade Claude's ability to pick the right tool. The conductor's separation of meta-tools from backend tools (via the catalog/discover pattern) is the correct architecture to maintain regardless of client-side tool-search settings.

---

## 10. MCP server best practices from Anthropic

Sources: [github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/mcp_best_practices.md](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/mcp_best_practices.md), code.claude.com/docs/en/mcp

### Naming conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Tool name | `snake_case`, service-prefixed, verb-first | `slack_send_message`, `github_create_issue` |
| Server name (Python) | `{service}_mcp` | `slack_mcp` |
| Server name (Node) | `{service}-mcp-server` | `slack-mcp-server` |
| Tool namespacing in Claude Code | `mcp__<servername>__<toolname>` | `mcp__github__create_issue` |

### Tool description requirements

- **Narrowly and unambiguously describe functionality**
- **Precisely match actual functionality** (no over-promising)
- Provide guidance on when NOT to use the tool
- Mention token limits and expected response times if relevant
- Include consistent, domain-specific keywords to improve BM25 search recall
- One-sentence primary description; optional secondary usage notes

### Description length

- No hardcoded character limit in the MCP spec, but:
- Claude Code truncates descriptions at **2 KB** per tool
- Practical target: 100–300 tokens (400–1 200 chars) for standard tools
- Minimal (SQLite-style): 40–100 tokens for CRUD ops with obvious semantics
- Avoid multi-paragraph examples in descriptions — use the `instructions` field for usage guides and link to docs

### Response format guidance

All data-returning tools should support:
- `response_format="json"` — machine-readable structured data
- `response_format="markdown"` — human-readable formatted text (timestamps, display names)

### Pagination

- Always respect a `limit` parameter
- Return `has_more`, `next_offset`/`next_cursor`, `total_count`
- Default limits: 20–50 items
- Never load all results into memory

### System prompt guide (official recommendation)

Add a sentence in the Claude system prompt (or skills file) describing available tool categories:

```
You can search for tools to interact with Slack, GitHub, and Jira.
```

This primes BM25 discovery without consuming description tokens.

### Implication for mcp-conductor

The current meta-tool descriptions were rewritten in commit `7853f39` ("rewrite meta-tool descriptions for discoverability"). The key checklist against official guidance:

- [ ] Verify each meta-tool name is verb-first snake_case with a service prefix where appropriate
- [ ] Verify no description exceeds 2 KB (check with `wc -c` on description strings in `mcp-server.ts`)
- [ ] Add argument descriptions that include domain keywords (BM25 searches them too)
- [ ] Audit whether the `execute_code` description mentions the downstream service names (ibkr, tv, etc.) so tool-search can route to it when a user asks "get Apple stock price"
- [ ] Consider a top-level system prompt snippet in the `instructions` field listing category keywords

---

## 11. Tool annotations (`readOnlyHint`, etc.)

Sources: [blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/), anthropics/skills mcp_best_practices.md

### The four hint fields

| Field | Default | Semantics |
|-------|---------|-----------|
| `readOnlyHint` | `false` | Tool does not modify its environment |
| `destructiveHint` | `true` | Tool may perform irreversible/destructive updates |
| `idempotentHint` | `false` | Repeated calls with identical args have no additional effect |
| `openWorldHint` | `true` | Tool interacts with external entities beyond local scope |

### How clients use them

Annotations are a "basic risk vocabulary" for UX decisions:
- Confirmation dialogs: destructive tools trigger approval flows; read-only tools skip them
- Output scrutiny: open-world tools receive heightened examination for prompt injection
- Session risk assessment: combinations of annotations signal exfiltration risk (private data + untrusted content + external comms = "lethal trifecta")

### Security constraint

Annotations are **hints, not guarantees**. An untrusted server can lie. Clients must treat annotations from untrusted servers as informational only; actual safety boundaries require deterministic controls (sandboxing, network rules).

### Recommended usage

- `readOnlyHint: true` on all read-only query tools
- `destructiveHint: false` on additive-only operations
- `openWorldHint: false` on tools operating exclusively within a closed domain
- Defaults are deliberately pessimistic (assume destructive, assume open-world)

### Implication for mcp-conductor

mcp-conductor's meta-tools span a wide risk range:
- `list_servers`, `get_metrics`, `get_capabilities`, `discover_tools` → `readOnlyHint: true`, `openWorldHint: false`
- `execute_code` → `readOnlyHint: false`, `openWorldHint: true`, `destructiveHint` varies by backend
- `set_mode`, `set_diag_mode` → `readOnlyHint: false`, `openWorldHint: false`, `idempotentHint: true`
- `add_server`, `remove_server`, `reload_servers` → `destructiveHint: true`
- `record_session`, `stop_recording`, `replay_session` → `destructiveHint` varies

Annotating all 29 meta-tools correctly would: (a) allow Claude Code to skip confirmation dialogs for read-only queries, improving latency; (b) flag destructive operations for approval; (c) make intent legible to downstream orchestrators and security auditors.

---

## 12. `alwaysLoad` per-server exemption

Sources: [github.com/anthropics/claude-code/releases/tag/v2.1.121](https://github.com/anthropics/claude-code/releases/tag/v2.1.121), code.claude.com mcp docs, community issue trackers

### Server-level flag

In `.mcp.json` or inline `mcpServers`, adding `alwaysLoad: true` exempts that server from deferral:

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["@darkiceinteractive/mcp-conductor"],
      "alwaysLoad": true
    }
  }
}
```

Effect: every tool from that server loads into the prefix at session start, regardless of `ENABLE_TOOL_SEARCH`. This also **blocks startup** until the server connects (capped at 5-second timeout).

### Per-tool flag

Individual tools within a server can be marked via the tool's `_meta` object:

```json
{
  "name": "execute_code",
  "_meta": {
    "anthropic/alwaysLoad": true
  }
}
```

Tools with this flag load into the prefix even when the parent server is deferred.

### Trade-off

`alwaysLoad: true` at the server level is appropriate for servers whose tools are used on every turn (e.g., a filesystem server in a coding assistant). It converts the server's tools back to the pre-deferral model for that server.

### Implication for mcp-conductor

mcp-conductor's power users may benefit from setting `alwaysLoad: true` on specific high-frequency meta-tools (`execute_code`, `discover_tools`, `list_servers`) while leaving diagnostic/management tools deferred. The per-tool `_meta` approach is more surgical than the server-level flag. mcp-conductor should document this trade-off in its setup guide so users can make an informed choice:

- `alwaysLoad: true` (whole server) → all 29 meta-tool schemas in the prefix → guaranteed availability, ~3–8k additional tokens
- Default (deferred) → ~120 token stubs → tool search needed to resolve schemas → one extra round-trip on first use but cache-safe

---

## 13. Hard tool caps and client limits

Sources: [GH microsoft/vscode #290356](https://github.com/microsoft/vscode/issues/290356), [startdebugging.net](https://startdebugging.net/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/), platform.claude.com docs

### Anthropic API

- Maximum tool catalog size with tool search: **10 000 tools**
- No hard cap without tool search; practical limit is context window budget
- Tool search returns 3–5 per query

### Claude Code CLI

- No fixed tool number cap documented
- Practical limit is context window budget (200k for most models)
- `ENABLE_TOOL_SEARCH=auto` triggers at 10% of context window (default)

### VS Code / GitHub Copilot

- Hard cap of **128 tools** enforced by VS Code's tool picker UI
- Exceeding this generates "Tool limit exceeded" error requiring manual deselection
- This is a **client UI constraint**, not a model or API constraint

### MCP spec recommendation

From the spec issue tracker: degradation becomes noticeable above 30–50 concurrently loaded tools. Tool search resolves this at any scale.

### Implication for mcp-conductor

If a VS Code user connects mcp-conductor with all 22 backend servers active and passthrough mode enabled, the cumulative tool count (29 meta + up to 498 backend) can exceed 128. The conductor's default behaviour (meta-tools only in `tools/list`) is already the correct mitigation. The passthrough mode documentation should warn about the 128-tool VS Code limit and recommend against enabling it in VS Code environments.

---

## 14. Claude Desktop vs Claude Code: MCP handling differences

Sources: [code.claude.com MCP docs](https://code.claude.com/docs/en/mcp), community comparisons, GH issue #50339

### Transport support

| Feature | Claude Code (CLI) | Claude Desktop |
|---------|-------------------|---------------|
| stdio | Yes | Yes |
| HTTP/SSE | Yes (native) | Limited (local-only in some versions) |
| OAuth via HTTP | Yes | Yes |
| Remote MCP servers | Yes | Yes (recent versions) |

### Tool loading

| Feature | Claude Code (CLI) 2.1+ | Claude Desktop 1.3109.0 |
|---------|----------------------|------------------------|
| Deferred loading (tool search) | Default on | Not supported |
| `notifications/tools/list_changed` | Partially implemented | **Silently ignored** |
| `alwaysLoad` per-server | Yes (v2.1.121+) | Unknown |

### MCP spec compliance gaps (Claude Desktop)

The `directMcpHost` class in Claude Desktop bundles several compliance bugs:
1. `capabilities: {}` at client construction — no `tools.listChanged` subscription declared
2. `_setupListChangedHandler` never invoked (callback not wired)
3. Tool list captured in a `const` binding, never mutated on notification
4. 336 version bumps (v1.2773.0 → v1.3109.0+) without fix

This has been present for the full history of the deferred-tool era.

### Cost model difference

Claude Desktop does not expose `/usage` command or granular token breakdown. Claude Code CLI has `/usage`, `/context` commands, and can display per-MCP-server attribution.

### Implication for mcp-conductor

mcp-conductor must be designed for the most constrained client — Claude Desktop. This means:
1. All tools must be declared at startup (no dynamic registration via `list_changed`).
2. The `add_server` and `remove_server` meta-tools should document that newly added backend tools are visible to Claude Code but require restart to appear in Claude Desktop.
3. The `serverInfo.instructions` field must be within 2 KB and front-load the most critical information, because truncation behaviour on Claude Desktop may differ from Claude Code.

---

## 15. Skills and plugins vs MCP servers

Sources: [code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs), [codersera.com](https://codersera.com/blog/claude-skills-mcp-servers-practitioner-guide-2026/), [code.claude.com context window doc](https://code.claude.com/docs/en/context-window)

### Token cost comparison

| Component | Upfront token cost | Load-on-demand |
|-----------|-------------------|---------------|
| MCP tools (without deferral) | 100–820 tokens per tool | No |
| MCP tools (deferred, default) | ~5 tokens per name stub | Yes (tool search) |
| Skills | ~30–50 tokens per skill description | Yes (invocation loads SKILL.md, up to ~5 000 tokens) |
| Plugins (MCP-backed) | Same as MCP tools | Same as MCP |
| Plugins (skills/hooks only) | Same as skills | Yes |
| CLAUDE.md | All of it, every session | No |
| Rules with `paths:` frontmatter | Zero until matching file read | Yes (auto-triggers on file read) |

### Key insight

Skills and path-scoped rules are the **cheapest** way to inject domain knowledge: they load only when needed, add no per-turn prefix cost, and do not bust the cache when changed mid-session.

The official recommendation:

> "Move instructions from CLAUDE.md to skills. CLAUDE.md is loaded into context at session start. If it contains detailed instructions for specific workflows, those tokens are present even when you're doing unrelated work. Skills load on-demand only when invoked. Aim to keep CLAUDE.md under 200 lines."

> "Prefer CLI tools when available. Tools like `gh`, `aws`, `gcloud`, and `sentry-cli` are still more context-efficient than MCP servers because they don't add any per-tool listing."

### Plugin marketplace (2026)

The official Anthropic-managed marketplace (`anthropics/claude-plugins-official`) ships 101 vetted plugins plus 68 partner plugins (GitHub, Playwright, Supabase, Figma, Vercel, Linear, Sentry, Stripe, Firebase).

### Implication for mcp-conductor

The skill/plugin architecture offers a complementary distribution mechanism. mcp-conductor could publish a lightweight skill that:
- Explains the `discover_tools` → `execute_code` usage pattern
- Lists the configured server categories (so BM25 can route)
- Provides example invocations

This skill would cost ~50 tokens at session start (one-liner description) and load its full SKILL.md (~1 000 tokens) only when invoked. This is cheaper than embedding the same content in `serverInfo.instructions` (which is always paid).

---

## 16. Official Anthropic cost guidance

Source: [code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)

### Authoritative numbers

- Average enterprise cost: **~$13 per developer per active day**, $150–250/month
- 90th percentile cap: <$30/active day
- Background token usage (idle): typically <$0.04/session

### MCP-specific guidance (verbatim from official docs)

> "MCP tool definitions are deferred by default, so only tool names enter context until Claude uses a specific tool. Run `/context` to see what's consuming space."
>
> "Prefer CLI tools when available: Tools like `gh`, `aws`, `gcloud`, and `sentry-cli` are still more context-efficient than MCP servers because they don't add any per-tool listing."
>
> "Disable unused servers: Run `/mcp` to see configured servers and disable any you're not actively using."

### Cost optimisation hierarchy (from official docs)

1. Model selection (Sonnet vs Opus) — largest lever
2. MCP server reduction (disable unused)
3. CLAUDE.md size (move to skills)
4. Context management (`/clear` between tasks)
5. Hooks to preprocess verbose output
6. Subagents for isolated high-volume operations
7. Specific vs vague prompts

### Implication for mcp-conductor

The official guidance confirms that mcp-conductor's approach (hide backend tool schemas, expose 29 meta-tools) is structurally aligned with Anthropic's own cost advice. The conductor should surface this alignment in its documentation: "mcp-conductor's deferred-discovery model follows Anthropic's recommended cost pattern for MCP gateways."

---

## 17. Context engineering principles

Source: [anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### Core principle

> "Find the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."

Context is a finite attention budget. Models suffer "context rot" — performance degradation as sequence length increases — due to n² attention cost.

### Just-in-time retrieval

> "Agents maintain lightweight identifiers (file paths, stored queries, web links) and dynamically load data at runtime using tools."

This is the theoretical basis for deferred tool loading. The principle generalises:
- Tool schemas = documents
- Tool names = identifiers
- Tool search = just-in-time retrieval

### Sub-agent architecture for context isolation

Sub-agents handle focused tasks with clean context windows, returning condensed summaries (typically 1 000–2 000 tokens) to a coordinating main agent. This achieves "separation of concerns."

### Compaction strategy

Three specialised compaction techniques:
1. **Summarisation**: Replace conversation history with a summary. Preserve architectural decisions, unresolved bugs, implementation details. Discard redundant tool outputs.
2. **Structured note-taking**: Agents maintain persistent files outside context window, pulled back when needed.
3. **Sub-agents**: Return distilled summaries rather than raw outputs.

### Minimal tool overlap

> "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better."

Overlapping tool definitions force the model to make arbitrary choices. Tools must have clear, mutually exclusive boundaries.

### Implication for mcp-conductor

1. **Result token budgeting (`max_result_tokens` guard, already in `feat/lean-defaults`)** is the correct implementation of "smallest possible set of high-signal tokens." The 2026-06-12 baseline confirms this feature is active.

2. **Tool boundary clarity**: mcp-conductor's 29 meta-tools must have non-overlapping semantics. If both `execute_code` and `passthrough_call` can invoke a backend tool, Claude will be confused about which to use. The descriptions must encode clear decision rules ("use `execute_code` when you need to run multi-step logic; use `passthrough_call` for single direct RPC calls").

3. **Session result compression**: The `compact` / `summarize` / `delta` sandbox tools (introduced in v3 Phase 5) are the correct mechanism for returning distilled results. The official guidance validates this design.

---

## 18. Hidden features and undocumented behaviours

Collected from GitHub issues, community reports, and official changelogs.

### `_meta.anthropic/alwaysLoad`

Per-tool granular exemption from deferral via the tool's `_meta` object:

```json
{
  "name": "my_tool",
  "_meta": {
    "anthropic/alwaysLoad": true
  }
}
```

Undocumented in the main MCP spec; only mentioned in Claude Code release notes for v2.1.121.

### `ENABLE_TOOL_SEARCH` falls back on proxies

If `ANTHROPIC_BASE_URL` points to a non-Anthropic proxy (e.g., LiteLLM, OpenRouter), tool search is **disabled by default** because most proxies do not forward `tool_reference` blocks. Setting `ENABLE_TOOL_SEARCH=true` forces it, but requests will fail if the proxy strips the blocks. This affects any enterprise deployment routing through an LLM gateway.

### `/context` command

Claude Code exposes a `/context` command that shows a live breakdown of what is consuming context window space, with per-MCP-server attribution. This is the primary observability tool for diagnosing mcp-conductor overhead in production.

### Tool search usage tracking

The API response `usage` object includes a `server_tool_use.tool_search_requests` counter, allowing host applications to track how many BM25/regex searches Claude performed per turn.

### `MAX_MCP_OUTPUT_TOKENS`

Claude Code warns when a single MCP tool result exceeds **10 000 tokens** and truncates at a **25 000 token** default. This is tunable via `MAX_MCP_OUTPUT_TOKENS`. The mcp-conductor `max_result_tokens` guard added in `feat/lean-defaults` is an application-level enforcement of a similar limit. If the user sets `MAX_MCP_OUTPUT_TOKENS` lower than conductor's guard, the client-side truncation fires first (silently).

### Subagent tool set

Subagents receive "most of the parent's tools, minus several that don't apply in a nested context, including plan-mode controls, background-task tools, and by default the Agent tool itself to prevent recursion." This means mcp-conductor's meta-tools (which include `record_session`, `replay_session`, background tools) may be stripped from subagent contexts automatically. Tool availability in subagents is not guaranteed to match the parent session.

### Cache scope: git status in system prompt

The system prompt embeds the **current git branch and recent commits**. This means two sessions in the same directory on different branches have different cache prefixes and do not share cache. For automated CI/CD use of mcp-conductor, cache warm-up from one branch does not carry over to another.

### `DISABLE_AUTOUPDATER=1`

Prevents Claude Code auto-updates from applying mid-session. Since updates invalidate the system prompt cache, pinning the version during a long automated session avoids unexpected cache busts.

### Claude Code system prompt: 110+ modular strings

The Claude Code system prompt is not a single monolithic file. It is assembled from 110+ conditional strings per session based on environment, plugins, model, and context. This has been reverse-engineered and tracked across 206 versions in the [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) repository. The Bash tool alone contributes ~1 665 tokens from multiple conditional chunks.

### Built-in tool token costs (from reverse-engineered system prompt)

| Built-in tool | Tokens |
|---------------|--------|
| Write | 129 |
| Edit | 202 |
| ReadFile | 412 |
| REPL | 715 |
| EnterPlanMode | 881 |
| Artifact | 712 |
| Bash | ~1 665 (multi-chunk) |
| TodoWrite | 2 037 |
| Workflow | 4 837 |
| Total (all 27 builtins) | ~10 000–11 000 |

The built-in tools alone consume 10–11k tokens before any MCP server is connected.

### Implication for mcp-conductor

1. `MAX_MCP_OUTPUT_TOKENS` is a client-side truncation that fires before mcp-conductor's own `max_result_tokens` guard if set lower. The conductor should detect truncation markers in returned content and log a warning.

2. Subagent tool stripping means mcp-conductor's management tools (`record_session`, `replay_session`) may be unavailable in subagent contexts. The conductor should not rely on these being callable from within a subagent. Testing against a spawned subagent is a recommended integration-test gap.

3. The git-status-in-system-prompt cache scope issue means cache warm-up benchmarks should account for branch. CI benchmarks run against the test branch will have a different (cold) cache than production sessions on `main`.

---

## Key numbers summary

| Metric | Value | Source |
|--------|-------|--------|
| System prompt (layer 1) | ~4 200 tokens | Official context window doc |
| MCP tools — deferred stubs only | ~120 tokens | Official context window doc |
| MCP tools — full schemas (pre-deferral, 7 servers) | 67 300 tokens | GH issue #11364 |
| Per-tool cost range | 64–1 024 tokens | Measured / GH issue #2808 |
| Tool search context saving | 85% / ~68 500 tokens | Advanced tool use article |
| Tool selection accuracy >50 tools (no search) | ~49% (Opus 4) | Advanced tool use article |
| Tool selection accuracy with tool search | 74–88% | Advanced tool use article |
| `serverInfo.instructions` truncation threshold | 2 048 chars | Community + official |
| mcp-conductor instructions field (current) | 3 086 chars (~770 tokens) | Baseline doc §8 |
| Hard VS Code tool cap | 128 | MS/vscode GH issue |
| API tool catalog max (with tool search) | 10 000 | Official docs |
| `MAX_MCP_OUTPUT_TOKENS` default | 25 000 tokens | Claude Code docs |
| Cache TTL (subscription) | 1 hour (auto) | Official prompt-caching doc |
| Cache TTL (API key) | 5 minutes (default) | Official prompt-caching doc |
| Built-in tools token cost | ~10 000–11 000 tokens | Piebald-AI reverse engineering |

---

## Top-5 action items for mcp-conductor

1. **Cut `serverInfo.instructions` to ≤2 048 chars.** The current 3 086-char field is being truncated by Claude Code. Critical usage instructions are silently lost. Target: 1 200–1 800 chars. Move server mini-descriptions to `conductor://catalog` resource.

2. **Audit all 29 meta-tool description sizes.** Run `grep -A5 'registerTool' src/server/mcp-server.ts` and measure description byte counts. Any description exceeding 800 chars (~200 tokens) should be shortened or split. Target the SQLite-tier for management/diagnostic tools (~64 tokens) and the "moderate" tier for high-frequency tools (~200 tokens).

3. **Add tool annotations to all 29 meta-tools.** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. This improves UX (no confirmation dialogs for read-only tools) and is required for compliant server behaviour per the March 2026 MCP blog post.

4. **Classify meta-tools by `alwaysLoad` need.** High-frequency tools (`execute_code`, `discover_tools`, `list_servers`, `get_metrics`, `get_capabilities`) may benefit from `"anthropic/alwaysLoad": true` in their `_meta` object. Low-frequency tools (`set_diag_mode`, `set_compare_mode`, `compare_modes`, `record_session`, `replay_session`, `stop_recording`, `predict_cost`) should remain deferred. Document this in the setup guide.

5. **Document `notifications/tools/list_changed` limitations.** After `add_server`, Claude Code may refresh the tool list; Claude Desktop will not. The `discover_tools` meta-tool is the reliable alternative path for both clients. Update the `add_server` tool description to say: "After adding a server, call discover_tools to access its tools. Tool list auto-refresh is client-dependent."

---

## Sources

- [Tool search tool — Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Scale to many tools with tool search — Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/tool-search)
- [MCP spec issue #2808: Tool schema token overhead](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2808)
- [GH issue #11364: Lazy-load MCP tool definitions](https://github.com/anthropics/claude-code/issues/11364)
- [GH issue #3406: Built-in tools + MCP token overhead](https://github.com/anthropics/claude-code/issues/3406)
- [GH issue #13646: notifications/tools/list_changed not refreshed](https://github.com/anthropics/claude-code/issues/13646)
- [GH issue #50339: Claude Desktop ignores list_changed](https://github.com/anthropics/claude-code/issues/50339)
- [Explore the context window — Claude Code docs](https://code.claude.com/docs/en/context-window)
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Manage costs effectively — Claude Code docs](https://code.claude.com/docs/en/costs)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Introducing advanced tool use — Anthropic Engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- [Effective context engineering for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [MCP server best practices — anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/mcp_best_practices.md)
- [Tool Annotations as Risk Vocabulary — MCP blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [Piebald-AI/claude-code-system-prompts — reverse-engineered system prompt](https://github.com/Piebald-AI/claude-code-system-prompts)
- [MCP server token costs breakdown — jdhodges.com](https://www.jdhodges.com/blog/claude-code-mcp-server-token-costs/)
- [Claude Code MCP server token overhead — mindstudio.ai](https://www.mindstudio.ai/blog/claude-code-mcp-server-token-overhead)
- [How to reduce MCP tools to avoid tool-use limit — startdebugging.net](https://startdebugging.net/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)
- [Claude Code v2.1.121 release — GitHub](https://github.com/anthropics/claude-code/releases/tag/v2.1.121)
- [Feature: expose defer_loading config per MCP server — claude-agent-sdk-typescript #281](https://github.com/anthropics/claude-agent-sdk-typescript/issues/281)
