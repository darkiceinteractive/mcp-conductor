# Getting Started

## What is MCP Conductor?

MCP Conductor is an MCP server that acts as an orchestration layer between Claude and your other MCP servers. Instead of Claude making direct tool calls — where every response gets permanently written into the context window — Claude writes small TypeScript programs that run in a sandboxed Deno environment. Those programs can call any of your MCP servers, do computation, filter data, and return only a compact summary.

The result: workflows that normally consume 40,000-50,000 tokens use 800-2,000 instead. That is a 90-98% reduction.

## Prerequisites

- **Node.js 18+** — `node --version`
- **Deno 2.x** — Install from [deno.land](https://deno.land)
- **Claude Code or Claude Desktop** — MCP Conductor requires a compatible Claude client

## Installation

### 1. Install Deno

```bash
# macOS
brew install deno

# Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows
winget install DenoLand.Deno
```

### 2. Add to Claude

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

### 3. Restart Claude

That's it. Ask Claude: *"list your MCP servers"* — you should see `mcp-conductor` with its tools.

## Adding Your Backend Servers

Create `~/.mcp-conductor.json` to register backend servers:

```json
{
  "exclusive": true,
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/yourname"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token" }
    }
  }
}
```

Set `"exclusive": true` to route all MCP calls through the sandbox. This is the recommended setting for maximum token savings.

**Hot reload:** Edit the file and save. Changes apply in ~500ms, no restart needed.

## Verify It Works

Ask Claude to run:

```
list your MCP servers
```

You should see `mcp-conductor` and all your configured backend servers. Then try:

```
Use execute_code to search for TypeScript files in my project and count them.
```

## Next Steps

- [[Configuration Guide]] — Fine-tune timeouts, memory limits, and modes
- [[MCP Tools Reference]] — All available tools and their parameters
- [[Sandbox API Reference]] — The `mcp` object API inside execute_code
- [[Execution Modes]] — Understand execution vs passthrough vs hybrid
