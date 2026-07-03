/**
 * 06-overnight-soak.test.ts
 *
 * Long-running soak tests. Only executed when SOAK=1 env var is set.
 * Run via: npm run test:overnight
 *
 * Tests sustained tool call throughput, memory stability, and recovery
 * after server reload events.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { McpStdioClient } from './helpers/mcp-stdio-client.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(join(__dirname, '..', '..', '..', 'dist', 'index.js'));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function spawnFreshClient(): McpStdioClient {
  return new McpStdioClient('node', [CONDUCTOR_DIST], {
    MCP_CONDUCTOR_CONFIG: '/Users/mattcrombie/.mcp-conductor.json',
    NODE_ENV: 'test',
  });
}

const SOAK_ENABLED = process.env['SOAK'] === '1';
const SOAK_DURATION_MS = parseInt(process.env['SOAK_DURATION_MS'] ?? '3600000', 10); // 1h default
const ITERATION_DELAY_MS = 2000;

// Rotate through these tools during soak
const SOAK_TOOLS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'list_servers',    args: {} },
  { name: 'get_metrics',     args: {} },
  { name: 'get_capabilities', args: {} },
  { name: 'get_memory_stats', args: {} },
  { name: 'filesystem__list_directory', args: { path: '/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice' } },
];

describe('Overnight Soak Test', { timeout: 8 * 60 * 60 * 1000 }, () => {
  beforeAll(() => {
    if (!SOAK_ENABLED) {
      console.log('  SOAK tests skipped — set SOAK=1 to enable');
    }
  });

  it('runs sustained tool calls for SOAK_DURATION_MS without degradation', async () => {
    if (!SOAK_ENABLED) {
      console.log('  Skipping (SOAK not set)');
      return;
    }

    const client = spawnFreshClient();
    const changedPromise = client.waitForToolsChanged(60_000);
    await client.initialize();
    await changedPromise;

    // Check which soak tools are actually available after init
    const { tools: availableTools } = await client.listTools();
    const availableNames = new Set(availableTools.map((t) => t.name));

    const activeTools = SOAK_TOOLS.filter(
      (t) => availableNames.has(t.name) || !t.name.includes('__')
    );
    console.log(`  Active soak tools: ${activeTools.map((t) => t.name).join(', ')}`);

    const latencies: number[] = [];
    const memorySamples: number[] = [];
    let successes = 0;
    let failures = 0;
    let iteration = 0;
    const startMs = Date.now();
    let lastMemoryCheck = Date.now();

    console.log(`  Starting soak: ${SOAK_DURATION_MS / 1000}s duration, ${ITERATION_DELAY_MS}ms between iterations`);

    try {
      while (Date.now() - startMs < SOAK_DURATION_MS) {
        const tool = activeTools[iteration % activeTools.length]!;
        const t0 = Date.now();

        try {
          await client.callTool(tool.name, tool.args);
          successes++;
          latencies.push(Date.now() - t0);
        } catch (err) {
          failures++;
          console.warn(`  [soak] tool call failed: ${tool.name} — ${err}`);
        }

        iteration++;

        // Sample memory every 60s
        if (Date.now() - lastMemoryCheck > 60_000) {
          memorySamples.push(process.memoryUsage().rss);
          lastMemoryCheck = Date.now();
          const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
          console.log(`  [soak] ${elapsed}s: ${successes} ok / ${failures} fail`);
        }

        await sleep(ITERATION_DELAY_MS);
      }
    } finally {
      await client.close().catch(() => { /* ignore */ });
    }

    // Compute statistics
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const successRate = successes / (successes + failures);

    const memGrowthBytes = memorySamples.length >= 2
      ? (memorySamples[memorySamples.length - 1]! - memorySamples[0]!)
      : 0;
    const memGrowthMb = memGrowthBytes / (1024 * 1024);

    console.log('\n  === Soak Test Results ===');
    console.log(`  Iterations: ${iteration}`);
    console.log(`  Successes: ${successes}, Failures: ${failures}`);
    console.log(`  Success rate: ${(successRate * 100).toFixed(1)}%`);
    console.log(`  Latency p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
    console.log(`  Memory growth: ${memGrowthMb.toFixed(1)} MB`);
    console.log('  ========================\n');

    expect(successRate, `Success rate ${(successRate * 100).toFixed(1)}% < 95%`).toBeGreaterThanOrEqual(0.95);
    expect(p95, `p95 latency ${p95}ms > 5000ms`).toBeLessThan(5000);
    expect(p99, `p99 latency ${p99}ms > 10000ms`).toBeLessThan(10_000);
    expect(memGrowthMb, `Memory grew ${memGrowthMb.toFixed(1)} MB > 100 MB (possible leak)`).toBeLessThan(100);
  });

  it('conductor survives backend server restart during soak', async () => {
    if (!SOAK_ENABLED) {
      console.log('  Skipping (SOAK not set)');
      return;
    }

    const client = spawnFreshClient();
    const changedPromise = client.waitForToolsChanged(60_000);
    await client.initialize();
    await changedPromise;

    // 10 successful tool calls before reload
    let preReloadOk = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await client.callTool('get_capabilities', {});
        preReloadOk++;
      } catch (err) {
        console.warn(`  Pre-reload call ${i + 1} failed: ${err}`);
      }
    }

    console.log(`  Pre-reload: ${preReloadOk}/10 successful`);

    // Trigger server reload
    try {
      await client.callTool('reload_servers', {});
      console.log('  reload_servers called');
    } catch (err) {
      console.warn(`  reload_servers threw: ${err} — continuing`);
    }

    // Wait for tools/list_changed after reload
    try {
      await client.waitForToolsChanged(30_000);
      console.log('  tools/list_changed received after reload');
    } catch (err) {
      console.warn(`  Did not receive toolsChanged after reload: ${err}`);
    }

    // 10 successful calls after reload
    let postReloadOk = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await client.callTool('get_capabilities', {});
        postReloadOk++;
      } catch (err) {
        console.warn(`  Post-reload call ${i + 1} failed: ${err}`);
      }
    }

    console.log(`  Post-reload: ${postReloadOk}/10 successful`);

    await client.close().catch(() => { /* ignore */ });

    const totalCalls = preReloadOk + postReloadOk;
    const totalAttempts = 20;
    const successRate = totalCalls / totalAttempts;

    expect(successRate, `Only ${totalCalls}/${totalAttempts} calls succeeded across reload`).toBeGreaterThanOrEqual(0.9);
  });

  it('tool count remains stable after repeated reload_servers calls', async () => {
    if (!SOAK_ENABLED) {
      console.log('  Skipping (SOAK not set)');
      return;
    }

    const client = spawnFreshClient();
    const changedPromise = client.waitForToolsChanged(60_000);
    await client.initialize();
    await changedPromise;

    const { tools: initialTools } = await client.listTools();
    const initialCount = initialTools.length;
    console.log(`  Initial tool count: ${initialCount}`);

    const counts: number[] = [initialCount];

    for (let round = 0; round < 5; round++) {
      try {
        await client.callTool('reload_servers', {});
        await client.waitForToolsChanged(30_000);
      } catch (err) {
        console.warn(`  Round ${round + 1} reload failed: ${err}`);
      }

      const { tools } = await client.listTools();
      counts.push(tools.length);
      console.log(`  After reload ${round + 1}: ${tools.length} tools`);
    }

    await client.close().catch(() => { /* ignore */ });

    // Tool count should be stable — within ±5 of the initial count
    for (const count of counts) {
      expect(
        Math.abs(count - initialCount),
        `Tool count drifted: started=${initialCount}, got=${count} (drift > 5)`
      ).toBeLessThanOrEqual(5);
    }
  });
});
