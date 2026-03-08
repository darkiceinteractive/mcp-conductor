/**
 * Deno sandbox runtime — spawns isolated Deno subprocesses, injects the
 * `mcp` API bridge script, executes user TypeScript, and captures results.
 * @module runtime
 */

export * from './executor.js';
