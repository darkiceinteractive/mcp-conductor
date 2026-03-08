# Quickstart

Get MCP Conductor running in under 2 minutes.

## Step 1: Install Deno

Deno is the sandbox runtime. Install it once and MCP Conductor will use it automatically.

::: code-group

```bash [macOS / Linux]
curl -fsSL https://deno.land/install.sh | sh
```

```powershell [Windows]
irm https://deno.land/install.ps1 | iex
```

```bash [Homebrew (macOS)]
brew install deno
```

:::

Verify the installation:

```bash
deno --version
# deno 2.x.x (release, ...)
```

## Step 2: Add MCP Conductor to Claude

::: code-group

```json [Claude Code (~/.claude/settings.json)]
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

```json [Claude Desktop — macOS]
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

```json [Claude Desktop — Windows]
// %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

```json [Claude Desktop — Linux]
// ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

:::

::: tip First run
`npx -y` downloads the package on first use. Subsequent starts use the npm cache and are nearly instant.
:::

## Step 3: Restart Claude and Verify

Restart Claude Code or Claude Desktop completely. Once restarted, ask Claude:

> "List your MCP servers"

You should see `mcp-conductor` in the list. Then verify the sandbox is working:

> "Call get_metrics to show session stats"

Claude will call the tool and return a metrics object. If you see it, you are ready.

## Step 4: Configure Backend Servers

MCP Conductor is most useful when it has other MCP servers to work with. Add them to `~/.mcp-conductor.json`:

```json
{
  "exclusive": true,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    }
  }
}
```

::: info What is exclusive mode?
Setting `"exclusive": true` means Claude only sees `mcp-conductor` — it cannot call GitHub or filesystem directly. All MCP operations must go through `execute_code`. This enforces maximum token savings. See [Configuration](/guide/configuration) for details.
:::

Changes to `~/.mcp-conductor.json` are hot-reloaded within 500ms. No restart needed.

## Step 5: Your First execute_code Call

Ask Claude to run this:

```typescript
// Ask Claude: "Use execute_code to list my MCP servers and their tool counts"
const servers = await mcp.server('list').call('list_servers', {});
return servers;
```

Or have Claude do something useful immediately:

```typescript
// Ask Claude: "Use execute_code to search my filesystem for large TypeScript files"
const fs = mcp.server('filesystem');
const entries = await fs.call('list_directory', { path: '/Users/you/projects' });
const filtered = entries.entries
  .filter(e => e.name.endsWith('.ts'))
  .slice(0, 10);
return { count: filtered.length, files: filtered.map(f => f.name) };
```

That single call replaces what would have been dozens of individual tool calls.

## Verify Token Savings

After a few `execute_code` calls, check your metrics:

> "Call get_metrics"

You will see something like:

```json
{
  "session": {
    "executionCount": 5,
    "totalExecutionTimeMs": 1840
  },
  "tokenSavings": {
    "estimatedDirectCalls": 47,
    "actualCalls": 5,
    "savingsPercent": 89
  }
}
```

89% fewer tool calls in your context window.

## Next Steps

- Read [Concepts](/guide/concepts) to understand why this works so well
- See [Configuration](/guide/configuration) for the full `~/.mcp-conductor.json` reference
- Browse [Examples](/examples/file-search) for real-world patterns
- Check [MCP Servers](/guide/mcp-servers) for a catalogue of servers worth installing
