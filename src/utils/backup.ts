/**
 * Config file backup utility.
 *
 * Creates a timestamped `.bak.YYYYMMDDHHMMSS` copy of a file before it is
 * overwritten by an adapter serialisation pass.  The backup sits next to the
 * original so it is easy to locate and restore manually.
 *
 * @module utils/backup
 */

import { copyFileSync, existsSync } from 'node:fs';

/**
 * Format a Date as `YYYYMMDDHHMMSS` (UTC).
 *
 * Using UTC keeps backup names unambiguous across time-zones and DST changes.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/**
 * Copy `sourcePath` to `<sourcePath>.bak.YYYYMMDDHHMMSS` if the source exists.
 *
 * Silently skips when the source file does not exist (nothing to back up).
 *
 * @param sourcePath - Absolute path to the file to back up.
 * @param now        - Optional Date override for deterministic tests.
 * @returns The backup path if a copy was written, or `null` if skipped.
 */
export function backupFile(sourcePath: string, now?: Date): string | null {
  if (!existsSync(sourcePath)) {
    return null;
  }
  const ts = formatTimestamp(now ?? new Date());
  const dest = `${sourcePath}.bak.${ts}`;
  copyFileSync(sourcePath, dest);
  return dest;
}
