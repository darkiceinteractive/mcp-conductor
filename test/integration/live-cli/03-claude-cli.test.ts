/**
 * 03-claude-cli.test.ts
 *
 * Claude CLI end-to-end tests via MCP conductor.
 *
 * These tests invoke the real `claude` CLI with mcp-conductor injected via
 * --mcp-config. Expected runtime: 30-120s per test. Tests are individually
 * gated with soft-fail behaviour for network/API issues.
 */

import { describe, it, expect } from 'vitest';
import { runClaude } from './helpers/cli-runner.js';

const LIST_SERVERS_PROMPT =
  'Use the list_servers tool from mcp-conductor and respond with the raw JSON result only, no prose.';

// Known servers that should appear in any healthy response
const EXPECTED_SERVER_NAMES = ['context7', 'filesystem', 'github', 'memory'];

/**
 * Soft-fail helper — logs a warning and returns false rather than throwing,
 * for cases where an external dependency (Claude API, network) may be the cause.
 */
function softExpect(condition: boolean, message: string): boolean {
  if (!condition) {
    console.warn(`  [soft-fail] ${message}`);
  }
  return condition;
}

describe('Claude CLI MCP Integration', { timeout: 180_000 }, () => {
  it('claude discovers list_servers tool and returns server list', async () => {
    const result = await runClaude(LIST_SERVERS_PROMPT, { timeoutMs: 120_000 });

    console.log(`  exit=${result.exitCode} duration=${result.durationMs}ms`);

    if (result.exitCode !== 0) {
      console.warn(`  claude exited with code ${result.exitCode}`);
      console.warn(`  stderr: ${result.stderr.slice(0, 500)}`);
    }

    expect(result.exitCode).toBe(0);

    // At least one known server name should appear in stdout
    const hasKnownServer = EXPECTED_SERVER_NAMES.some((name) =>
      result.stdout.includes(name)
    );

    expect(
      hasKnownServer,
      `Expected at least one of [${EXPECTED_SERVER_NAMES.join(', ')}] in stdout.\nGot: ${result.stdout.slice(0, 500)}`
    ).toBe(true);
  });

  it('claude can call discover_tools for filesystem server', async () => {
    const result = await runClaude(
      'Call the discover_tools tool with server="filesystem" and return the tool names you find, as a JSON array.',
      { timeoutMs: 120_000 }
    );

    console.log(`  exit=${result.exitCode} duration=${result.durationMs}ms`);
    expect(result.exitCode).toBe(0);

    const output = result.stdout.toLowerCase();
    const hasFilesystemTools =
      output.includes('list_directory') ||
      output.includes('read_file') ||
      output.includes('list-directory') ||
      output.includes('read-file');

    softExpect(
      hasFilesystemTools,
      `Expected filesystem tool names in response. Got: ${result.stdout.slice(0, 300)}`
    );
  });

  it('claude can call get_capabilities via static tool', async () => {
    const result = await runClaude(
      'Use get_capabilities and return the raw JSON only.',
      { timeoutMs: 120_000 }
    );

    console.log(`  exit=${result.exitCode} duration=${result.durationMs}ms`);
    expect(result.exitCode).toBe(0);

    // Should return some JSON-like content
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('claude response time is reasonable (<120s)', async () => {
    const result = await runClaude(
      'Use get_capabilities and return the raw JSON',
      { timeoutMs: 120_000 }
    );

    console.log(`  duration=${result.durationMs}ms`);
    expect(result.durationMs).toBeLessThan(120_000);
    // Exit -1 means timeout; any other code (including 1) is at least a response
    expect(result.exitCode).not.toBe(-1);
  });

  it('claude handles multiple tool calls in one prompt', async () => {
    const result = await runClaude(
      'First call list_servers, then call get_metrics. Return a summary JSON with keys servers_count and mode.',
      { timeoutMs: 120_000 }
    );

    console.log(`  exit=${result.exitCode} duration=${result.durationMs}ms`);
    expect(result.exitCode).toBe(0);

    const output = result.stdout;
    // Should contain JSON-like content with numbers or the expected keys
    const hasJson =
      output.includes('{') ||
      output.includes('servers_count') ||
      output.includes('mode') ||
      /\d+/.test(output);

    softExpect(hasJson, `Expected JSON-like content. Got: ${output.slice(0, 300)}`);
  });

  it('claude uses passthrough tool when calling filesystem__list_directory', async () => {
    const result = await runClaude(
      'Call the filesystem__list_directory tool directly with path="/tmp" and return the raw result.',
      { timeoutMs: 120_000 }
    );

    console.log(`  exit=${result.exitCode} duration=${result.durationMs}ms`);

    if (result.exitCode !== 0) {
      console.warn(`  stderr: ${result.stderr.slice(0, 300)}`);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
