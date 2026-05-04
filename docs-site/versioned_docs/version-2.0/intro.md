---
id: intro
title: MCP Conductor v2.0 (Alpha)
sidebar_label: Introduction
---

# MCP Conductor v2.0 (Alpha)

:::caution You are viewing archived alpha documentation
v2.0 was the **alpha track** — released as `2.0.0-alpha.1` for early testing.
The first stable public release is **v3**. Unless you are maintaining an alpha installation, you should use the v3 docs.
:::

## What was v2?

MCP Conductor v2.0 introduced the core concepts that became the stable v3 release:

- **Execute mode** — run code inside isolated sandboxes instead of passing raw JSON back to the model
- **Passthrough mode** — transparently proxy MCP tool calls with no code changes
- **Token compression** — reduce MCP response payloads before they reach the model's context window
- **Daemon architecture** — long-running background process managing server connections

These features were refined through the alpha cycle and shipped as the stable v3 API.

## Migrating from v2 alpha

See the [v3 Migration Guide](/docs/v3/migration) for a full list of breaking changes and upgrade steps.

## Installing a specific alpha build

Alpha builds are published to npm under the `alpha` dist-tag:

```bash
npm install @darkiceinteractive/mcp-conductor@alpha
```

Production usage should pin to a stable v3 release instead.
