#!/usr/bin/env tsx
/**
 * T6 Recording Harness — captures real MCP server responses to commit-safe fixtures.
 *
 * Usage:
 *   npm run record:fixtures -- github
 *   npm run record:fixtures -- gmail --tools=list_labels,search_threads
 *   npm run record:fixtures -- --all
 *
 * Fixtures land at: test/fixtures/recordings/<server>/<tool>-<args-hash>.json
 * PII is tokenized at capture time so fixtures are safe to commit.
 *
 * Each server's default args live in:
 *   test/fixtures/recordings/<server>/_defaults.json
 * Customize that file for your account if the built-in defaults don't work.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tokenize } from '../src/utils/tokenize.js';

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

let serverArg: string | undefined;
let toolFilter: string[] = [];
let recordAll = false;

for (const arg of cliArgs) {
  if (arg === '--all') {
    recordAll = true;
  } else if (arg.startsWith('--tools=')) {
    toolFilter = arg.slice('--tools='.length).split(',').filter(Boolean);
  } else if (!arg.startsWith('--')) {
    serverArg = arg;
  }
}

if (!recordAll && !serverArg) {
  console.error('Usage: npm run record:fixtures -- <server> [--tools=tool1,tool2]');
  console.error('       npm run record:fixtures -- --all');
  process.exit(1);
}

// ─── Known servers ────────────────────────────────────────────────────────────

const KNOWN_SERVERS = [
  'github',
  'gmail',
  'gdrive',
  'gcalendar',
  'filesystem',
  'brave-search',
  'memory',
  'slack',
  'notion',
  'linear',
] as const;

// ─── Conductor config reader ──────────────────────────────────────────────────

interface ConductorServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ConductorConfig {
  mcpServers?: Record<string, ConductorServerConfig>;
}

function loadConductorConfig(): ConductorConfig {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~';
  const configPaths = [
    join(home, '.mcp-conductor.json'),
    join(home, '.claude', 'claude_desktop_config.json'),
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  ];

  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8')) as ConductorConfig;
        if (parsed.mcpServers && Object.keys(parsed.mcpServers).length > 0) {
          console.log(`  Config: ${p}`);
          return parsed;
        }
      } catch {
        // try next
      }
    }
  }

  console.warn('  Warning: no conductor config with mcpServers found');
  return {};
}

function getServerConfig(
  serverName: string,
  config: ConductorConfig,
): ConductorServerConfig | null {
  // Direct match
  if (config.mcpServers?.[serverName]) {
    return config.mcpServers[serverName]!;
  }

  // Common aliases
  const aliases: Record<string, string[]> = {
    github: ['github', 'gh', 'mcp-github', 'github-mcp'],
    gmail: ['gmail', 'google-gmail', 'mcp-gmail'],
    gdrive: ['gdrive', 'google-drive', 'mcp-gdrive', 'google_drive'],
    gcalendar: ['gcalendar', 'google-calendar', 'mcp-gcalendar'],
    filesystem: ['filesystem', 'fs', 'mcp-filesystem'],
    'brave-search': ['brave-search', 'brave', 'mcp-brave-search'],
    memory: ['memory', 'mcp-memory'],
    slack: ['slack', 'mcp-slack'],
    notion: ['notion', 'mcp-notion'],
    linear: ['linear', 'mcp-linear'],
  };

  const tryNames = aliases[serverName] ?? [serverName];
  for (const name of tryNames) {
    if (config.mcpServers?.[name]) {
      return config.mcpServers[name]!;
    }
  }

  return null;
}

// ─── Default args loader ──────────────────────────────────────────────────────

type ToolDefaults = Record<string, Record<string, unknown>>;

function loadDefaults(serverName: string): ToolDefaults {
  const defaultsPath = resolve(
    process.cwd(),
    'test/fixtures/recordings',
    serverName,
    '_defaults.json',
  );
  if (existsSync(defaultsPath)) {
    try {
      return JSON.parse(readFileSync(defaultsPath, 'utf-8')) as ToolDefaults;
    } catch {
      console.warn(`  Warning: failed to parse _defaults.json for ${serverName}`);
    }
  }
  return {};
}

// ─── Arg hashing ─────────────────────────────────────────────────────────────

function argsHash(toolArgs: Record<string, unknown>): string {
  const stable = JSON.stringify(toolArgs, Object.keys(toolArgs).sort());
  return 'sha256:' + createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

// ─── PII tokenization ─────────────────────────────────────────────────────────

function tokenizeResponse(obj: unknown): unknown {
  const raw = JSON.stringify(obj);
  const result = tokenize(raw, {
    matchers: ['email', 'phone', 'ssn', 'credit_card', 'iban', 'ipv4'],
  });
  try {
    return JSON.parse(result.tokenized) as unknown;
  } catch {
    // If the tokenized value isn't valid JSON (edge case), return as string
    return result.tokenized;
  }
}

// ─── Fixture shape ────────────────────────────────────────────────────────────

export interface RecordedFixture {
  /** MCP server name (matches directory name) */
  server: string;
  /** Tool name as returned by listTools() */
  tool: string;
  /** sha256 prefix of serialized args — identifies the args variant */
  argsHash: string;
  /** Args passed to the tool (may be empty object for no-arg tools) */
  args: Record<string, unknown>;
  /** Tokenized response from the server */
  response: unknown;
  /** Raw byte count of response JSON before tokenization */
  responseBytes: number;
  /** ISO 8601 timestamp */
  recordedAt: string;
  /**
   * True for fixtures that ship in the repo as minimal examples.
   * These are excluded from the real-API savings assertions (T5)
   * because their small byte counts produce lower savings than real responses.
   */
  synthetic?: boolean;
}

// ─── Per-server recording ─────────────────────────────────────────────────────

async function recordServer(serverName: string, config: ConductorConfig): Promise<void> {
  const serverConfig = getServerConfig(serverName, config);
  if (!serverConfig) {
    console.error(
      `  ✗  No config found for server "${serverName}" in ~/.mcp-conductor.json`,
    );
    console.error('     Add the server to your conductor config and re-run.');
    return;
  }

  console.log(`\n◆ Recording: ${serverName}`);
  console.log(`  Command: ${serverConfig.command} ${(serverConfig.args ?? []).join(' ')}`);

  const defaults = loadDefaults(serverName);
  const outDir = resolve(process.cwd(), 'test/fixtures/recordings', serverName);
  mkdirSync(outDir, { recursive: true });

  // Merge process env with server-specific env overrides
  const mergedEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    ...(serverConfig.env ?? {}),
  };

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: mergedEnv,
  });

  const client = new Client(
    { name: 'mcp-conductor-recorder', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log('  Connected');

    const { tools } = await client.listTools();
    const toolsToRecord =
      toolFilter.length > 0 ? tools.filter((t) => toolFilter.includes(t.name)) : tools;

    console.log(`  Tools to record: ${toolsToRecord.length} / ${tools.length} total`);
    if (toolFilter.length > 0) {
      const missing = toolFilter.filter((f) => !tools.some((t) => t.name === f));
      if (missing.length > 0) {
        console.warn(`  Warning: filter named tools not found on server: ${missing.join(', ')}`);
      }
    }

    let recorded = 0;
    let skipped = 0;
    let errors = 0;

    for (const tool of toolsToRecord) {
      const toolArgs = (defaults[tool.name] ?? {}) as Record<string, unknown>;
      const hash = argsHash(toolArgs);
      const outPath = join(outDir, `${tool.name}-${hash}.json`);

      if (existsSync(outPath)) {
        console.log(`  ↷  ${tool.name} (already recorded, skipping)`);
        skipped++;
        continue;
      }

      try {
        process.stdout.write(`  →  ${tool.name} ... `);

        const rawResponse = await client.callTool({
          name: tool.name,
          arguments: toolArgs,
        });

        const rawJson = JSON.stringify(rawResponse);
        const responseBytes = Buffer.byteLength(rawJson, 'utf-8');

        const tokenized = tokenizeResponse(rawResponse);

        const fixture: RecordedFixture = {
          server: serverName,
          tool: tool.name,
          argsHash: hash,
          args: toolArgs,
          response: tokenized,
          responseBytes,
          recordedAt: new Date().toISOString(),
        };

        writeFileSync(outPath, JSON.stringify(fixture, null, 2), 'utf-8');
        console.log(`${responseBytes.toLocaleString()} bytes → saved`);
        recorded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAILED (${msg.slice(0, 100)})`);
        errors++;
      }
    }

    console.log(`  Done: ${recorded} recorded, ${skipped} skipped, ${errors} errors`);
  } finally {
    await client.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('MCP Conductor — Recording Harness (T6)');
  console.log('========================================');

  const config = loadConductorConfig();
  const serverCount = Object.keys(config.mcpServers ?? {}).length;
  console.log(`Loaded conductor config (${serverCount} servers configured)`);

  const toRecord: string[] = recordAll ? [...KNOWN_SERVERS] : [serverArg!];

  for (const server of toRecord) {
    await recordServer(server, config);
  }

  console.log('\nRecording complete.');
  console.log('Fixtures saved to: test/fixtures/recordings/');
  console.log('Verify fixtures contain no PII before committing.');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
