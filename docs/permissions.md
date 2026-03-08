# Permissions Management Guide

This guide explains how to manage MCP tool permissions in Claude Code to eliminate permission prompts.

## The Problem

When Claude Code uses MCP tools, it may prompt you for permission:

```
Claude wants to use: serena - get_current_config()
[Allow] [Deny] [Allow for session]
```

This is because Claude Code's permission system requires explicit approval for each MCP tool. Without pre-configured permissions, you'll see prompts frequently.

## The Solution

MCP Conductor includes a permissions management feature that:

1. **Discovers** all tools from all your connected MCP servers
2. **Generates** the permission entries in the correct format
3. **Updates** your Claude settings file automatically

## Quick Start

Run these commands from the mcp-conductor directory:

```bash
# 1. See what new permissions are needed
node dist/bin/cli.js permissions discover --new-only

# 2. Add them to your settings
node dist/bin/cli.js permissions add

# 3. Restart Claude Code
```

After restarting, you won't see permission prompts for those MCP tools.

## How It Works

### Permission Format

Claude Code uses this format for MCP tool permissions:

```
mcp__<server-name>__<tool-name>
```

Examples:
- `mcp__github__create_issue`
- `mcp__filesystem__read_file`
- `mcp__serena__get_current_config`
- `mcp__playwright__browser_click`

### Settings File Location

**User settings** (applies to all projects):
```
~/.claude/settings.json
```

**Project settings** (applies to specific project):
```
<project>/.claude/settings.json
```

### Settings Structure

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "mcp__github__create_issue",
      "mcp__filesystem__read_file"
    ],
    "deny": [],
    "ask": [
      "Bash(git commit:*)"
    ]
  }
}
```

## CLI Commands

### List Current Permissions

See what MCP permissions you already have configured:

```bash
node dist/bin/cli.js permissions list
```

Output:
```
Reading user settings from: /Users/me/.claude/settings.json

Found 64 MCP permissions:

github:
  - create_issue
  - create_pull_request
  - list_commits
  ...
```

### Discover Available Permissions

Find all tools from your MCP servers:

```bash
# Show all available
node dist/bin/cli.js permissions discover

# Show only what's missing from settings
node dist/bin/cli.js permissions discover --new-only

# Output as JSON (for manual editing)
node dist/bin/cli.js permissions discover --json
```

### Add Permissions

Add discovered permissions to your settings:

```bash
# Preview what would be added
node dist/bin/cli.js permissions add --dry-run

# Add to user settings (recommended)
node dist/bin/cli.js permissions add

# Add to project settings instead
node dist/bin/cli.js permissions add --scope project
```

## Scope Options

### User Scope (Default)

Permissions in `~/.claude/settings.json` apply to **all projects**.

```bash
node dist/bin/cli.js permissions add --scope user
```

**Recommended for:**
- MCP servers you use across all projects
- General-purpose tools (GitHub, filesystem, etc.)

### Project Scope

Permissions in `<project>/.claude/settings.json` apply to **that project only**.

```bash
node dist/bin/cli.js permissions add --scope project
```

**Recommended for:**
- Project-specific MCP servers
- Sensitive tools you only want enabled for certain projects
- Sharing permission configs with your team (commit to repo)

## Manual Configuration

If you prefer to edit settings manually:

### 1. Get Permission List

```bash
node dist/bin/cli.js permissions discover --json
```

Copy the JSON output.

### 2. Edit Settings File

Open `~/.claude/settings.json` and add the permissions:

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      // ... existing permissions ...

      // Add new ones:
      "mcp__serena__get_current_config",
      "mcp__serena__find_symbol",
      "mcp__playwright__browser_click"
    ]
  }
}
```

### 3. Restart Claude Code

## Best Practices

### 1. Start with User Scope

Add permissions to user settings first. Only use project scope for project-specific needs.

### 2. Run After Adding MCP Servers

Whenever you add a new MCP server to your Claude config, run:

```bash
node dist/bin/cli.js permissions discover --new-only
node dist/bin/cli.js permissions add
```

### 3. Review Before Adding

Use `--dry-run` to see what will be added:

```bash
node dist/bin/cli.js permissions add --dry-run
```

### 4. Don't Use settings.local.json

The `settings.local.json` file is for temporary/personal settings and shouldn't be used for permissions. Use either:
- `~/.claude/settings.json` (user scope)
- `.claude/settings.json` (project scope)

### 5. Commit Project Settings

If using project scope, commit `.claude/settings.json` to share with your team.

## Troubleshooting

### "Settings file not found"

The settings file doesn't exist yet. Running `permissions add` will create it:

```bash
node dist/bin/cli.js permissions add
```

### "No tools found"

Ensure your MCP servers are properly configured in Claude's config file:

```bash
node dist/bin/cli.js status
```

### Permissions not taking effect

1. Ensure you're editing the right file (user vs project)
2. Restart Claude Code after changes
3. Check for typos in permission strings

### Server not discovered

The permissions command connects to MCP servers to discover tools. If a server isn't appearing:

1. Check it's properly configured in Claude's config
2. Ensure it can be started (test manually)
3. Check for errors in the discover output

## Example Workflow

### Initial Setup

```bash
# 1. Check what MCP servers you have
node dist/bin/cli.js status

# 2. See all available tools
node dist/bin/cli.js permissions discover

# 3. Add all permissions
node dist/bin/cli.js permissions add

# 4. Restart Claude Code
# Now you won't see permission prompts!
```

### Adding a New MCP Server

```bash
# 1. Add server to ~/.claude.json
# 2. Restart Claude Code (it will connect to new server)

# 3. Discover new tools
node dist/bin/cli.js permissions discover --new-only

# 4. Add new permissions
node dist/bin/cli.js permissions add

# 5. Restart Claude Code again
```

### Team Project Setup

```bash
# 1. Add project-level permissions
node dist/bin/cli.js permissions add --scope project

# 2. Commit the settings file
git add .claude/settings.json
git commit -m "Add MCP tool permissions"

# 3. Team members pull and restart Claude Code
```

## Security Considerations

### What Permissions Allow

Adding an MCP tool to the allow list means Claude Code can use that tool **without prompting you**. Consider:

- Only add tools you trust
- Review what tools a server provides before adding all of them
- Use project scope for sensitive tools

### What's Not Affected

These still require approval regardless of MCP permissions:
- Git commits and pushes (if configured in `ask` list)
- Destructive operations
- Anything in the `deny` list

### Recommended Deny List

Consider adding destructive operations to your deny list:

```json
{
  "permissions": {
    "deny": [
      "mcp__filesystem__delete_directory",
      "mcp__github__delete_repository"
    ]
  }
}
```
