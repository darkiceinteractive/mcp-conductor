# Troubleshooting Guide

This guide covers common issues and their solutions.

## Quick Diagnostics

Run these commands to diagnose issues:

```bash
# Check system requirements
node dist/bin/cli.js check

# Check configuration status
node dist/bin/cli.js status

# Start with verbose logging
node dist/bin/cli.js serve --verbose
```

## Common Issues

### Deno Not Installed

**Symptom:**
```
Error: Deno not found
```

**Solution:**

Install Deno:

```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh

# macOS with Homebrew
brew install deno

# Windows
irm https://deno.land/install.ps1 | iex
```

Verify installation:
```bash
deno --version
```

---

### Server Not Found

**Symptom:**
```
Error: Server not found: github
```

**Possible Causes:**

1. **Server not in Claude config**

   Check your Claude config file includes the server:
   ```bash
   node dist/bin/cli.js status
   cat ~/.claude.json
   ```

2. **Server in deny list**

   Check your MCP Conductor config:
   ```json
   {
     "servers": {
       "denyList": []  // Remove the server from here
     }
   }
   ```

3. **Server failed to connect**

   Run with verbose logging:
   ```bash
   node dist/bin/cli.js serve --verbose
   ```

---

### Connection Timeout

**Symptom:**
```
Error: Connection timeout
Error: Server not connected: github (status: error)
```

**Possible Causes:**

1. **Server slow to start**

   Some servers take time to initialise. Wait and retry.

2. **Server crashed**

   Check the server's own logs. Try starting it manually:
   ```bash
   npx @modelcontextprotocol/server-github
   ```

3. **Missing environment variables**

   Some servers need environment variables:
   ```json
   {
     "mcpServers": {
       "github": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": {
           "GITHUB_TOKEN": "your-token-here"
         }
       }
     }
   }
   ```

---

### Execution Timeout

**Symptom:**
```
Error: Timeout exceeded
```

**Solutions:**

1. **Increase timeout for the request**

   In your execute_code call:
   ```json
   {
     "code": "...",
     "timeout_ms": 60000
   }
   ```

2. **Increase default timeout**

   In config or CLI:
   ```bash
   node dist/bin/cli.js serve --timeout 60000
   ```

3. **Optimise your code**

   - Use `Promise.all` for parallel operations
   - Avoid unnecessary loops
   - Return early when possible

---

### Network Access Denied

**Symptom:**
```
Error: Network access denied
PermissionDenied: network access to "https://..."
```

**Explanation:**

The Deno sandbox only allows access to the localhost bridge. Direct network access is blocked for security.

**Solution:**

Use MCP servers for network operations:

```typescript
// ❌ Won't work - direct fetch is blocked
const response = await fetch('https://api.github.com/repos/...');

// ✅ Works - use the GitHub MCP server
const github = mcp.server('github');
const repo = await github.call('get_repository', {
  owner: 'anthropics',
  repo: 'claude-code'
});
```

---

### Permission Denied (Claude Code)

**Symptom:**

Claude Code prompts for permission:
```
Claude wants to use: serena - get_current_config()
[Allow] [Deny]
```

**Solution:**

Add permissions using the CLI:

```bash
# Add all missing permissions
node dist/bin/cli.js permissions add

# Restart Claude Code
```

See the [Permissions Guide](./permissions.md) for details.

---

### Port Already in Use

**Symptom:**
```
Error: EADDRINUSE: address already in use :::9847
```

**Solutions:**

1. **Use dynamic port allocation** (recommended)

   This is now the default. Ensure port is set to 0:
   ```bash
   node dist/bin/cli.js serve --port 0
   ```

2. **Find and kill the process using the port**

   ```bash
   # Find process
   lsof -i :9847

   # Kill it
   kill <PID>
   ```

3. **Use a different port**

   ```bash
   node dist/bin/cli.js serve --port 9999
   ```

---

### Module Not Found

**Symptom:**
```
Error: Cannot find module '@modelcontextprotocol/sdk'
```

**Solution:**

Reinstall dependencies:

```bash
npm install
npm run build
```

---

### Config File Not Found

**Symptom:**
```
Claude Config: Not found
```

**Solutions:**

1. **Create the config file**

   For Claude Code:
   ```bash
   touch ~/.claude.json
   echo '{"mcpServers":{}}' > ~/.claude.json
   ```

2. **Set custom path**

   ```bash
   export MCP_CONDUCTOR_CLAUDE_CONFIG=/path/to/config.json
   ```

3. **Check search paths**

   ```bash
   node dist/bin/cli.js status
   ```

---

### Sandbox Memory Error

**Symptom:**
```
Error: JavaScript heap out of memory
```

**Solution:**

Increase sandbox memory limit:

```json
{
  "sandbox": {
    "maxMemoryMb": 1024
  }
}
```

Or via environment:
```bash
export MCP_CONDUCTOR_MAX_MEMORY_MB=1024
```

---

### Hot Reload Not Working

**Symptom:**

Changes to Claude config don't take effect automatically.

**Solutions:**

1. **Ensure hot reload is enabled**

   ```json
   {
     "hotReload": {
       "enabled": true
     }
   }
   ```

2. **Manually trigger reload**

   Use the `reload_servers` tool in Claude.

3. **Restart the server**

   Sometimes a full restart is needed.

---

## Debug Mode

For detailed debugging, start with verbose logging:

```bash
node dist/bin/cli.js serve --verbose
```

This shows:
- Server connections
- Tool discoveries
- Request/response details
- Error stack traces

## Getting Help

If you're still stuck:

1. **Check existing issues:**
   https://github.com/darkiceinteractive/mcp-conductor/issues

2. **Create a new issue with:**
   - Output of `node dist/bin/cli.js check`
   - Output of `node dist/bin/cli.js status`
   - Verbose logs showing the error
   - Your OS and Node.js version

3. **Join discussions:**
   https://github.com/darkiceinteractive/mcp-conductor/discussions

## Log Locations

MCP Conductor logs to stderr. To capture logs:

```bash
node dist/bin/cli.js serve --verbose 2> mcp-conductor.log
```

Individual MCP servers may have their own log locations:
- Serena: `~/.serena/logs/`
- Others: Check their documentation
