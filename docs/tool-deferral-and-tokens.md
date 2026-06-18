# Tool Deferral and Token Footprint (Claude Code)

This page explains how Claude Code's tool-deferral mechanism interacts with MCP Conductor, what it means for your actual token costs, and the one client-side setting you might ever need to touch.

---

## How Tool Deferral Works

When Claude Code starts a session, it does **not** load every MCP tool's full JSON schema into the context window up front. Instead it loads only the tool **names**. A tool's complete schema — its parameter definitions, descriptions, and constraints — is fetched on demand by the `ToolSearch` mechanism, and only for the tools Claude actually decides to call in that turn.

This behaviour applies automatically to all of Conductor's ~25 tools. No configuration is needed on your part.

The consequence for token costs is significant:

| What loads at session start | What stays out of context |
|-----------------------------|---------------------------|
| Conductor's ~25 tool **names** (cheap) | Conductor's ~25 full tool **schemas** (loaded on demand) |
| — | All 21+ downstream servers aggregated by Conductor |
| — | Every backend tool's schema (499+ tools in a typical installation) |

Conductor's downstream servers and their tools never appear in the model's context window at all — they live inside Conductor's hub and are reachable only through `execute_code` and `discover_tools`. Keeping that surface out of context is the whole point.

> **In practice:** the dominant token cost in a Conductor session is the *result* data that flows back to the model, not tool schemas. That is where Conductor's 88–99% compression pays off. See [Architecture](./v3/architecture.md) for details on how the Deno sandbox compresses result data before it reaches the context window.

---

## The `ENABLE_TOOL_SEARCH` Setting

`ENABLE_TOOL_SEARCH` is a Claude Code client-side environment variable (or `env` entry in `~/.claude/settings.json`) that controls when tool schemas are deferred versus loaded upfront.

| Value | Behaviour | When to use it |
|-------|-----------|----------------|
| *(unset)* | Default: all MCP tool schemas deferred on the Anthropic-hosted API. Schemas are fetched on demand via `ToolSearch`. | **Recommended.** Leave it unset. |
| `true` | Force deferral unconditionally, regardless of API provider. | Vertex AI or a custom `ANTHROPIC_BASE_URL` where the default would otherwise load schemas upfront. |
| `auto` | Threshold mode: load schemas upfront only if they fit within 10% of the context window; defer the rest. | Not needed with Conductor — Conductor's tool count is always within safe limits. |
| `auto:N` | Threshold mode with a custom percentage. E.g. `auto:5` uses 5% of the context window as the cut-off. | Rarely needed. |
| `false` | Disable deferral. Load all tool schemas into context at session start. | **Not recommended with Conductor.** Wastes context on schemas you may never use in a given session. |

### Setting via `~/.claude/settings.json`

```json
{
  "env": {
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

### Setting via environment variable

```bash
export ENABLE_TOOL_SEARCH=true
```

> **Note on description truncation:** Even when a tool schema is loaded into context, Claude Code truncates tool descriptions and server instructions at approximately 2 KB each. This is a client-side limit that applies regardless of the `ENABLE_TOOL_SEARCH` value.

---

## Recommended Setup — Leave It at the Default

For most users on the Anthropic-hosted API (Claude.ai, Claude Code with a standard API key), the default behaviour is already optimal:

- Tool schemas are deferred automatically.
- Claude fetches only the schema for a tool it is about to call.
- Conductor's backend tools never enter the context window.
- You do not need to set `ENABLE_TOOL_SEARCH` at all.

The **only** reason to set `ENABLE_TOOL_SEARCH` is if you are running Claude Code against a non-Anthropic endpoint (Vertex AI, a custom proxy) and you notice that tool schemas are being loaded eagerly. In that case, set it to `true` to force deferral.

```
Bottom line: the real token savings come from using execute_code to batch
work inside the sandbox — not from tuning tool-exposure config.
```

---

## Checking Your Token Footprint

You can verify token usage at any time using Conductor's built-in metrics:

```typescript
// Pass show_token_savings: true on any execute_code call
{
  "tool": "execute_code",
  "input": {
    "code": "return mcp.server('github').call('list_issues', { owner: 'myorg', repo: 'myrepo' })",
    "show_token_savings": true
  }
}
```

The response includes an estimated passthrough token count versus actual execution tokens. Session totals are available via `get_metrics`.

---

## Related

- [Architecture](./v3/architecture.md) — How the Deno sandbox compresses result data
- [Configuration](./v3/configuration.md) — Conductor-side config options
- [Sandbox API](./v3/sandbox-api.md) — The `mcp` object inside `execute_code`
- [Troubleshooting](./troubleshooting.md) — Common issues and diagnostics
