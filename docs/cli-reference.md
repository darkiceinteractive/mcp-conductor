# CLI Reference

MCP Conductor provides a command-line interface for managing the server and permissions.

## Installation

After cloning the repository:

```bash
npm install
npm run build
```

Run commands with:
```bash
node dist/bin/cli.js <command> [options]
```

## Commands

### serve

Start the MCP Conductor server.

```bash
node dist/bin/cli.js serve [options]
```

**Options:**

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--port <port>` | `-p` | `0` | Bridge port (0 = dynamic allocation) |
| `--mode <mode>` | `-m` | `execution` | Mode: execution, passthrough, hybrid |
| `--timeout <ms>` | `-t` | `30000` | Default timeout in milliseconds |
| `--verbose` | `-v` | false | Enable debug logging |

**Examples:**

```bash
# Start with defaults (recommended)
node dist/bin/cli.js serve

# Start with verbose logging
node dist/bin/cli.js serve --verbose

# Start with custom timeout
node dist/bin/cli.js serve --timeout 60000

# Start in passthrough mode (for debugging)
node dist/bin/cli.js serve --mode passthrough
```

**Note:** You typically don't need to run this command manually. Claude Desktop/Code starts the server automatically.

---

### status

Show MCP Conductor status and configuration paths.

```bash
node dist/bin/cli.js status
```

**Output:**

```
MCP Conductor Status
====================

Claude Config: /Users/me/.claude.json

Search paths:
  - /Users/me/.claude.json
  - /Users/me/Library/Application Support/Claude Code/claude_code_config.json
  - /Users/me/Library/Application Support/Claude/claude_code_config.json
  - /Users/me/Library/Application Support/Claude/claude_desktop_config.json
  - ...
```

---

### check

Check if system requirements are met.

```bash
node dist/bin/cli.js check
```

**Output:**

```
MCP Conductor - System Check
=============================

Node.js: v20.10.0 ✓

Checking Deno installation...
Deno: v1.40.0 ✓

All requirements met! ✓
```

If Deno is not installed:

```
Deno: Not installed ✗

To install Deno:
  curl -fsSL https://deno.land/install.sh | sh
  # Or on macOS with Homebrew:
  brew install deno
```

---

### init

Add MCP Conductor to your Claude Desktop configuration.

```bash
node dist/bin/cli.js init [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be added without making changes |

**Examples:**

```bash
# Preview changes
node dist/bin/cli.js init --dry-run

# Add to config
node dist/bin/cli.js init
```

**Output:**

```
Added MCP Conductor to /Users/me/.claude.json

Restart Claude Desktop to load the new server.
```

---

### permissions

Manage Claude Code MCP tool permissions. This command group helps you auto-approve MCP tools so you don't see permission prompts.

```bash
node dist/bin/cli.js permissions <subcommand> [options]
```

#### permissions list

List currently configured MCP permissions in your Claude settings.

```bash
node dist/bin/cli.js permissions list [options]
```

**Options:**

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--scope <scope>` | `-s` | `user` | Settings scope: user or project |

**Examples:**

```bash
# List user permissions
node dist/bin/cli.js permissions list

# List project permissions
node dist/bin/cli.js permissions list --scope project
```

**Output:**

```
Reading user settings from: /Users/me/.claude/settings.json

Found 64 MCP permissions:

github:
  - create_issue
  - create_pull_request
  - list_commits
  ...

filesystem:
  - read_file
  - write_file
  ...
```

#### permissions discover

Discover all MCP tools from connected servers and show what permissions are needed.

```bash
node dist/bin/cli.js permissions discover [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--json` | false | Output as JSON array (for manual copying) |
| `--new-only` | false | Only show permissions not in settings |
| `--scope <scope>` | `user` | Settings scope to check against |

**Examples:**

```bash
# Show all discoverable permissions
node dist/bin/cli.js permissions discover

# Show only new permissions (not yet configured)
node dist/bin/cli.js permissions discover --new-only

# Output as JSON for copying
node dist/bin/cli.js permissions discover --json
```

**Output (default):**

```
Discovering MCP tools...

Found 104 permissions:

github:
  - create_issue
  - create_pull_request
  ...

serena:
  - get_current_config
  - find_symbol
  ...
```

**Output (--json):**

```json
[
  "mcp__github__create_issue",
  "mcp__github__create_pull_request",
  "mcp__serena__get_current_config",
  ...
]
```

#### permissions add

Add discovered MCP tool permissions to Claude settings.

```bash
node dist/bin/cli.js permissions add [options]
```

**Options:**

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--scope <scope>` | `-s` | `user` | Settings scope: user or project |
| `--dry-run` | | false | Preview changes without modifying files |
| `--all` | | false | Add all permissions (not just new ones) |

**Examples:**

```bash
# Preview what would be added
node dist/bin/cli.js permissions add --dry-run

# Add new permissions to user settings
node dist/bin/cli.js permissions add

# Add to project settings
node dist/bin/cli.js permissions add --scope project

# Force re-add all permissions
node dist/bin/cli.js permissions add --all
```

**Output:**

```
Discovering MCP tools to add to user settings...
Settings file: /Users/me/.claude/settings.json

Adding 61 permissions:

memory:
  - add_observations
  - create_entities
  ...

playwright:
  - browser_click
  - browser_navigate
  ...

✓ Updated /Users/me/.claude/settings.json

Restart Claude Code to apply the new permissions.
```

---

### install-instructions

Install MCP Conductor project instructions (CLAUDE.md) to help Claude use execute_code for batch operations.

```bash
node dist/bin/cli.js install-instructions [options]
```

**Options:**

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--dir <directory>` | `-d` | `.` | Target directory for CLAUDE.md |
| `--force` | | false | Overwrite existing CLAUDE.md if present |
| `--append` | | false | Append to existing CLAUDE.md instead of creating new |
| `--dry-run` | | false | Preview changes without creating files |

**Examples:**

```bash
# Preview what would be created
node dist/bin/cli.js install-instructions --dry-run

# Install to current directory
node dist/bin/cli.js install-instructions

# Install to a specific project
node dist/bin/cli.js install-instructions --dir /path/to/project

# Append to existing CLAUDE.md
node dist/bin/cli.js install-instructions --append

# Overwrite existing CLAUDE.md
node dist/bin/cli.js install-instructions --force
```

**Output:**

```
Created /path/to/project/CLAUDE.md

Claude Code will now see these instructions and prefer using execute_code
for multi-step MCP operations, providing significant token savings.

Next steps:
  1. Restart Claude Code in this project
  2. Claude will automatically use execute_code for batch operations
```

**Why This Matters:**

Claude Code reads CLAUDE.md files as project instructions. By installing these instructions, you teach Claude to:
- Use `execute_code` for multi-step MCP operations
- Batch tool calls to save 90%+ tokens
- Process data in the sandbox instead of in context

---

## Global Options

These options are available for all commands:

| Option | Description |
|--------|-------------|
| `-h, --help` | Display help for command |
| `-V, --version` | Display version number |

**Examples:**

```bash
# Show general help
node dist/bin/cli.js --help

# Show help for a specific command
node dist/bin/cli.js serve --help
node dist/bin/cli.js permissions --help
node dist/bin/cli.js permissions add --help
```

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Error occurred |

## Common Workflows

### Initial Setup

```bash
# 1. Check requirements
node dist/bin/cli.js check

# 2. Add to Claude config
node dist/bin/cli.js init

# 3. Add permissions for all MCP tools
node dist/bin/cli.js permissions add

# 4. Restart Claude Code
```

### Setting Up a New Project

```bash
# Install instructions to teach Claude to use execute_code
node dist/bin/cli.js install-instructions --dir /path/to/project

# Or if the project already has a CLAUDE.md, append to it
node dist/bin/cli.js install-instructions --dir /path/to/project --append

# Restart Claude Code in that project
```

### After Adding New MCP Servers

```bash
# 1. Discover new permissions
node dist/bin/cli.js permissions discover --new-only

# 2. Add them to settings
node dist/bin/cli.js permissions add

# 3. Restart Claude Code
```

### Debugging Connection Issues

```bash
# 1. Check status
node dist/bin/cli.js status

# 2. Start server with verbose logging
node dist/bin/cli.js serve --verbose
```

### Testing in Passthrough Mode

```bash
# Bypass code executor for debugging
node dist/bin/cli.js serve --mode passthrough --verbose
```
