# Security Model

MCP Conductor uses a layered security model centred on the Deno sandbox. The goal: let Claude execute powerful multi-tool workflows without exposing the host system.

## Deno Sandbox Permissions

The sandbox runs with minimal Deno permissions:

| Permission | Setting | Reason |
|------------|---------|--------|
| Network | `--allow-net=127.0.0.1` | Can only reach the localhost bridge |
| Filesystem | None | No direct file access |
| Environment | None | No host environment variables |
| Subprocess | None | Cannot spawn child processes |
| FFI | None | No native code execution |
| High-resolution time | None | Denied by default |

All I/O goes through MCP servers via the bridge, ensuring operations are logged, rate-limited, and controlled.

## Bridge Isolation

The HTTP bridge between the sandbox and MCP servers:

- Binds to `127.0.0.1` only — not accessible from the network
- Accepts requests only from the sandbox subprocess
- Routes tool calls through the MCP hub (which applies rate limits)
- Logs all tool calls with timing and result size

### Bridge Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /call` | Execute a tool call on an MCP server |
| `GET /servers` | List connected servers |
| `GET /tools/:server` | List tools for a specific server |
| `GET /search-tools` | Search tools across servers |
| `POST /progress` | Report execution progress |
| `POST /log` | Report log messages |
| `GET /stream/:id` | SSE stream for execution events |

## What the Sandbox Cannot Do

- **No arbitrary network access** — `fetch('https://example.com')` fails
- **No file system access** — `Deno.readTextFile()` fails; use `mcp.server('filesystem').call('read_file', ...)` instead
- **No environment variables** — `Deno.env.get()` returns nothing
- **No subprocess spawning** — `Deno.run()` / `new Deno.Command()` fails
- **No FFI** — Cannot load native libraries

## Execution Lifecycle

1. Claude sends TypeScript code via `execute_code`
2. Code is written to a temporary file
3. Deno subprocess starts with locked-down permissions
4. Sandbox code communicates with MCP servers via the bridge
5. Bridge routes calls through the hub (rate limits, logging)
6. Result is serialised and returned to Claude
7. Temporary file is cleaned up

## Rate Limiting as Security

Per-server rate limits prevent:
- Runaway loops from overwhelming external APIs
- Accidental denial-of-service to paid services
- Excessive costs from unbounded batch operations

See [Rate Limiting](./Rate-Limiting) for configuration.

## Exclusive Mode

When `exclusive: true` (recommended), Claude sees only MCP Conductor tools — not individual backend server tools. This forces all operations through the sandbox:

```json
{ "exclusive": true }
```

Benefits:
- All operations are sandboxed and logged
- Token savings are maximised (no raw data in context)
- Rate limits are always applied
- Consistent security boundary

## Permissions Management

MCP Conductor can auto-discover tools and generate Claude Code permission entries:

```bash
# See what permissions are needed
node dist/bin/cli.js permissions discover --new-only

# Add them to Claude settings
node dist/bin/cli.js permissions add
```

This updates `~/.claude/settings.json` with entries like:

```json
{
  "permissions": {
    "allow": [
      "mcp__mcp-conductor__execute_code",
      "mcp__mcp-conductor__list_servers"
    ]
  }
}
```

## Security Recommendations

1. **Use exclusive mode** — Forces all operations through the sandbox
2. **Configure rate limits** — Especially for paid APIs like Brave Search
3. **Use `queue` mode** — Prefer queuing over rejection for rate limits
4. **Review connected servers** — Only connect servers you trust
5. **Keep Deno updated** — Sandbox security depends on Deno's permission system
6. **Monitor metrics** — Watch for unusual execution patterns via `get_metrics`
