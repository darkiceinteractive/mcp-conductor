/**
 * Delta encoding for repeated tool-call results.
 *
 * When a caller wants to know "what changed since the last call", we compute
 * a structural diff and return only the delta. This is significantly smaller
 * than the full result for incremental work (e.g. polling a list of issues).
 *
 * Strategy:
 * - Arrays: compare items by identity (JSON equality). Report added/removed.
 *   Items that appear in both but at different positions count as unchanged
 *   (we do not track moves for simplicity).
 * - Objects at the top level: compare property values; modified = { before, after }.
 * - Scalars or mixed types: return full result (no useful delta possible).
 * - When the delta payload is larger than the full result, return full result.
 *
 * @module cache/delta
 */

import type { DeltaResult } from './index.js';

/**
 * Compute the delta between a previous result and the current result.
 *
 * Always returns a DeltaResult. When results are identical, returns
 * `{ unchanged: true }`. When results differ but the full payload is
 * smaller than the delta, `full` is set and the delta fields are absent.
 */
export function computeDelta(previous: unknown, current: unknown): DeltaResult {
  // Identical check (fast path)
  if (deepEqual(previous, current)) {
    return { unchanged: true };
  }

  // Array diff
  if (Array.isArray(previous) && Array.isArray(current)) {
    return arrayDelta(previous, current);
  }

  // Object diff
  if (isPlainObject(previous) && isPlainObject(current)) {
    return objectDelta(
      previous as Record<string, unknown>,
      current as Record<string, unknown>
    );
  }

  // Scalar or mixed-type change — return full
  return { unchanged: false, full: current };
}

// ── Array diff ────────────────────────────────────────────────────────────────

function arrayDelta(prev: unknown[], curr: unknown[]): DeltaResult {
  const added: unknown[] = [];
  const removed: unknown[] = [];

  // Items in curr but not in prev
  for (const item of curr) {
    if (!prev.some((p) => deepEqual(p, item))) {
      added.push(item);
    }
  }

  // Items in prev but not in curr
  for (const item of prev) {
    if (!curr.some((c) => deepEqual(c, item))) {
      removed.push(item);
    }
  }

  const delta: DeltaResult = {
    unchanged: false,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
  };

  // Only prefer full when the delta is genuinely larger than the full result
  if (shouldReturnFull(delta, curr)) {
    return { unchanged: false, full: curr };
  }

  return delta;
}

// ── Object diff ───────────────────────────────────────────────────────────────

function objectDelta(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>
): DeltaResult {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const modified: Array<{ before: unknown; after: unknown }> = [];

  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);

  for (const key of allKeys) {
    const inPrev = key in prev;
    const inCurr = key in curr;

    if (!inPrev && inCurr) {
      added.push({ [key]: curr[key] });
    } else if (inPrev && !inCurr) {
      removed.push({ [key]: prev[key] });
    } else if (!deepEqual(prev[key], curr[key])) {
      modified.push({ before: { [key]: prev[key] }, after: { [key]: curr[key] } });
    }
  }

  const delta: DeltaResult = {
    unchanged: false,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
    modified: modified.length > 0 ? modified : undefined,
  };

  if (shouldReturnFull(delta, curr)) {
    return { unchanged: false, full: curr };
  }

  return delta;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep equality via JSON serialisation. Fast enough for typical MCP result
 * sizes; avoids pulling in a heavy comparison library.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Returns true when the full current value is strictly smaller (in serialised
 * bytes) than the delta payload. We use a strict greater-than comparison so
 * that delta is preferred when sizes are equal.
 */
function shouldReturnFull(delta: DeltaResult, current: unknown): boolean {
  try {
    const deltaSize = Buffer.byteLength(JSON.stringify(delta), 'utf8');
    const fullSize = Buffer.byteLength(JSON.stringify(current), 'utf8');
    return deltaSize > fullSize;
  } catch {
    return true; // If we can't measure, default to full
  }
}
