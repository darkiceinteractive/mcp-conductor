# Contributing to mcp-conductor

First off — thank you for taking the time to contribute! mcp-conductor is a community project and every bug report, feature idea, documentation improvement, and code contribution makes it better for everyone.

This guide explains how to get involved, set up your development environment, and get your changes merged.

---

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Branch Naming](#branch-naming)
- [Commit Messages](#commit-messages)
- [Making a Pull Request](#making-a-pull-request)
- [Code Standards](#code-standards)
- [Testing](#testing)
- [How Decisions Are Made](#how-decisions-are-made)
- [Recognition](#recognition)
- [Questions?](#questions)

---

## Ways to Contribute

You don't need to write code to contribute meaningfully:

- **Report a bug** — Open a [bug report issue](https://github.com/darkiceinteractive/mcp-conductor/issues/new?template=bug_report.md). A detailed reproduction case is incredibly valuable.
- **Request a feature** — Open a [feature request](https://github.com/darkiceinteractive/mcp-conductor/issues/new?template=feature_request.md) or start a conversation in [Discussions](https://github.com/darkiceinteractive/mcp-conductor/discussions).
- **Improve documentation** — Fix typos, clarify confusing sections, add examples, or write a guide.
- **Write or improve tests** — Higher test coverage helps everyone.
- **Fix a bug** — Pick up any issue labelled `good first issue` or `help wanted`.
- **Implement a feature** — Comment on the issue first so we can align on approach before you invest time.
- **Share what you've built** — Post in [Show & Tell](https://github.com/darkiceinteractive/mcp-conductor/discussions/categories/show-and-tell). Stars and sharing also help the project grow. ⭐

---

## Development Setup

### Prerequisites

- **Node.js** >= 18.0.0
- **Deno** >= 1.40 (the sandbox runtime — install via https://deno.land/)
- **npm** >= 9

### Steps

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/mcp-conductor.git
cd mcp-conductor

# 2. Install dependencies
npm install

# 3. Build the TypeScript source
npm run build

# 4. Run the test suite to confirm everything is working
npm test
```

### Useful scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode — recompiles on file change |
| `npm test` | Run all tests (vitest) |
| `npm run test:run` | Run tests once (no watch) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Generate coverage report |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format with Prettier |
| `npm run clean` | Remove `dist/` |

---

## Project Structure

```
src/
  agents/        # Agent definitions and preamble logic
  bin/           # CLI entry point
  runtime/       # Deno sandbox executor
  server/        # MCP server implementation
  utils/         # Shared utilities
test/
  unit/          # Unit tests
  integration/   # Integration tests
  e2e/           # End-to-end tests
  benchmark/     # Performance benchmarks
templates/       # Deno bootstrap templates
scripts/         # Setup and tooling scripts
```

---

## Branch Naming

Use a short, descriptive name with a prefix:

| Prefix | Use for |
|---|---|
| `feature/` | New functionality |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `refactor/` | Internal changes with no behavior change |
| `test/` | Test additions or improvements |
| `chore/` | Dependency updates, tooling, CI |

Examples:

```
feature/per-server-timeout
fix/deno-sandbox-stderr-capture
docs/improve-quickstart-guide
```

---

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). This keeps the git history readable and enables automated changelogs.

**Format:**

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer: Closes #123>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`

**Examples:**

```
feat(runtime): add configurable Deno permission flags
fix(server): handle tool call timeout without crashing
docs: add section on rate limiting to README
chore: upgrade @modelcontextprotocol/sdk to 1.2.0
```

Breaking changes must include `!` after the type and a `BREAKING CHANGE:` footer:

```
feat!: change tool response format to match MCP 1.1 spec

BREAKING CHANGE: Tool responses now use `content` array instead of `result` string.
```

---

## Making a Pull Request

1. **Fork** the repository and create your branch from `main`.
2. **Make your changes** following the code standards below.
3. **Add tests** for any new behavior. Bug fixes should include a regression test.
4. **Run the full test suite** and confirm it passes: `npm run test:run`
5. **Run the build** and confirm it compiles cleanly: `npm run build`
6. **Open a PR** against `main` using the pull request template.
7. **Address review feedback** — we aim to review PRs within a few days.
8. Once approved, a maintainer will merge your PR.

> **Tip:** For large or architecturally significant changes, open a Discussion or draft PR first to get early feedback before investing a lot of time.

---

## Code Standards

- **TypeScript strict mode** — `tsconfig.json` enforces `strict: true`. Avoid `any` where possible.
- **Follow existing patterns** — Look at how similar things are done in the codebase and be consistent.
- **No new runtime dependencies without discussion** — The package is meant to be lean. If you think a dependency is warranted, explain why in your PR.
- **ESLint and Prettier** — Run `npm run lint:fix` and `npm run format` before committing. CI will fail if either reports issues.
- **Keep the Deno sandbox boundary clear** — Code that executes inside the Deno sandbox lives in `src/runtime/`. Don't blur this boundary without good reason.

---

## Testing

Tests are written with [Vitest](https://vitest.dev/).

```bash
# Run all tests
npm run test:run

# Watch mode during development
npm test

# Run a specific test file
npx vitest run test/unit/executor.test.ts

# Generate a coverage report (opens in browser)
npm run test:coverage
```

**Guidelines:**

- Unit tests belong in `test/unit/` and should test a single module in isolation.
- Integration tests belong in `test/integration/` and may spin up the MCP server or Deno runtime.
- New features require at least one unit test covering the happy path and one covering error cases.
- Bug fixes should include a test that would have caught the bug.

---

## How Decisions Are Made

mcp-conductor is currently maintained by [@mattcrombie-darkice](https://github.com/mattcrombie-darkice) at [DarkIce Interactive](https://github.com/darkiceinteractive). Decisions about roadmap, breaking changes, and architecture rest with the maintainer, but community input is actively sought and genuinely influences direction.

For significant proposals, open a Discussion or a draft PR early. This avoids the frustrating situation where someone does a lot of work that ultimately can't be merged.

---

## Recognition

All contributors are appreciated. Meaningful contributions (code, docs, detailed bug reports, sustained community support) will be acknowledged in release notes and, eventually, a contributors section in the README.

---

## Questions?

Not sure about something? Don't want to open an issue for a quick question?

Head to [GitHub Discussions](https://github.com/darkiceinteractive/mcp-conductor/discussions) — the **Q&A** category is the right place for questions of any size.
