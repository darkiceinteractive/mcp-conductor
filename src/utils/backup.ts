/**
 * File backup utility used by CLI adapters before any destructive write.
 *
 * Extracted so all adapters share one consistent backup strategy: a
 * timestamped `.bak.YYYYMMDDHHMMSS` sibling alongside the original file.
 *
 * @module utils/backup
 */

import { existsSync, copyFileSync } from 'node:fs';

/**
 * Write a timestamped backup file alongside the original.
 *
 * Uses a `.bak.YYYYMMDDHHMMSS` suffix so repeat runs produce distinct
 * files rather than silently overwriting the previous backup. If a file with
 * the same timestamp already exists (sub-second collision), a random 4-char
 * hex suffix is appended to guarantee uniqueness.
 *
 * @param filePath - Absolute path to the file to back up.
 * @returns The path of the backup file that was written.
 */
export function writeBackup(filePath: string): string {
  // toISOString() → "2026-05-04T11:23:45.678Z"; strip non-digits, take first 14.
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let backupPath = `${filePath}.bak.${ts}`;

  // Sub-second collision guard: append 4 random hex chars.
  if (existsSync(backupPath)) {
    const salt = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0');
    backupPath = `${backupPath}.${salt}`;
  }

  copyFileSync(filePath, backupPath);
  return backupPath;
}
