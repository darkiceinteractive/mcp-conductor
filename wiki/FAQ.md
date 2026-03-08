# FAQ

Frequently asked questions about MCP Conductor.

---

### What is MCP Conductor?

MCP Conductor is an MCP (Model Context Protocol) server that sits between Claude and your backend MCP servers. Instead of Claude making individual tool calls (each dumping raw JSON into the context window), Claude writes TypeScript that runs in a Deno sandbox. Only the compact return value enters context, saving 88–99% of tokens.

---

### How does it save tokens?

When Claude calls a tool directly (passthrough), the full raw response enters the context window. A GitHub `search_repositories` call might return 45,000 tokens of JSON. With MCP Conductor, Claude writes a few lines of TypeScript that filters and summarises the data in the sandbox, returning perhaps 800 tokens. The savings compound with multiple calls.

---

### What are the system requirements?

- **Node.js** 18 or later
- **Deno** 1.40 or later (for the sandbox)
- **Claude Code** or **Claude Desktop**

---

### Does it work with Claude Desktop?

Yes. Add MCP Conductor to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/claude/claude_desktop_config.json`

See [Getting Started](./Getting-Started) for the full configuration.

---

### What MCP servers does it support?

Any MCP server that communicates over stdio. Common examples:
- `@modelcontextprotocol/server-github`
- `@modelcontextprotocol/server-filesystem`
- `@brave/brave-search-mcp-server`
- Any custom MCP server

---

### What is exclusive mode?

When `exclusive: true`, Claude sees only MCP Conductor's tools — not the individual backend server tools. This forces all operations through the sandbox, maximising token savings and ensuring consistent security. This is the recommended setting.

---

### Can I still make direct tool calls?

Yes. Use `passthrough_call` for debugging, or switch to `passthrough` or `hybrid` mode via `set_mode`. In non-exclusive mode, Claude can also call backend server tools directly.

---

### How does the sandbox work?

User code runs in a Deno subprocess with minimal permissions. It can only communicate with the localhost HTTP bridge (no external network, no filesystem, no environment variables). The bridge routes tool calls through the MCP hub to backend servers.

---

### Is it secure?

The Deno sandbox enforces strict permission boundaries. See [Security Model](./Security-Model) for the full breakdown. Key points:
- Network restricted to `127.0.0.1` only
- No filesystem, environment, subprocess, or FFI access
- All I/O goes through logged, rate-limited MCP server calls

---

### How do I add a new MCP server?

Either add it to `~/.mcp-conductor.json` (hot-reload picks it up automatically) or use the `add_server` tool at runtime. See [Server Management](./Server-Management).

---

### How do I rate-limit an API?

Add a `rateLimit` block to the server config:

```json
{
  "rateLimit": {
    "requestsPerSecond": 1,
    "burstSize": 5,
    "onLimitExceeded": "queue",
    "maxQueueTimeMs": 30000
  }
}
```

See [Rate Limiting](./Rate-Limiting) for details.

---

### How do I check token savings?

Call `get_metrics` (no parameters). It returns total executions, average compression ratio, total tokens saved, and per-execution breakdowns. See [Metrics & Token Savings](./Metrics-and-Token-Savings).

---

### What's the difference between execution, passthrough, and hybrid modes?

| Mode | Behaviour | Token Impact |
|------|-----------|-------------|
| **Execution** (default) | All calls go through the Deno sandbox | Minimum tokens |
| **Passthrough** | Direct tool calls, raw JSON in context | Maximum tokens |
| **Hybrid** | Auto-selects based on task complexity | Variable |

See [Execution Modes](./Execution-Modes).

---

### Can I run multiple MCP Conductor instances?

Each instance needs its own bridge port. Configure different ports in separate config files to avoid conflicts.

---

### How do I debug sandbox code?

1. Use `console.log()` in sandbox code — messages are captured and returned
2. Switch to `passthrough` mode to see raw server responses
3. Use `mcp.progress()` for real-time progress updates
4. Check `get_metrics` for execution timing and error counts

---

### How do I contribute?

See [Contributing](./Contributing) for development setup, coding standards, and the PR process.
