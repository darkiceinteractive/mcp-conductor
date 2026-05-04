/**
 * mcp.compact — Field selection and data trimming helper
 *
 * Zero-roundtrip sandbox helper. Reduces large data objects to only the
 * fields the caller cares about, truncates arrays, clips strings, and
 * limits nesting depth. All operations are synchronous and in-process.
 *
 * @module runtime/helpers/compact
 */

export interface CompactOptions {
  /**
   * Dot-path field selectors to retain. Supports nested paths like
   * 'labels.name'. If omitted, all fields are retained (only structural
   * limits apply).
   */
  fields?: string[];
  /** Maximum number of items to retain in any array. */
  maxItems?: number;
  /** Maximum object nesting depth (root = depth 0). */
  maxDepth?: number;
  /** Maximum character length for any string value. */
  maxStringLength?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a dot-path like "labels.name" into a nested selector tree.
 * { labels: { name: true }, id: true }
 */
function buildSelectorTree(fields: string[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? '';
      if (i === parts.length - 1) {
        node[part] = true;
      } else {
        if (typeof node[part] !== 'object' || node[part] === null) {
          node[part] = {};
        }
        node = node[part] as Record<string, unknown>;
      }
    }
  }
  return tree;
}

function trimValue(
  value: unknown,
  selector: Record<string, unknown> | null,
  opts: CompactOptions,
  depth: number,
): unknown {
  const maxDepth = opts.maxDepth ?? Infinity;

  if (depth > maxDepth) {
    return typeof value === 'object' && value !== null ? '[truncated]' : value;
  }

  if (typeof value === 'string') {
    const max = opts.maxStringLength;
    if (max !== undefined && value.length > max) {
      return value.slice(0, max) + '…';
    }
    return value;
  }

  if (Array.isArray(value)) {
    const maxItems = opts.maxItems;
    const arr = maxItems !== undefined ? value.slice(0, maxItems) : value;
    return arr.map((item) => trimValue(item, selector, opts, depth + 1));
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    if (selector && Object.keys(selector).length > 0) {
      // Only keep selected keys
      for (const key of Object.keys(selector)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const childSelector = selector[key];
          const nextSelector =
            childSelector === true ? null : (childSelector as Record<string, unknown>);
          result[key] = trimValue(obj[key], nextSelector, opts, depth + 1);
        }
      }
    } else {
      // No field filter — apply structural limits only
      for (const key of Object.keys(obj)) {
        result[key] = trimValue(obj[key], null, opts, depth + 1);
      }
    }

    return result;
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact a data value by selecting fields, truncating arrays, clipping
 * strings, and limiting nesting depth.
 *
 * @example
 * const lean = compact(issues, { fields: ['id', 'title', 'labels.name'], maxItems: 20 });
 */
export function compact<T>(data: T, options: CompactOptions = {}): T {
  const selector =
    options.fields && options.fields.length > 0
      ? buildSelectorTree(options.fields)
      : null;

  return trimValue(data, selector, options, 0) as T;
}
