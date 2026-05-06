/**
 * Config-file backup utility.
 *
 * Creates a timestamped `.bak.YYYYMMDDHHMMSS` copy of a file before it is
 * mutated by any adapter's `serialize()` call.  The backup is written as a
 * byte-for-byte copy of the source so the original can always be restored.
 *
 * @module utils/backup
 */

import { copyFileSync, existsSync } from 'node:fs';

/**
 * Return a zero-padded two-digit string.
 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the `.bak.YYYYMMDDHHMMSS` suffix for the given date.
 *
 * Uses local time so the timestamp matches the user's wall clock when they
 * inspect the backup file name.
 */
export function buildBackupSuffix(date: Date = new Date()): string {
  const Y = String(date.getFullYear());
  const M = pad2(date.getMonth() + 1);
  const D = pad2(date.getDate());
  const h = pad2(date.getHours());
  const m = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `.bak.${Y}${M}${D}${h}${m}${s}`;
}

/**
 * Write a timestamped backup of `sourcePath` next to the original file.
 *
 * The backup path is `{sourcePath}{suffix}` where `suffix` is produced by
 * {@link buildBackupSuffix}.
 *
 * If `sourcePath` does not exist this function is a no-op — there is nothing
 * to back up.
 *
 * @param sourcePath - Absolute path to the file to back up.
 * @param date       - Date to stamp the backup with (defaults to now).
 * @returns The path of the backup file, or `null` when the source did not exist.
 */
export function writeBackup(sourcePath: string, date: Date = new Date()): string | null {
  if (!existsSync(sourcePath)) {
    return null;
  }
  const backupPath = `${sourcePath}${buildBackupSuffix(date)}`;
  copyFileSync(sourcePath, backupPath);
  return backupPath;
}
