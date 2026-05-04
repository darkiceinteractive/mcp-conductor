/**
 * Disk persistence for the tool catalog.
 *
 * Snapshot format (JSON):
 * {
 *   "version": "1",
 *   "savedAt": 1714816000000,   // epoch ms
 *   "catalog": [ ...ToolDefinition[] ]
 * }
 *
 * On load, if the `version` field is missing or does not match SNAPSHOT_VERSION,
 * the snapshot is rejected and the caller must fall back to a live refresh.
 *
 * @module registry/snapshot
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition } from './index.js';

/** Bump this when the ToolDefinition shape changes in a breaking way. */
export const SNAPSHOT_VERSION = '1';

export interface SnapshotFile {
  version: string;
  savedAt: number;
  catalog: ToolDefinition[];
}

/**
 * Persist `catalog` to `path` as a formatted JSON file.
 * Creates intermediate directories if needed.
 * Throws on I/O error — callers should handle gracefully.
 */
export async function saveSnapshot(path: string, catalog: ToolDefinition[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const file: SnapshotFile = {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    catalog,
  };

  await writeFile(path, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * Load a previously saved snapshot from `path`.
 *
 * Returns the catalog if the file exists and the version matches.
 * Returns `null` if:
 * - The file does not exist
 * - The file is not valid JSON
 * - The version field is missing or does not match SNAPSHOT_VERSION
 *
 * Never throws — callers fall back to a live refresh on null.
 */
export async function loadSnapshot(path: string): Promise<ToolDefinition[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // File not found or not readable — expected on first run.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    (parsed as SnapshotFile).version !== SNAPSHOT_VERSION ||
    !Array.isArray((parsed as SnapshotFile).catalog)
  ) {
    // Version mismatch or malformed — force a live refresh.
    return null;
  }

  return (parsed as SnapshotFile).catalog;
}
