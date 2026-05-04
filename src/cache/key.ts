/**
 * Content-addressed cache key derivation.
 *
 * Keys are stable across process restarts: the same args always produce the
 * same hash regardless of JS object-key insertion order. Schema-normalised
 * args (via the registry validator) are used so that semantically-equivalent
 * calls with differently-ordered properties hash identically.
 *
 * Format: `${server}:${tool}:${sha256hex(stableJsonStringify(args))}`
 *
 * @module cache/key
 */

import { createHash } from 'node:crypto';
import type { CacheKey } from './index.js';

/**
 * Stable JSON stringify — sorts object keys recursively so that key ordering
 * differences between calls do not produce different hashes.
 *
 * Handles:
 * - Objects (sorted keys)
 * - Arrays (order preserved — array order IS semantically meaningful)
 * - Primitives (null, boolean, number, string, undefined → JSON-serialised)
 * - Circular references: throws, same as JSON.stringify
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = sortObjectKeys((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * SHA-256 hex digest of a stable-stringified value.
 * The returned string is always 64 hex characters.
 */
export function hashArgs(args: unknown): string {
  const str = stableJsonStringify(args ?? {});
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Build a structured CacheKey from server, tool, and args.
 */
export function buildCacheKey(server: string, tool: string, args: unknown): CacheKey {
  return { server, tool, argsHash: hashArgs(args) };
}

/**
 * Serialise a CacheKey to the string format used on disk and in memory maps.
 * Format: `${server}:${tool}:${argsHash}`
 */
export function cacheKeyToString(key: CacheKey): string {
  return `${key.server}:${key.tool}:${key.argsHash}`;
}

/**
 * Parse a stringified cache key back to a CacheKey struct.
 * Returns null when the format is invalid.
 */
export function parseCacheKey(str: string): CacheKey | null {
  // Key has exactly 3 segments: server, tool, and a 64-char hex hash.
  // Tool names may contain underscores; server names should not contain colons.
  const firstColon = str.indexOf(':');
  if (firstColon < 0) return null;

  const hashStart = str.lastIndexOf(':');
  if (hashStart <= firstColon) return null;

  const server = str.substring(0, firstColon);
  const tool = str.substring(firstColon + 1, hashStart);
  const argsHash = str.substring(hashStart + 1);

  if (!server || !tool || argsHash.length !== 64) return null;

  return { server, tool, argsHash };
}
