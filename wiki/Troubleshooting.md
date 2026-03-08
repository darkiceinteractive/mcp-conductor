# Troubleshooting

Common issues and their solutions.

## Quick Diagnostics

```bash
# Check Deno is installed
deno --version

# Verify config file exists and is valid JSON
cat ~/.mcp-conductor.json | python3 -m json.tool

# Check server status (via Claude)
# Ask Claude to call list_servers
```

---

## Deno Not Found

**Symptom:**
```
Error: Deno not found
```

**Fix:** Install Deno:

```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh

# macOS with Homebrew
brew install deno

# Windows
irm https://deno.land/install.ps1 | iex
```

Ensure `deno` is on your `PATH`. Verify with `deno --version`.

---

## Server Not Found

**Symptom:**
```
Error: Server not found: github
```

**Causes:**
1. Server not defined in `~/.mcp-conductor.json`
2. Server name in code doesn't match config key
3. Server in the deny list
4. Server failed to connect (check `list_servers` for status)

**Fix:** Verify the server is in your config and the name matches exactly:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

---

## Server Connection Error

**Symptom:**
```
Server 'github' status: error
```

**Causes:**
1. Missing or invalid environment variables (API keys)
2. npx failing to install the server package
3. Server process crashing on startup

**Fix:**
- Check env vars are set in the config
- Try running the server command manually: `npx -y @modelcontextprotocol/server-github`
- Check for network connectivity issues
- The hub retries with exponential backoff — wait and check `list_servers` again

---

## Execution Timeout

**Symptom:**
```
Error: Execution timed out after 30000ms
```

**Causes:**
1. Too many sequential tool calls
2. Slow external API responses
3. Large data processing

**Fix:**
- Increase timeout: `execute_code` accepts `timeout_ms` up to 300,000 (5 minutes)
- Use `mcp.batch()` for parallel calls instead of sequential loops
- Filter data in the sandbox to reduce processing
- Configure rate limits to avoid queuing delays

---

## Rate Limit Errors

**Symptom:**
```
Error: Rate limit exceeded for server 'brave-search'
```

**Causes:**
1. Too many concurrent requests to a rate-limited server
2. `onLimitExceeded` set to `"reject"` instead of `"queue"`

**Fix:** Use queue mode with appropriate limits:

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

---

## Bridge Port Conflict

**Symptom:**
```
Error: EADDRINUSE: address already in use :::3847
```

**Cause:** Another process (or another MCP Conductor instance) is using the bridge port.

**Fix:**
- Kill the existing process: `lsof -i :3847` then `kill <PID>`
- Or configure a different port in `~/.mcp-conductor.json`:

```json
{
  "bridge": {
    "port": 3850
  }
}
```

---

## Sandbox Security Error

**Symptom:**
```
Error: Requires net access to "example.com"
```

**Cause:** Sandbox code tried to access an external URL. The sandbox only allows `127.0.0.1`.

**Fix:** Route all external access through MCP servers:

```typescript
// Wrong — direct fetch fails
const data = await fetch('https://api.example.com/data');

// Right — use an MCP server
const data = await brave.call('brave_web_search', { q: 'query' });
```

---

## Config File Not Loading

**Symptom:** Changes to `~/.mcp-conductor.json` have no effect.

**Causes:**
1. Invalid JSON syntax
2. Hot reload disabled
3. File watcher not detecting changes

**Fix:**
- Validate JSON: `cat ~/.mcp-conductor.json | python3 -m json.tool`
- Trigger manual reload via the `reload_servers` tool
- Check hot reload is enabled (default is `true`):

```json
{
  "hotReload": { "enabled": true }
}
```

---

## Tools Not Visible to Claude

**Symptom:** Claude says it doesn't have access to MCP Conductor tools.

**Causes:**
1. MCP Conductor not configured in Claude's settings
2. Permission entries missing

**Fix:**

For Claude Code, ensure `~/.claude/settings.json` includes:

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

For Claude Desktop, ensure `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) includes the same.

---

## High Token Usage Despite Execution Mode

**Symptom:** Token savings are lower than expected.

**Causes:**
1. Returning raw data instead of summaries from sandbox code
2. Using passthrough mode accidentally
3. `exclusive: false` allowing Claude to bypass the sandbox

**Fix:**
- Always filter and summarise inside the sandbox before returning
- Check mode with `get_metrics` — ensure you're in `execution` mode
- Set `exclusive: true` to force sandbox usage
- Use `compare_modes` to see the difference for specific tasks
