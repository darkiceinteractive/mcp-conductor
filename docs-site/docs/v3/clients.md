---
sidebar_position: 6
title: MCP Client Setup
---

# MCP Client Setup

MCP Conductor supports every major MCP client. This page covers:

1. Which clients are supported and where each stores its config
2. The `mcp-conductor-cli setup` wizard — scans, confirms, and writes config per client
3. Per-client export via `mcp-conductor-cli export --client <id>`
4. `mcp-conductor-cli doctor` — health-check output explained
5. How to restart each client after changes
6. Why Grok / xAI is excluded
7. Common troubleshooting issues per client

---

## Supported Clients

| Client | ID | Config path | Format | MCP key | Restart procedure |
|---|---|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude/settings.json` | JSON | `mcpServers` | `/restart` in Claude Code |
| Claude Desktop | `claude-desktop` | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br/>Windows: `%APPDATA%\Claude\claude_desktop_config.json`<br/>Linux: `~/.config/claude/claude_desktop_config.json` | JSON | `mcpServers` | Full quit and relaunch |
| OpenAI Codex CLI | `codex` | `~/.codex/config.toml` (user) or `.codex/config.toml` (project) | TOML | `mcp_servers` | Open a new shell session |
| Google Gemini CLI | `gemini` | `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project) | JSON | `mcpServers` | Open a new shell session |
| Kimi Code CLI | `kimi` | `~/.kimi/mcp.json` | JSON | `mcpServers` | Open a new shell session |
| VS Code (Copilot) | `vscode` | `.vscode/mcp.json` (workspace) | JSON | `servers` | Reload VS Code window (`Ctrl+Shift+P` → Reload Window) |
| Cursor | `cursor` | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) | JSON | `mcpServers` | Full restart of Cursor |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | JSON | `mcpServers` | Restart Windsurf |
| Cline (VS Code ext.) | `cline` | Managed via Cline settings UI; stored in VS Code `globalStorage` | JSON | `mcpServers` | Reload VS Code window (`Ctrl+Shift+P` → Reload Window) |
| Zed | `zed` | `~/.config/zed/settings.json` | JSON | `context_servers` | Restart Zed |

**Notes on format differences:**
- Codex uses TOML with `[mcp_servers.<name>]` table sections and `env_vars` (not `env`) for environment variables.
- VS Code uses `"servers"` (not `"mcpServers"`) and requires `"type": "stdio"` on each entry.
- Zed uses `"context_servers"` with a `"command"` object nesting `"path"` and `"args"`.
- All other clients use the standard `"mcpServers"` JSON key.

---

## Setup Wizard

The `mcp-conductor-cli setup` command scans your machine for installed MCP clients, confirms each one interactively, then writes the conductor entry into each detected config — with a timestamped backup first.

### What it scans

The wizard checks each client's canonical config path for existence. It does not require the client application to be running.

```
$ mcp-conductor-cli setup

MCP Conductor Setup Wizard
===========================

Scanning for installed MCP clients...

  [FOUND] Claude Code         ~/.claude/settings.json
  [FOUND] Claude Desktop      ~/Library/Application Support/Claude/claude_desktop_config.json
  [FOUND] Cursor              ~/.cursor/mcp.json
  [FOUND] Cline               ~/.vscode/extensions/.../cline/mcp_settings.json
  [SKIP]  Codex CLI           ~/.codex/config.toml  (not found)
  [SKIP]  Gemini CLI          ~/.gemini/settings.json  (not found)
  [SKIP]  Kimi CLI            ~/.kimi/mcp.json  (not found)
  [SKIP]  VS Code (Copilot)   .vscode/mcp.json  (not found in cwd)
  [SKIP]  Windsurf            ~/.codeium/windsurf/mcp_config.json  (not found)
  [SKIP]  Zed                 ~/.config/zed/settings.json  (not found)

4 client(s) found. Proceed with setup? [Y/n]
```

### Per-client confirm flow

The wizard asks for confirmation before touching each client. You can skip any client individually:

```
Configure Claude Code? [Y/n] y
  Backup: ~/.claude/settings.json.bak-2026-05-05T14-23-01
  Written: ~/.claude/settings.json

Configure Claude Desktop? [Y/n] y
  Backup: ~/Library/Application Support/Claude/claude_desktop_config.json.bak-2026-05-05T14-23-02
  Written: ~/Library/Application Support/Claude/claude_desktop_config.json

Configure Cursor? [Y/n] n
  Skipped.

Configure Cline? [Y/n] y
  Backup: ...cline/mcp_settings.json.bak-2026-05-05T14-23-03
  Written: ...cline/mcp_settings.json

Setup complete. Remember to restart each configured client.
```

### Backup naming

Backups follow the pattern `<original-path>.bak-<ISO-timestamp>` with colons replaced by hyphens. Example:

```
~/.claude/settings.json.bak-2026-05-05T14-23-01
```

The original file is never deleted. If setup fails mid-write, the backup lets you restore the previous state manually.

---

## Per-Client Export

Use `mcp-conductor-cli export --client <id>` to print the conductor config snippet for a specific client — without modifying any file. Useful for manual setup or for copying into CI configuration.

### Codex (TOML)

```
$ mcp-conductor-cli export --client codex
```

```toml
[mcp_servers.mcp-conductor]
command = "npx"
args = ["-y", "@darkiceinteractive/mcp-conductor"]
```

Paste this block into `~/.codex/config.toml` or `.codex/config.toml`.

**Note:** Codex uses `env_vars` (not `env`) for server-level environment variables. Backend server secrets should remain in `~/.mcp-conductor.json` — only the Conductor entry itself goes in the Codex config.

### Continue (YAML)

```
$ mcp-conductor-cli export --client continue
```

```yaml
mcpServers:
  mcp-conductor:
    command: npx
    args:
      - "-y"
      - "@darkiceinteractive/mcp-conductor"
```

Merge this into your Continue config file (typically `~/.continue/config.yaml`).

**Warning:** Continue's config writer strips YAML comments on round-trip. Keep any hand-written comments in a separate notes file; they will not survive a save operation from the Continue settings UI.

### Cursor (JSON)

```
$ mcp-conductor-cli export --client cursor
```

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

Write this to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

**Tool limit:** Cursor caps active tools at approximately 40 across all MCP servers combined. MCP Conductor helps here — it consolidates many backend servers into a handful of conductor tools, staying well under the limit even with multiple backend servers registered.

---

## Doctor Coverage

`mcp-conductor-cli doctor` performs a health check of every detected client configuration and reports which clients have the conductor entry present and functional.

### Sample output

```
$ mcp-conductor-cli doctor

MCP Conductor Doctor
====================

Checking client configurations...

  [OK]      Claude Code         mcp-conductor entry present
  [OK]      Claude Desktop      mcp-conductor entry present
  [MISSING] Cursor              mcp-conductor entry not found in ~/.cursor/mcp.json
  [OK]      Cline               mcp-conductor entry present
  [SKIP]    Codex CLI           config file not found (client not installed)
  [SKIP]    Gemini CLI          config file not found (client not installed)
  [SKIP]    Kimi CLI            config file not found (client not installed)
  [SKIP]    VS Code (Copilot)   .vscode/mcp.json not present in current directory
  [SKIP]    Windsurf            config file not found (client not installed)
  [SKIP]    Zed                 config file not found (client not installed)

Backend server connectivity...

  Connecting to ~/.mcp-conductor.json servers...
  [OK]      github              3 tools available
  [OK]      filesystem          4 tools available
  [WARN]    brave-search        connection timeout (is the server running?)

Summary: 3 client(s) configured, 1 client(s) missing, 1 backend warning.

Run `mcp-conductor-cli setup` to configure missing clients.
```

### Status meanings

| Status | Meaning | Recommended action |
|---|---|---|
| `[OK]` | Config file exists and contains a valid `mcp-conductor` entry | None — client is ready |
| `[MISSING]` | Config file exists but has no `mcp-conductor` entry | Run `mcp-conductor-cli setup` or use `export` to add manually |
| `[SKIP]` | Config file not found — client is likely not installed | Install the client or ignore if not used |
| `[WARN]` | Entry present but backend connectivity check returned an error | Check the backend server command and credentials in `~/.mcp-conductor.json` |

---

## Restart Procedure Per Client

After any config change — whether made by the wizard, by `export`, or manually — you must restart the client for it to pick up the new MCP server.

| Client | Restart method |
|---|---|
| **Claude Desktop** | Fully quit the app (`Cmd+Q` / `Alt+F4`), then relaunch. Menu bar close is not enough — the process must exit. |
| **Claude Code** | Type `/restart` in the chat input. This triggers a clean reload of the MCP server list without closing the window. |
| **VS Code (Copilot)** | Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Developer: Reload Window**. The MCP server list reloads with the window. |
| **Cline** | Same as VS Code — **Developer: Reload Window**. Cline reads its config at window load time. |
| **Cursor** | Fully restart Cursor (quit and relaunch). Cursor does not hot-reload MCP config. |
| **Windsurf** | Restart Windsurf (quit and relaunch). |
| **Zed** | Restart Zed (quit and relaunch). Zed re-reads `settings.json` on start. |
| **Codex CLI** | Open a new shell session. The `codex` command reads config at process start; existing sessions are unaffected. |
| **Gemini CLI** | Open a new shell session. Same behaviour as Codex. |
| **Kimi Code CLI** | Open a new shell session. Use `kimi mcp test mcp-conductor` in the new session to verify. |

---

## Why Grok / xAI Is Excluded

Grok (xAI's model) does not currently expose a local agent interface that supports MCP server configuration. Grok is accessible only through the xAI API and the grok.com web interface, neither of which provides a mechanism to register stdio-based MCP servers. There is no local config file to write to, and no subprocess spawning mechanism for tools.

If xAI ships a local CLI agent or desktop application with MCP support, MCP Conductor will add a `grok` adapter. Watch the [releases page](https://github.com/darkiceinteractive/mcp-conductor/releases) for updates.

---

## Troubleshooting

### Cline — config path moves on extension update

Cline stores its MCP settings inside VS Code's `globalStorage` directory, scoped to the extension version. When Cline updates to a new version, the extension ID suffix can change, moving the config file to a new path. If `doctor` reports `[SKIP]` for Cline after an update even though Cline is installed, re-run `setup` to let the scanner locate the new path.

If you prefer to manage this manually, open the Cline settings panel inside VS Code and use the MCP Servers tab — that always writes to the active path regardless of version.

### Continue — YAML drops comments on round-trip

Continue's settings UI reads and writes its YAML config programmatically. Any comments you add manually will be removed the next time Continue saves the file (for example, when you toggle a setting in the UI). This is a Continue limitation, not a Conductor issue.

**Workaround:** Keep a reference copy of your annotated config in a separate file (e.g., `~/.continue/config.notes.yaml`) and use it as a source of truth when the live file is overwritten.

### Codex — `env_vars` differs from `env`

Codex's TOML config uses `env_vars` for server-level environment variables, not `env`. If you copy a JSON snippet from another client and convert it to TOML, make sure to rename the key:

```toml
# Correct for Codex:
[mcp_servers.mcp-conductor]
command = "npx"
args = ["-y", "@darkiceinteractive/mcp-conductor"]
env_vars = { MY_VAR = "value" }

# Wrong (will be silently ignored by Codex):
# env = { MY_VAR = "value" }
```

Backend server secrets should stay in `~/.mcp-conductor.json` rather than in the Codex config. This keeps credentials out of project-scoped `.codex/config.toml` files, which may be committed to version control.

### VS Code — `"servers"` not `"mcpServers"`

VS Code uses `"servers"` as the top-level key in `.vscode/mcp.json`, and each entry requires `"type": "stdio"`. The JSON snippet exported by other clients (which use `"mcpServers"`) will not work as-is:

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

Use `mcp-conductor-cli export --client vscode` to get the correctly structured snippet.

### Cursor — hitting the 40-tool limit

Cursor limits the total number of active MCP tools across all registered servers to approximately 40. If you have many MCP servers registered directly in Cursor's config, you may hit this limit. MCP Conductor solves this: register only Conductor in Cursor's config, then add all your other servers to `~/.mcp-conductor.json`. The conductor exposes a fixed set of tools (`execute_code`, `list_servers`, `discover_tools`, `passthrough_call`, `get_metrics`) regardless of how many backend servers you have.

### Zed — `context_servers` format

Zed uses a different schema from other JSON clients. The MCP entry goes under `"context_servers"` and wraps the command in a nested object:

```json
{
  "context_servers": {
    "mcp-conductor": {
      "source": "custom",
      "command": {
        "path": "npx",
        "args": ["-y", "@darkiceinteractive/mcp-conductor"]
      }
    }
  }
}
```

Add this to `~/.config/zed/settings.json`. Use `mcp-conductor-cli export --client zed` to get the correct schema. Pasting a standard `mcpServers` snippet will not work.
