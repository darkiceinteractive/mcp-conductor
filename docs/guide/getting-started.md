# Getting Started

## What is MCP Conductor?

MCP Conductor is an MCP server that acts as an orchestration layer between Claude and your other MCP servers. Instead of Claude making direct tool calls — where every response gets permanently written into the context window — Claude writes small TypeScript programs that run in a sandboxed Deno environment. Those programs can call any of your MCP servers, do computation, filter data, and return only a compact summary.

The result is dramatic: workflows that would normally consume 40,000–50,000 tokens use 800–2,000 instead. That is a 90–98% reduction. Your context window stays clean, sessions run longer, and Claude Code API costs drop proportionally.

MCP Conductor does not replace your MCP servers. It wraps them. GitHub, filesystem, Brave Search, memory — they all continue to work exactly as before, but accessed through a `mcp.server('name').call('tool', params)` API inside the sandbox, rather than as individual tool calls that pollute context.

## How It Works

```
                    ┌─────────────────────────────────┐
                    │           Claude Code            │
                    │                                  │
                    │  "Search these 200 files and     │
                    │   summarize relevant ones"       │
                    └──────────────┬───────────────────┘
                                   │ execute_code (1 tool call)
                                   ▼
                    ┌─────────────────────────────────┐
                    │        MCP Conductor             │
                    │                                  │
                    │  Wraps code → spawns Deno        │
                    │  sandbox → collects result       │
                    └──────────────┬───────────────────┘
                                   │ HTTP bridge (localhost only)
                                   ▼
                    ┌─────────────────────────────────┐
                    │      Deno Sandbox (isolated)     │
                    │                                  │
                    │  const fs = mcp.server('fs')     │
                    │  const files = await fs.call()   │
                    │  return { summary, count }       │
                    └──────────────┬───────────────────┘
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                    ┌──────────┐     ┌──────────────┐
                    │ GitHub   │     │  Filesystem  │
                    │  server  │     │    server    │
                    └──────────┘     └──────────────┘
```

1. Claude calls `execute_code` with TypeScript code — one tool call.
2. MCP Conductor wraps the code and spawns an isolated Deno subprocess.
3. The sandbox has access to all your MCP servers via a localhost HTTP bridge.
4. The sandbox executes — calling MCP servers, processing data, filtering results.
5. Only the final `return` value crosses back into Claude's context.

Intermediate data — raw file contents, API responses, search results — never touches the context window. Claude sees only the compact conclusion.

## Why It Matters

### The context exhaustion problem

Every MCP tool call and its response is appended permanently to the context window. A task like "search these 50 TypeScript files for a particular pattern" would normally require 50 individual `read_file` calls, each response (potentially thousands of tokens) written into context. By the 10th file, context pressure is already affecting Claude's reasoning. By the 30th, you are approaching the context limit. By the 50th, the session may be unusable.

### The cost problem

With Claude Code's API pricing, large context windows translate directly to cost. A session that consumes 500,000 tokens due to repeated tool calls costs significantly more than one that uses 30,000 tokens to accomplish the same work. MCP Conductor brings the per-session cost down by the same 90–98% factor as the token reduction.

### The solution

MCP Conductor keeps data in the sandbox. The sandbox is like a scratchpad: it can hold megabytes of intermediate data, process it with TypeScript logic, and hand back just the conclusion. This is the difference between a developer who uses working memory efficiently (concise code, compact results) versus one who reads every intermediate result into the main chat (pollutes the conversation, forgets earlier context).

## Prerequisites

Before installing MCP Conductor, ensure you have:

- **Node.js 18 or later** — required to run MCP Conductor itself. Check with `node --version`.
- **Deno 2.x** — required for the sandbox runtime. Install from [deno.land](https://deno.land) or via the package manager commands in the [Quickstart](/guide/quickstart).
- **An MCP-compatible AI client** — Claude Code, Claude Desktop, OpenAI Codex, Google Gemini CLI, Kimi Code CLI, VS Code (Copilot), Cursor, Windsurf, Cline, or any tool that supports the Model Context Protocol. See the [MCP Clients guide](./mcp-clients.md) for setup instructions per platform.

Deno does not need to be on `PATH` accessible from within Claude; MCP Conductor will use the system Deno installation automatically.
