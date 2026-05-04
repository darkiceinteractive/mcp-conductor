/**
 * mcp.delta — Cross-call diff wrapper
 *
 * Wraps cache.delta from Phase 2 (when available) to return only the
 * changed portions of a tool result relative to the previous call.
 * This file designs the API surface so it works once Phase 2 cache
 * lands; for now it performs a structural diff in-process.
 *
 * @module runtime/helpers/delta
 */

export interface DeltaResult<T> {
  /** Whether data changed relative to the previous snapshot */
  changed: boolean;
  /** The delta payload (full object if no previous snapshot) */
  delta: Partial<T> | T;
  /** Keys that changed (for objects) or null for primitives/arrays */
  changedKeys?: string[];
  /** Number of items added (arrays only) */
  added?: number;
  /** Number of items removed (arrays only) */
  removed?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 cache bridge (duck-typed — avoids hard import dependency)
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheDeltaBridge {
  delta<T>(
    server: string,
    tool: string,
    args: unknown,
    current: T,
  ): Promise<DeltaResult<T>>;
}

let _cacheBridge: CacheDeltaBridge | null = null;

/**
 * Register the Phase 2 cache bridge. Called during system initialisation
 * once the cache layer is available.
 */
export function registerCacheBridge(bridge: CacheDeltaBridge): void {
  _cacheBridge = bridge;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process structural differ (fallback when Phase 2 is not present)
// ─────────────────────────────────────────────────────────────────────────────

// In-memory snapshot store keyed by "server::tool::argsHash"
const _snapshots = new Map<string, unknown>();

function hashArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? 'null';
  } catch {
    return String(args);
  }
}

function snapshotKey(server: string, tool: string, args: unknown): string {
  return `${server}::${tool}::${hashArgs(args)}`;
}

function diffObjects<T extends Record<string, unknown>>(
  prev: T,
  curr: T,
): { delta: Partial<T>; changedKeys: string[] } {
  const delta: Partial<T> = {};
  const changedKeys: string[] = [];

  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of allKeys) {
    const prevVal = JSON.stringify(prev[key]);
    const currVal = JSON.stringify(curr[key]);
    if (prevVal !== currVal) {
      delta[key as keyof T] = curr[key] as T[keyof T];
      changedKeys.push(key);
    }
  }

  return { delta, changedKeys };
}

function diffArrays<T>(prev: T[], curr: T[]): { changed: boolean; added: number; removed: number } {
  const prevLen = prev.length;
  const currLen = curr.length;
  const added = Math.max(0, currLen - prevLen);
  const removed = Math.max(0, prevLen - currLen);
  const changed = JSON.stringify(prev) !== JSON.stringify(curr);
  return { changed, added, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the delta for a tool result relative to the previous call.
 * Delegates to Phase 2 cache.delta when registered; falls back to
 * in-process structural differ.
 *
 * @example
 * const d = await delta('github', 'list_issues', { repo: 'foo' }, issues);
 * if (d.changed) console.log('Changed keys:', d.changedKeys);
 */
export async function delta<T>(
  server: string,
  tool: string,
  args: unknown,
  current: T,
): Promise<DeltaResult<T>> {
  // Prefer Phase 2 cache bridge if available
  if (_cacheBridge) {
    return _cacheBridge.delta(server, tool, args, current);
  }

  // Fallback: in-process structural differ
  const key = snapshotKey(server, tool, args);
  const previous = _snapshots.get(key);
  _snapshots.set(key, current);

  if (previous === undefined) {
    // No previous snapshot — return full result
    return { changed: true, delta: current };
  }

  // Array diff
  if (Array.isArray(current) && Array.isArray(previous)) {
    const { changed, added, removed } = diffArrays(previous as unknown[], current as unknown[]);
    return {
      changed,
      delta: changed ? current : ([] as unknown as T),
      added,
      removed,
    };
  }

  // Object diff
  if (
    typeof current === 'object' &&
    current !== null &&
    typeof previous === 'object' &&
    previous !== null &&
    !Array.isArray(current)
  ) {
    const { delta: objectDelta, changedKeys } = diffObjects(
      previous as Record<string, unknown>,
      current as unknown as Record<string, unknown>,
    );
    const changed = changedKeys.length > 0;
    return {
      changed,
      delta: changed ? (objectDelta as Partial<T>) : ({} as Partial<T>),
      changedKeys,
    };
  }

  // Primitive diff
  const changed = JSON.stringify(previous) !== JSON.stringify(current);
  return { changed, delta: changed ? current : (undefined as unknown as T) };
}

/**
 * Clear all in-process snapshots (useful in tests).
 */
export function clearSnapshots(): void {
  _snapshots.clear();
}
