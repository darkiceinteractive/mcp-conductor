/**
 * Minimal environment builder for spawned child processes.
 *
 * Passing `process.env` wholesale to child processes leaks secrets (API keys,
 * tokens) and user identity (USER, SHELL, LOGNAME) into sandboxes and backend
 * MCP servers. Children only need PATH (to resolve binaries) and HOME (for
 * Deno/npm caches). Everything else is explicitly opted in via `extra`.
 */

/**
 * Build a minimal env for spawning a child process.
 *
 * Always includes `PATH` and `HOME`. Any keys supplied via `extra` are merged
 * on top, with `undefined`/empty values dropped so they can't override a valid
 * parent value unintentionally.
 *
 * @param extra - Additional env vars to include (e.g. `{ DENO_DIR, NO_COLOR: '1' }`)
 * @returns Env object suitable for `child_process.spawn({ env: ... })`
 */
export function minimalChildEnv(
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  };

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== '') {
        env[key] = value;
      }
    }
  }

  return env;
}
