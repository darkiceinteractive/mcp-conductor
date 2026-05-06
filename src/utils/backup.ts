/**
 * Config file backup utility.
 *
 * Creates a timestamped `.bak.YYYYMMDDHHMMSS` copy of a file before it is
 * mutated by an adapter's serialize() call.  This gives users a restore point
 * if a write goes wrong.
 *
 * @module utils/backup
 */

import { copyFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as the compact string used in backup filenames.
 *
 * Output format: `YYYYMMDDHHMMSS` (14 digits, always UTC to avoid
 * daylight-saving ambiguity in file names).
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Copy `filePath` to `filePath.bak.YYYYMMDDHHMMSS` (UTC timestamp).
 *
 * @param filePath - Absolute path of the file to back up.
 * @param now      - Optional date used for the timestamp (defaults to `new Date()`).
 *                   Exposed for deterministic testing.
 * @returns The path of the newly created backup file.
 * @throws {Error} If `filePath` does not exist.
 */
export function createBackup(filePath: string, now: Date = new Date()): string {
  if (!existsSync(filePath)) {
    throw new Error(`Cannot create backup: file does not exist at ${filePath}`);
  }
  const backupPath = `${filePath}.bak.${formatTimestamp(now)}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}
