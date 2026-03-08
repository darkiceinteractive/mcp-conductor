# Using MCP Conductor with Other AI Platforms

MCP Conductor works with **any AI tool that supports MCP servers**. While originally built for Claude, the Model Context Protocol is now supported across the AI ecosystem. This guide covers configuration for every major platform.

## How It Works

MCP Conductor is a standard MCP server that communicates over stdio. Any MCP client that can launch a subprocess and speak the MCP protocol can use it. The client doesn't need to be Claude — the sandbox, bridge, and all backend MCP servers work identically regardless of which AI is driving.

```
Any MCP Client → execute_code → Deno Sandbox → Your MCP Servers
```

---

## Claude Code

**Config file:** `~/.claude/settings.json`

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

## Claude Desktop

**Config files:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/claude/claude_desktop_config.json`

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

---

## OpenAI Codex CLI

[Codex CLI](https://developers.openai.com/codex/mcp/) supports MCP servers via TOML configuration.

**Config file:** `~/.codex/config.toml` (user) or `.codex/config.toml` (project)

```toml
[mcp_servers.mcp-conductor]
command = "npx"
args = ["-y", "@darkiceinteractive/mcp-conductor"]
```

Or via the CLI:

```bash
codex mcp add mcp-conductor -- npx -y @darkiceinteractive/mcp-conductor
```

**Note:** Codex uses TOML rather than JSON. Environment variables for backend servers are configured in `~/.mcp-conductor.json` as usual — only the MCP Conductor server itself is registered in Codex config.

---

## Google Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) supports MCP servers in its settings file.

**Config file:** `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project)

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

Gemini CLI supports environment variable expansion with `$VAR_NAME` syntax in env values, and optional `trust: true` to skip tool confirmations.

---

## Kimi Code CLI

[Kimi Code CLI](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html) (by Moonshot AI) supports MCP via a config file or CLI commands.

**Config file:** `~/.kimi/mcp.json`

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

Or via the CLI:

```bash
kimi mcp add --transport stdio mcp-conductor -- npx -y @darkiceinteractive/mcp-conductor
```

Verify with:

```bash
kimi mcp list
kimi mcp test mcp-conductor
```

---

## VS Code (GitHub Copilot)

[VS Code MCP](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) supports MCP servers for Copilot Chat agent mode.

**Config file:** `.vscode/mcp.json` (workspace) or user-level `mcp.json`

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

**Note:** VS Code uses `"servers"` (not `"mcpServers"`) and requires `"type": "stdio"`. It also supports `${input:variable-id}` for secure credential prompts.

---

## Cursor

[Cursor](https://cursor.com/docs/context/mcp) supports MCP servers at project and user level.

**Config file:** `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

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

**Note:** Cursor has a limit of ~40 active tools across all MCP servers. MCP Conductor helps here — it consolidates many backend servers into a handful of conductor tools.

---

## Windsurf (Cascade)

[Windsurf](https://docs.windsurf.com/windsurf/cascade/mcp) supports MCP servers via a config file or the MCP Marketplace.

**Config file:** `~/.codeium/windsurf/mcp_config.json`

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

Windsurf supports environment variable interpolation with `${env:VAR_NAME}` syntax. Tool limit is 100 across all servers.

---

## Cline

[Cline](https://docs.cline.bot/mcp/configuring-mcp-servers) (VS Code extension) manages MCP servers via its settings interface.

**Config file:** `cline_mcp_settings.json` (accessed via Cline settings UI)

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"],
      "disabled": false
    }
  }
}
```

You can also add servers through Cline's MCP settings panel in VS Code.

---

## Any MCP Client

MCP Conductor is a standard stdio MCP server. For any client not listed above, the pattern is the same:

1. **Command:** `npx`
2. **Args:** `["-y", "@darkiceinteractive/mcp-conductor"]`
3. **Transport:** stdio

The server reads its backend configuration from `~/.mcp-conductor.json` regardless of which client launches it.

---

## Backend Server Configuration

No matter which AI client you use, your backend MCP servers are always configured in `~/.mcp-conductor.json`:

```json
{
  "exclusive": true,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you"],
      "env": {}
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server"],
      "env": { "BRAVE_API_KEY": "BSA_xxx" }
    }
  }
}
```

This file is shared across all clients. Switch between Claude, Codex, Gemini, or any other MCP client without reconfiguring your backend servers.

---

## Platform Comparison

| Platform | Config Format | Config Location | Tool Limit | Notes |
|----------|--------------|-----------------|------------|-------|
| Claude Code | JSON | `~/.claude/settings.json` | None | Native MCP support |
| Claude Desktop | JSON | OS-specific path | None | Native MCP support |
| OpenAI Codex | TOML | `~/.codex/config.toml` | None | Also supports CLI `codex mcp add` |
| Gemini CLI | JSON | `~/.gemini/settings.json` | None | Supports OAuth, env sanitisation |
| Kimi Code CLI | JSON | `~/.kimi/mcp.json` | None | Also supports CLI `kimi mcp add` |
| VS Code | JSON | `.vscode/mcp.json` | None | Uses `"servers"` not `"mcpServers"` |
| Cursor | JSON | `.cursor/mcp.json` | ~40 tools | MCP Conductor helps consolidate |
| Windsurf | JSON | `~/.codeium/windsurf/mcp_config.json` | 100 tools | Has MCP Marketplace |
| Cline | JSON | Via settings UI | None | VS Code extension |

## Context7 Integration

[Context7](https://github.com/upstash/context7) is a complementary MCP server (by Upstash) that provides up-to-date documentation for any programming library. It's free and works alongside MCP Conductor.

Add Context7 as a backend server in `~/.mcp-conductor.json`:

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

Then from sandbox code:

```typescript
const ctx7 = mcp.server('context7');

// Look up a library
const lib = await ctx7.call('resolve-library-id', { libraryName: 'next.js' });

// Fetch docs
const docs = await ctx7.call('get-library-docs', {
  context7CompatibleLibraryID: lib.libraryID,
  topic: 'app router'
});

return { library: lib.libraryID, docSnippet: docs.content.slice(0, 500) };
```

This gives your sandbox code access to current documentation for any library — no hallucinated APIs, no outdated examples.
