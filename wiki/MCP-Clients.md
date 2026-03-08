# MCP Clients — Multi-Platform Setup

MCP Conductor works with **any AI tool that supports MCP servers**. This page covers configuration for every major platform.

## Quick Reference

| Platform | Config Format | Config Location |
|----------|--------------|-----------------|
| Claude Code | JSON | `~/.claude/settings.json` |
| Claude Desktop | JSON | OS-specific (see below) |
| OpenAI Codex CLI | TOML | `~/.codex/config.toml` |
| Google Gemini CLI | JSON | `~/.gemini/settings.json` |
| Kimi Code CLI | JSON | `~/.kimi/mcp.json` |
| VS Code (Copilot) | JSON | `.vscode/mcp.json` |
| Cursor | JSON | `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| Windsurf (Cascade) | JSON | `~/.codeium/windsurf/mcp_config.json` |
| Cline | JSON | Via settings UI |

## How It Works

MCP Conductor is a standard stdio MCP server. Any MCP client that can launch a subprocess and speak the MCP protocol can use it. The AI platform doesn't matter — the sandbox, bridge, and all backend servers work identically.

---

## Claude Code

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

**File:** `~/.claude/settings.json`

## Claude Desktop

Same JSON format. Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/claude/claude_desktop_config.json`

---

## OpenAI Codex CLI

Codex uses TOML configuration.

```toml
[mcp_servers.mcp-conductor]
command = "npx"
args = ["-y", "@darkiceinteractive/mcp-conductor"]
```

**File:** `~/.codex/config.toml` (user) or `.codex/config.toml` (project)

**CLI alternative:** `codex mcp add mcp-conductor -- npx -y @darkiceinteractive/mcp-conductor`

**Docs:** [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp/)

---

## Google Gemini CLI

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

**File:** `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project)

Supports environment variable expansion (`$VAR_NAME`) and optional `"trust": true` to skip confirmations.

**Docs:** [Gemini CLI MCP docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

---

## Kimi Code CLI

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

**File:** `~/.kimi/mcp.json`

**CLI alternative:** `kimi mcp add --transport stdio mcp-conductor -- npx -y @darkiceinteractive/mcp-conductor`

**Verify:** `kimi mcp list` and `kimi mcp test mcp-conductor`

**Docs:** [Kimi CLI MCP docs](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html)

---

## VS Code (GitHub Copilot)

```json
{
  "servers": {
    "mcp-conductor": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

**File:** `.vscode/mcp.json` (workspace) or user-level `mcp.json`

**Note:** VS Code uses `"servers"` (not `"mcpServers"`) and requires `"type": "stdio"`.

**Docs:** [VS Code MCP configuration](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)

---

## Cursor

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

**File:** `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

**Note:** Cursor limits ~40 active tools across all servers. MCP Conductor helps by consolidating many backend servers into a handful of conductor tools.

**Docs:** [Cursor MCP docs](https://cursor.com/docs/context/mcp)

---

## Windsurf (Cascade)

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

**File:** `~/.codeium/windsurf/mcp_config.json`

Supports `${env:VAR_NAME}` interpolation. Tool limit is 100 across all servers.

**Docs:** [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp)

---

## Cline

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

Access via Cline settings panel in VS Code. Config stored in `cline_mcp_settings.json`.

**Docs:** [Cline MCP docs](https://docs.cline.bot/mcp/configuring-mcp-servers)

---

## Any Other MCP Client

For any client not listed above:

1. **Command:** `npx`
2. **Args:** `["-y", "@darkiceinteractive/mcp-conductor"]`
3. **Transport:** stdio

---

## Backend Server Configuration

Regardless of which AI client you use, backend MCP servers are always configured in `~/.mcp-conductor.json`. This file is shared across all clients — switch between Claude, Codex, Gemini, Kimi, or any other MCP client without reconfiguring your backend servers.

See [Configuration Guide](./Configuration-Guide) for full details.

## Context7 Integration

[Context7](https://github.com/upstash/context7) (by Upstash) provides live documentation for any programming library. Add it as a backend server in `~/.mcp-conductor.json`:

```json
{
  "servers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

Then from sandbox code, call `resolve-library-id` and `get-library-docs` to get current, version-specific documentation directly in your workflow.
