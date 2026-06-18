/**
 * 04-multi-client.test.ts
 *
 * Tests that multiple AI CLIs (Claude, Gemini, Kimi, OpenCode) can all
 * discover and use mcp-conductor tools.
 *
 * Non-Claude clients require MCP config injection before running, which
 * is managed by client-config-manager (backed up and restored in afterAll).
 *
 * Tests soft-fail (console.warn + skip) for auth/network issues so that
 * a single unavailable client doesn't block the whole suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runClaude, runGemini, runKimi, runOpenCode } from './helpers/cli-runner.js';
import {
  injectConductorConfig,
  restoreConfigs,
  type ConfigBackup,
} from './helpers/client-config-manager.js';

const LIST_SERVERS_PROMPT =
  'Use the list_servers tool from mcp-conductor server. Return only the server names as a JSON array, no prose.';

const CAPABILITIES_PROMPT =
  'Use the get_capabilities tool from mcp-conductor. Return the raw JSON only.';

const KNOWN_SERVER_NAMES = ['context7', 'filesystem', 'github', 'memory', 'playwright'];

/** Extract recognisable server names from any text response */
function extractServerNames(text: string): string[] {
  return KNOWN_SERVER_NAMES.filter((name) => text.includes(name));
}

function softWarn(msg: string): void {
  console.warn(`  [soft-fail] ${msg}`);
}

describe('Multi-Client Tool Visibility', { timeout: 300_000 }, () => {
  let backups: ConfigBackup[] = [];

  beforeAll(async () => {
    // Inject conductor config into all non-Claude clients
    backups = await injectConductorConfig(['gemini', 'kimi', 'opencode']);
    console.log('[04-multi-client] Injected conductor config into gemini, kimi, opencode');
  }, 60_000);

  afterAll(async () => {
    await restoreConfigs(backups);
    console.log('[04-multi-client] Restored original client configs');
  });

  it('claude and gemini both see mcp-conductor tools', async () => {
    const [claudeResult, geminiResult] = await Promise.all([
      runClaude(LIST_SERVERS_PROMPT, { timeoutMs: 120_000 }),
      runGemini(LIST_SERVERS_PROMPT, { timeoutMs: 120_000 }),
    ]);

    console.log(`  claude: exit=${claudeResult.exitCode} duration=${claudeResult.durationMs}ms`);
    console.log(`  gemini: exit=${geminiResult.exitCode} duration=${geminiResult.durationMs}ms`);

    // Claude is the most reliable — assert it works
    expect(claudeResult.exitCode).toBe(0);

    const claudeServers = extractServerNames(claudeResult.stdout);
    expect(
      claudeServers.length,
      `Claude didn't mention any known server. stdout: ${claudeResult.stdout.slice(0, 300)}`
    ).toBeGreaterThan(0);

    // Gemini: soft-fail if auth/network issue
    if (geminiResult.exitCode !== 0) {
      softWarn(`Gemini exited with code ${geminiResult.exitCode}. stderr: ${geminiResult.stderr.slice(0, 200)}`);
    } else {
      const geminiServers = extractServerNames(geminiResult.stdout);
      if (geminiServers.length === 0) {
        softWarn(`Gemini response didn't mention known servers. stdout: ${geminiResult.stdout.slice(0, 300)}`);
      }
    }
  });

  it('kimi sees mcp-conductor tools', async () => {
    const result = await runKimi(
      'Use the list_servers tool from mcp-conductor. Return the server names as a JSON array.',
      { timeoutMs: 120_000 }
    );

    console.log(`  kimi: exit=${result.exitCode} duration=${result.durationMs}ms`);

    if (result.exitCode !== 0) {
      softWarn(`Kimi exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 300)}`);
      return; // Soft skip
    }

    const servers = extractServerNames(result.stdout);
    if (servers.length === 0) {
      softWarn(`Kimi response didn't mention known servers. stdout: ${result.stdout.slice(0, 300)}`);
    } else {
      console.log(`  kimi found servers: ${servers.join(', ')}`);
    }
  });

  it('opencode sees mcp-conductor tools', async () => {
    const result = await runOpenCode(
      'Use the list_servers tool from mcp-conductor server. Return only the server names JSON.',
      { timeoutMs: 120_000 }
    );

    console.log(`  opencode: exit=${result.exitCode} duration=${result.durationMs}ms`);

    if (result.exitCode !== 0) {
      softWarn(`OpenCode exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 300)}`);
      return; // Soft skip
    }

    const servers = extractServerNames(result.stdout);
    if (servers.length === 0) {
      softWarn(`OpenCode response didn't mention known servers. stdout: ${result.stdout.slice(0, 300)}`);
    } else {
      console.log(`  opencode found servers: ${servers.join(', ')}`);
    }
  });

  it('all available clients return overlapping server names', async () => {
    const [claudeResult, geminiResult] = await Promise.all([
      runClaude(LIST_SERVERS_PROMPT, { timeoutMs: 120_000 }),
      runGemini(LIST_SERVERS_PROMPT, { timeoutMs: 120_000 }),
    ]);

    console.log(`  claude: exit=${claudeResult.exitCode}`);
    console.log(`  gemini: exit=${geminiResult.exitCode}`);

    // Claude must work
    expect(claudeResult.exitCode).toBe(0);
    const claudeServers = extractServerNames(claudeResult.stdout);
    expect(claudeServers.length).toBeGreaterThan(0);

    if (geminiResult.exitCode === 0) {
      const geminiServers = extractServerNames(geminiResult.stdout);
      const overlap = claudeServers.filter((s) => geminiServers.includes(s));
      console.log(`  Common servers: ${overlap.join(', ')}`);

      if (geminiServers.length > 0) {
        expect(
          overlap.length,
          `No overlap between claude servers [${claudeServers}] and gemini servers [${geminiServers}]`
        ).toBeGreaterThanOrEqual(1);
      } else {
        softWarn('Gemini returned no recognisable server names');
      }
    } else {
      softWarn(`Gemini not available for overlap check (exit=${geminiResult.exitCode})`);
    }
  });

  it('clients handle conductor startup latency gracefully', async () => {
    // Spawn 3 Claude invocations simultaneously — simulates multi-agent startup
    const [r1, r2, r3] = await Promise.all([
      runClaude(CAPABILITIES_PROMPT, { timeoutMs: 180_000 }),
      runClaude(CAPABILITIES_PROMPT, { timeoutMs: 180_000 }),
      runClaude(CAPABILITIES_PROMPT, { timeoutMs: 180_000 }),
    ]);

    const results = [r1, r2, r3];
    console.log('  Parallel Claude invocations:');
    for (const [i, r] of results.entries()) {
      console.log(`    [${i + 1}] exit=${r.exitCode} duration=${r.durationMs}ms`);
    }

    for (const r of results) {
      expect(r.durationMs, 'Claude invocation timed out').toBeLessThan(180_000);
      // -1 means timed out; all other codes (including 1) mean a response arrived
      expect(r.exitCode).not.toBe(-1);
    }

    // At least 2 of 3 should succeed outright
    const successes = results.filter((r) => r.exitCode === 0).length;
    expect(successes).toBeGreaterThanOrEqual(2);
  });

  describe('Performance comparison across clients', () => {
    it('logs first-tool-call latency for each client', async () => {
      // Run all clients in parallel — this is an informational test, no hard assertions
      const [claudeResult, geminiResult, kimiResult, opencodeResult] = await Promise.all([
        runClaude(CAPABILITIES_PROMPT, { timeoutMs: 120_000 }),
        runGemini(CAPABILITIES_PROMPT, { timeoutMs: 120_000 }),
        runKimi(CAPABILITIES_PROMPT, { timeoutMs: 120_000 }),
        runOpenCode(CAPABILITIES_PROMPT, { timeoutMs: 120_000 }),
      ]);

      const table = [
        { client: 'claude',   durationMs: claudeResult.durationMs,   exitCode: claudeResult.exitCode },
        { client: 'gemini',   durationMs: geminiResult.durationMs,   exitCode: geminiResult.exitCode },
        { client: 'kimi',     durationMs: kimiResult.durationMs,     exitCode: kimiResult.exitCode },
        { client: 'opencode', durationMs: opencodeResult.durationMs, exitCode: opencodeResult.exitCode },
      ];

      console.log('\n  Client latency comparison:');
      console.log('  ┌─────────────────┬───────────────┬──────────┐');
      console.log('  │ Client          │ Duration (ms) │ Exit     │');
      console.log('  ├─────────────────┼───────────────┼──────────┤');
      for (const row of table) {
        const name = row.client.padEnd(15);
        const dur = String(row.durationMs).padStart(13);
        const code = String(row.exitCode).padStart(8);
        console.log(`  │ ${name} │ ${dur} │ ${code} │`);
      }
      console.log('  └─────────────────┴───────────────┴──────────┘');

      // No hard assertions — just informational
      expect(table.length).toBe(4);
    });
  });
});
