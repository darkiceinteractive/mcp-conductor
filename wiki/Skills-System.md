# Skills System

MCP Conductor includes a skills engine that manages reusable code modules. Skills provide pre-built functionality that can be loaded into the sandbox, reducing the amount of code Claude needs to generate for common tasks.

## Concept

A skill is a reusable TypeScript module with metadata describing its purpose, inputs, and outputs. Skills are organised by category and can be searched by name, description, or tags.

## Directory Structure

Skills are stored in a configurable directory (default: `~/.mcp-conductor/skills/`):

```
skills/
├── analysis/
│   ├── skill.yaml
│   └── summarise-repo.ts
├── search/
│   ├── skill.yaml
│   └── multi-source-search.ts
└── file-ops/
    ├── skill.yaml
    └── batch-rename.ts
```

Each skill directory contains:
- `skill.yaml` — metadata file describing the skill
- One or more `.ts` implementation files

## Skill Metadata (`skill.yaml`)

```yaml
name: summarise-repo
category: analysis
description: Analyse a GitHub repository and produce a structured summary
version: 1.0.0
author: darkice
tags:
  - github
  - analysis
  - summary
inputs:
  - name: owner
    type: string
    description: Repository owner
    required: true
  - name: repo
    type: string
    description: Repository name
    required: true
outputs:
  - name: summary
    type: object
    description: Structured repository summary
```

## Loading Skills

The skills engine loads skills on startup and watches for changes:

```typescript
const engine = new SkillsEngine({
  skillsDir: '~/.mcp-conductor/skills',
  watchEnabled: true,
  allowedCategories: [],  // Empty = all categories allowed
});

await engine.loadSkills();
```

## Searching Skills

Search across all loaded skills by name, description, or tags:

```typescript
// From sandbox code
const results = await mcp.searchTools('file analysis');

// Via the discover_tools MCP tool
// { "query": "analysis" }
```

Search results include a relevance score for ranking.

## Skill Configuration

In `~/.mcp-conductor.json`:

```json
{
  "skills": {
    "directory": "~/.mcp-conductor/skills",
    "watchEnabled": true,
    "allowedCategories": ["analysis", "search"]
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `directory` | string | `~/.mcp-conductor/skills` | Path to skills directory |
| `watchEnabled` | boolean | `true` | Watch for skill file changes |
| `allowedCategories` | string[] | `[]` | Restrict to specific categories (empty = all) |

## Events

The skills engine emits events when skills are loaded or changed:

| Event | Description |
|-------|-------------|
| `skillLoaded` | A skill was loaded or reloaded |
| `skillRemoved` | A skill was removed |
| `skillError` | A skill failed to load |

## Creating Custom Skills

1. Create a category directory under your skills path
2. Add a `skill.yaml` with metadata
3. Add the TypeScript implementation
4. The skill loads automatically (if `watchEnabled` is true) or on next restart
