---
title: "Secure API Key Storage Across Projects"
subtitle: "Using 1Password CLI to manage secrets for MCP Conductor and every other project"
---

# Secure API Key Storage Across Projects

Right now you probably have API keys scattered across `.env` files, shell configs, and copied into JSON configs like `~/.mcp-conductor.json`. When a key needs rotating, you're hunting through a dozen files. When you set up a new machine, you're copying secrets in plain text.

The fix: **1Password CLI** (`op`). It's the same 1Password you probably already use, with a command-line interface that injects secrets at runtime — no keys stored on disk in plain text, ever.

---

## Why 1Password CLI

- **Cross-project**: One vault, every project, every machine
- **Touch ID / biometric**: Unlocks the CLI without typing your password
- **No plain-text secrets on disk**: Keys live encrypted in 1Password, injected into env vars at runtime
- **Rotation is easy**: Update in 1Password once, everything picks it up
- **Team-friendly**: Share vaults with team members securely
- **Works on macOS, Linux, Windows**

---

## Setup (5 minutes)

### 1. Install

**macOS:**
```bash
brew install 1password-cli
```

**Linux:**
```bash
# Debian/Ubuntu
curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
  sudo gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | \
  sudo tee /etc/apt/sources.list.d/1password.list
sudo apt update && sudo apt install 1password-cli
```

**Windows:**
```powershell
winget install AgileBits.1Password.CLI
```

### 2. Sign in

```bash
op signin
# Opens browser to authenticate — one-time setup per machine
```

Enable biometric unlock (macOS):
```bash
# In 1Password desktop app: Settings → Developer → Integrate with 1Password CLI
# Then unlock with Touch ID:
op signin --account my.1password.com
```

### 3. Store your keys

```bash
# Store a key (interactive prompt for the secret value):
op item create \
  --category "API Credential" \
  --title "Brave Search API" \
  --field "credential[password]=BSA-your-key-here"

# Or pipe it in:
echo "AIzaSy..." | op item create \
  --category "API Credential" \
  --title "Gemini API" \
  --field "credential[password]=-"
```

---

## Usage

### Inject into shell session

```bash
# Set an env var from 1Password for your current shell session:
export BRAVE_API_KEY=$(op read "op://Personal/Brave Search API/credential")
export GOOGLE_API_KEY=$(op read "op://Personal/Gemini API/credential")
export GITHUB_TOKEN=$(op read "op://Personal/GitHub PAT/credential")
```

### Inject into any command

```bash
# Prefix any command with op run --env-file:
op run --env-file=.env.tpl -- npm start
```

Create `.env.tpl` (safe to commit — no real secrets):
```bash
BRAVE_API_KEY=op://Personal/Brave Search API/credential
GOOGLE_API_KEY=op://Personal/Gemini API/credential
ANTHROPIC_API_KEY=op://Personal/Anthropic API/credential
GITHUB_TOKEN=op://Personal/GitHub PAT/credential
```

### Use with MCP Conductor

Instead of putting real keys in `~/.mcp-conductor.json`, use a wrapper script:

```bash
# ~/.local/bin/mcp-conductor-secure (chmod +x)
#!/usr/bin/env bash
export BRAVE_API_KEY=$(op read "op://Personal/Brave Search API/credential")
export ANTHROPIC_API_KEY=$(op read "op://Personal/Anthropic API/credential")
exec npx @darkiceinteractive/mcp-conductor "$@"
```

Then in Claude config:
```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "/Users/yourname/.local/bin/mcp-conductor-secure"
    }
  }
}
```

Your `~/.mcp-conductor.json` still has env var _names_ but 1Password injects the values:
```json
{
  "servers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      "env": { "BRAVE_API_KEY": "$BRAVE_API_KEY" }
    }
  }
}
```

### Use with scripts (like generate-images.sh)

```bash
# Instead of: NANOBANANA_GEMINI_API_KEY=AIzaSy... ./scripts/generate-images.sh
# Do:
op run --env-file=.env.tpl -- ./scripts/generate-images.sh
```

---

## Alternatives

| Tool | Best for | Tradeoff |
|------|----------|----------|
| **1Password CLI** (recommended) | Cross-project, teams, enterprise | Requires 1Password subscription |
| **macOS Keychain** (`security`) | macOS-only, free | No Linux/Windows, awkward CLI |
| **pass** | Open source, gpg-based | Requires gpg setup, no GUI |
| **direnv** + `.envrc` | Per-project env vars | Plain-text on disk, no encryption |
| **AWS Secrets Manager** | Cloud workloads | Requires AWS, costs $$ |

### macOS Keychain (free alternative)

If you don't have 1Password, the macOS keychain works for local use:

```bash
# Store:
security add-generic-password -s "brave-search" -a "$USER" -w "BSA-your-key"

# Retrieve:
export BRAVE_API_KEY=$(security find-generic-password -s "brave-search" -w)
```

---

## Rotating Keys

When a key expires or needs rotation:

```bash
# Update in 1Password:
op item edit "Brave Search API" --field "credential=BSA-new-key-here"

# Every script and session picks it up automatically on next run — no files to update
```

---

## Summary

**Recommended setup for MCP Conductor projects:**

1. Install `op` CLI
2. Store all API keys in 1Password with descriptive names
3. Create `.env.tpl` with `op://` references (safe to commit)
4. Use `op run --env-file=.env.tpl -- your-command` in scripts
5. Never put real keys in `~/.mcp-conductor.json` or any config file

The `op://Personal/Service Name/credential` path format works everywhere — shell scripts, Makefiles, CI/CD, Docker. One vault, zero plain-text secrets.
