/**
 * test-server command: transient connect, list tools, latency probe.
 * @module cli/commands/test-server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { minimalChildEnv } from '../../utils/index.js';
import { loadConductorConfig } from '../../config/index.js';
import type { ConductorServerConfig } from '../../config/index.js';

export interface TestServerOptions {
  /** Server name (looks up in conductor config) */
  name?: string;
  /** Directly specify command (bypasses config lookup) */
  command?: string;
  /** Command args */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Connection timeout ms */
  timeoutMs?: number;
}

export interface TestServerResult {
  success: boolean;
  serverName: string;
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  latencyMs: number;
  error?: string;
}

/**
 * Transiently connect to an MCP server, list its tools and measure latency.
 * The connection is always closed afterwards — no persistent registration.
 */
export async function testServer(options: TestServerOptions): Promise<TestServerResult> {
  const name = options.name ?? 'unnamed';
  let command: string;
  let args: string[];
  let env: Record<string, string> | undefined;

  if (options.command) {
    command = options.command;
    args = options.args ?? [];
    env = options.env;
  } else if (options.name) {
    const config = loadConductorConfig();
    if (!config) {
      return { success: false, serverName: name, connected: false, toolCount: 0, tools: [], latencyMs: 0, error: 'No conductor config found' };
    }
    const serverDef = config.servers[options.name] as ConductorServerConfig | undefined;
    if (!serverDef) {
      return { success: false, serverName: name, connected: false, toolCount: 0, tools: [], latencyMs: 0, error: `Server '${options.name}' not found in conductor config` };
    }
    command = serverDef.command;
    args = serverDef.args ?? [];
    env = serverDef.env;
  } else {
    return { success: false, serverName: name, connected: false, toolCount: 0, tools: [], latencyMs: 0, error: 'Either name or command must be provided' };
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const t0 = Date.now();

  const client = new Client({ name: 'mcp-conductor-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...minimalChildEnv(), ...(env ?? {}) },
  });

  try {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    await Promise.race([connectPromise, timeoutPromise]);

    const listResult = await client.listTools();
    const latencyMs = Date.now() - t0;
    const tools = (listResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
    }));

    return {
      success: true,
      serverName: name,
      connected: true,
      toolCount: tools.length,
      tools,
      latencyMs,
    };
  } catch (err) {
    return {
      success: false,
      serverName: name,
      connected: false,
      toolCount: 0,
      tools: [],
      latencyMs: Date.now() - t0,
      error: String(err),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // ignore cleanup errors
    }
  }
}
