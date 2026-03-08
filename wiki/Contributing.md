# Contributing

Thank you for your interest in contributing to MCP Conductor. This guide covers development setup, coding standards, and the pull request process.

## Prerequisites

- **Node.js** 18+
- **Deno** 1.40+ (for sandbox execution)
- **npm** 9+

## Development Setup

```bash
# Clone the repository
git clone https://github.com/darkiceinteractive/mcp-conductor.git
cd mcp-conductor

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test:run

# Run with watch mode
npm run dev
```

## Project Structure

```
src/
├── server/       # MCP protocol server (entry point)
├── hub/          # Connection pool for backend MCP servers
├── runtime/      # Deno sandbox executor
├── bridge/       # HTTP bridge (sandbox ↔ hub)
├── config/       # Configuration loading and defaults
├── metrics/      # Token savings tracking
├── modes/        # Execution/passthrough/hybrid mode logic
├── skills/       # Reusable skill modules
├── streaming/    # SSE streaming for execution progress
├── watcher/      # Config file hot-reload watcher
├── utils/        # Shared utilities, errors, logger
└── index.ts      # Package entry point
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript with Rollup |
| `npm run dev` | Watch mode with rebuild |
| `npm run test:run` | Run all tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run benchmark:scale` | Run scale benchmark suite |
| `npm run test:benchmark` | Run benchmark assertions |

## Coding Standards

### TypeScript

- Strict mode enabled
- Use explicit types for public APIs
- Prefer `interface` over `type` for object shapes
- Use `async/await` over raw Promises

### Style

- ESLint configuration in `.eslintrc`
- Use Australian English in documentation (e.g., "behaviour", "organised")
- JSDoc comments on all public exports
- Module-level JSDoc on barrel `index.ts` files

### Error Handling

- Use the custom error classes in `src/utils/errors.ts`:
  - `ConfigError` — configuration problems
  - `ConnectionError` — MCP server connection failures
  - `RuntimeError` — sandbox execution errors
  - `SyntaxError` — code parsing errors
  - `TimeoutError` — execution timeouts
  - `PermissionError` — security violations
  - `RateLimitError` — rate limit exceeded
- Always include actionable error messages

## Testing

### Running Tests

```bash
# All tests
npm run test:run

# Specific file
npx vitest run test/unit/metrics-collector.test.ts

# With coverage
npm run test:coverage
```

### Test Organisation

```
test/
├── unit/           # Unit tests (isolated, mocked dependencies)
├── integration/    # Integration tests (real MCP servers)
├── benchmark/      # Benchmark test suites
├── fixtures/       # Shared test fixtures
└── real-servers/   # Test server implementations
```

### Writing Tests

- Use Vitest (`describe`, `it`, `expect`)
- Mock external dependencies (MCP servers, filesystem, network)
- Test both success and error paths
- Include edge cases (empty inputs, large data, timeouts)
- Aim for 80%+ coverage on new code

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feature/my-feature`
3. **Make your changes** with tests
4. **Run checks locally:**
   ```bash
   npm run build
   npm run test:run
   npm run lint
   ```
5. **Commit** with clear messages (conventional commits preferred):
   ```
   feat: add batch search convenience method
   fix: handle rate limit retry in queue mode
   docs: update sandbox API reference
   test: add edge cases for metrics collector
   ```
6. **Push** and open a PR against `main`
7. **Describe** your changes in the PR body with context and test plan

## Reporting Issues

Open an issue on GitHub with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behaviour
- Environment details (OS, Node version, Deno version)
- Relevant configuration (redact API keys)

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
