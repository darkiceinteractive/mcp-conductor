# MCP Conductor

[![npm version](https://img.shields.io/npm/v/@darkiceinteractive/mcp-conductor.svg?style=flat)](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
[![CI](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml/badge.svg)](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**97% fewer tokens. Parallel execution. One `npx` command.**

MCP Conductor is a single MCP server that orchestrates all your other MCP servers through a sandboxed Deno runtime. Instead of your AI making direct tool calls (dumping every intermediate result into the context window), it writes TypeScript code that runs in an isolated sandbox. Only the final result comes back.

**Works with:** Claude Code, Claude Desktop, OpenAI Codex, Google Gemini CLI, Kimi Code CLI, VS Code (Copilot), Cursor, Windsurf, Cline, and any MCP-compatible client.

---

## Quick Navigation

### Getting Started
- [[Getting Started]] — Prerequisites, installation, first run
- [[MCP Clients]] — Setup for Claude, Codex, Gemini, Kimi, Cursor, VS Code, Windsurf, Cline
- [[Configuration Guide]] — All config options, env vars, defaults
- [[Troubleshooting]] — Common issues with symptom/cause/fix

### Architecture & Design
- [[Architecture Overview]] — Component diagram, data flow, why Deno
- [[Execution Modes]] — Execution, passthrough, hybrid mode switching
- [[Security Model]] — Deno permissions, sandbox isolation, bridge security

### API Reference
- [[MCP Tools Reference]] — All 12 tools with parameters and examples
- [[Sandbox API Reference]] — The `mcp` object: server(), batch(), progress()
- [[API Internals]] — Full execution lifecycle trace

### Features
- [[Server Management]] — Add, remove, update, reload, hot reload
- [[Rate Limiting]] — Token bucket algorithm, queue vs reject
- [[Streaming and Progress]] — SSE events, real-time progress updates
- [[Skills System]] — YAML-defined reusable code templates
- [[Metrics and Token Savings]] — The formula, estimation, get_metrics

### Development
- [[Contributing]] — Dev setup, testing, branch conventions, PR process
- [[Benchmark Methodology]] — Token formula, scales, running benchmarks
- [[FAQ]] — Common questions with answers

---

## How It Works

```
Before: 45,000 tokens -> Claude context window -> 45,000 tokens billed
After:  45,000 tokens -> Deno sandbox -> 800 tokens -> Claude context window
```

**Average measured reduction: 94.3%. Peak: 97.8%.**

Claude writes TypeScript that runs inside an isolated Deno subprocess. The sandbox can call any connected MCP server, filter and aggregate results, and return only a compact summary. Your context window stays small. Your costs stay low.

---

## Links

- [npm package](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
- [GitHub repository](https://github.com/darkiceinteractive/mcp-conductor)
- [Issues](https://github.com/darkiceinteractive/mcp-conductor/issues)
- [Discussions](https://github.com/darkiceinteractive/mcp-conductor/discussions)
