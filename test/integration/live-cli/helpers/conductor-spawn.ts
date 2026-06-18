/**
 * Spawns the local conductor dist/index.js and returns a ready McpStdioClient.
 *
 * Usage in tests:
 *   let conductor: Awaited<ReturnType<typeof spawnConductor>>;
 *   beforeEach(async () => { conductor = await spawnConductor(); });
 *   afterEach(async () => { await conductor.close(); });
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { McpStdioClient } from './mcp-stdio-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Absolute path to the built conductor entry point
const CONDUCTOR_DIST = resolve(
  join(__dirname, '..', '..', '..', '..', 'dist', 'index.js')
);

const DEFAULT_CONFIG_PATH = '/Users/mattcrombie/.mcp-conductor.json';

export interface ConductorHandle {
  client: McpStdioClient;
  /** Wall-clock ms elapsed from spawn() call to initialize() returning */
  startMs: number;
  close(): Promise<void>;
}

export interface SpawnOpts {
  /** Absolute path to .mcp-conductor.json; defaults to ~/.mcp-conductor.json */
  configPath?: string;
  /** Additional env vars to merge into the conductor process environment */
  env?: Record<string, string>;
}

/**
 * Spawn the conductor, run MCP initialize, and return the handle.
 *
 * The returned `close()` must be called in afterEach/afterAll (even on failure).
 * The caller is responsible for calling `waitForToolsChanged()` themselves if
 * they need passthrough tools — this function only waits for static tools.
 */
export async function spawnConductor(opts: SpawnOpts = {}): Promise<ConductorHandle> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;

  const env: Record<string, string> = {
    MCP_CONDUCTOR_CONFIG: configPath,
    NODE_ENV: 'test',
    ...opts.env,
  };

  const t0 = Date.now();

  const client = new McpStdioClient('node', [CONDUCTOR_DIST], env);

  // Wait for initialize to complete — this confirms static tools are live
  await client.initialize();

  const startMs = Date.now() - t0;

  return {
    client,
    startMs,
    async close() {
      await client.close();
    },
  };
}
