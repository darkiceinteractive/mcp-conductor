/**
 * CLI — replay subcommand
 *
 * Usage:
 *   mcp-conductor-cli replay <recordingPath> [--at <seq> --op replace|skip [--with <json>]] ...
 *   mcp-conductor-cli replay --list
 *
 * Options:
 *   --list                   List all available recordings
 *   --at <n>                 Sequence index for a modification
 *   --op replace|skip        Operation to apply at that index
 *   --with <json>            JSON value for replace operation
 *   --recordings-dir <path>  Override the recordings directory
 */

import { ReplayRecorder, type ReplayModification } from '../observability/index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ParsedArgs {
  list: boolean;
  recordingPath?: string;
  recordingsDir?: string;
  modifications: ReplayModification[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { list: false, modifications: [] };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--list') {
      result.list = true;
      i++;
      continue;
    }

    if (arg === '--recordings-dir') {
      result.recordingsDir = argv[++i];
      i++;
      continue;
    }

    if (arg === '--at') {
      const at = parseInt(argv[++i] ?? '0', 10);
      i++;
      const nextArg = argv[i];
      const op: string = nextArg === '--op' ? (argv[++i] ?? 'replace') : 'replace';
      if (nextArg === '--op') i++;
      let withValue: unknown;
      if (i < argv.length && argv[i] === '--with') {
        withValue = JSON.parse(argv[++i] ?? 'null');
        i++;
      }
      result.modifications.push({ at, op: op as 'replace' | 'skip', with: withValue });
      continue;
    }

    if (arg && !arg.startsWith('--')) {
      result.recordingPath = arg;
    }

    i++;
  }

  return result;
}

export async function runReplayCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const recordingsDir = args.recordingsDir
    ?? join(homedir(), '.mcp-conductor', 'recordings');

  const recorder = new ReplayRecorder({ recordingsDir });

  if (args.list) {
    const recordings = recorder.listRecordings();
    if (recordings.length === 0) {
      process.stdout.write('No recordings found.\n');
      return;
    }
    for (const r of recordings) {
      const kb = (r.sizeBytes / 1024).toFixed(1);
      const date = new Date(r.createdAt).toISOString();
      process.stdout.write(`${r.sessionId}  ${kb} KB  ${date}\n`);
    }
    return;
  }

  if (!args.recordingPath) {
    process.stderr.write(
      'Usage: replay <recordingPath> [--at <seq> --op replace|skip [--with <json>]] ...\n' +
      '       replay --list\n'
    );
    process.exit(1);
  }

  const { result, divergence } = recorder.replay(args.recordingPath, args.modifications);

  if (divergence) {
    process.stderr.write(
      `Divergence detected at seq ${divergence.at}:\n` +
      `  expected: ${JSON.stringify(divergence.expected)}\n` +
      `  actual:   ${JSON.stringify(divergence.actual)}\n`
    );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (divergence) {
    process.exit(2);
  }
}
