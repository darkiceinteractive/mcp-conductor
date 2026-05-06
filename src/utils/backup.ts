/**
 * Shared file backup utility.
 *
 * Creates a `.bak.YYYYMMDDHHMMSS` sibling file beside the original before any
 * destructive write so that repeat runs produce distinct backup files rather
 * than silently overwriting each other.
 *
 * @module utils/backup
 */

import { copyFileSync, existsSync } from 'node:fs';

/**
 * Write a timestamped backup file alongside the original.
 *
 * The suffix format is `.bak.YYYYMMDDHHMMSS` derived from the current UTC
 * time.  If a backup with that exact name already exists (sub-second
 * collision), a 4-char random hex suffix is appended to guarantee uniqueness.
 *
 * @param filePath - Absolute path to the file to back up.  The file must
 *   exist; callers should guard with `existsSync` before calling.
 * @returns The absolute path of the newly created backup file.
 */
export function writeBackup(filePath: string): string {
  // toISOString() → "2026-05-05T14:30:22.456Z"
  // Replace every non-digit, then take the first 14 chars → "20260505143022"
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
