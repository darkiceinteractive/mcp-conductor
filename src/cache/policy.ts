/**
 * Per-tool TTL policy for the cache layer.
 *
 * Policy resolution order (highest priority first):
 *  1. ToolDefinition.cacheable === false → never cache (return 0)
 *  2. ToolDefinition.cacheTtl            → explicit per-tool TTL
 *  3. Per-server config overrides (from CacheLayerOptions.policies)
 *  4. Default pattern table (mutations → 0, read patterns → ms per table below)
 *
 * TTL of 0 means "do not cache".
 *
 * @module cache/policy
 */

import type { ToolDefinition } from '../registry/index.js';

// ─── Default TTL table (milliseconds) ────────────────────────────────────────

/**
 * Substrings that identify mutation tools.
 * Checked against both prefixes (create_issue) and suffixes (issue_create)
 * to handle both MCP naming conventions.
 */
const MUTATION_SUBSTRINGS = [
  'create', 'update', 'delete', 'remove', 'add_', '_add',
  'write', 'push', 'insert', 'patch', 'put', 'post',
  'set_', 'reset', 'clear', 'archive', 'restore', 'move',
];

/** Glob-style prefix patterns with their default TTLs. */
const PREFIX_TTL_TABLE: Array<{ prefix: string; ttlMs: number }> = [
  { prefix: 'list_', ttlMs: 5 * 60 * 1000 },   // 5 min — listings change infrequently
  { prefix: 'search_', ttlMs: 5 * 60 * 1000 },  // 5 min
  { prefix: 'get_', ttlMs: 60 * 1000 },          // 1 min — identity-stable reads
  { prefix: 'read_', ttlMs: 60 * 1000 },         // 1 min — file reads
  { prefix: 'query_', ttlMs: 30 * 1000 },        // 30 sec — DB freshness/perf balance
  { prefix: 'fetch_', ttlMs: 30 * 1000 },        // 30 sec
];

/** Fallback TTL for tools that match none of the patterns above. */
export const DEFAULT_TTL_MS = 30 * 1000; // 30 sec

// ─── Per-server policy map (injected from CacheLayerOptions) ─────────────────

export type ServerPolicies = Record<string, Record<string, number>>;

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Determine the effective TTL in milliseconds for a tool call.
 *
 * Returns 0 when the result must not be cached (mutations or
 * `cacheable: false` annotation).
 */
export function resolveTtl(
  tool: ToolDefinition | null | undefined,
  serverPolicies?: ServerPolicies
): number {
  const toolName = tool?.name ?? '';

  // 1. Explicit cacheable:false annotation → never cache
  if (tool && tool.cacheable === false) {
    return 0;
  }

  // 2. Explicit cacheTtl annotation (cacheable must not be false)
  if (tool && typeof tool.cacheTtl === 'number') {
    return tool.cacheTtl;
  }

  // 3. Per-server policy override from config
  if (tool && serverPolicies) {
    const serverOverrides = serverPolicies[tool.server];
    if (serverOverrides && typeof serverOverrides[toolName] === 'number') {
      return serverOverrides[toolName];
    }
  }

  // 4. Default pattern table
  return defaultTtlForName(toolName);
}

/**
 * Determine the default TTL from the tool-name pattern table.
 * Public so tests can verify the defaults independently of ToolDefinition.
 */
export function defaultTtlForName(toolName: string): number {
  const lower = toolName.toLowerCase();

  // Mutations are never cached — check for mutation substrings
  for (const sub of MUTATION_SUBSTRINGS) {
    // Match whole-word boundaries: either at start, end, or adjacent to underscore
    const idx = lower.indexOf(sub);
    if (idx >= 0) {
      const before = idx === 0 ? '_' : lower[idx - 1];
      const after = idx + sub.length >= lower.length ? '_' : lower[idx + sub.length];
      // Accept if the mutation word is at a word boundary (underscore or string edge)
      if ((before === '_' || idx === 0) && (after === '_' || idx + sub.length === lower.length)) {
        return 0;
      }
    }
  }

  // Prefix match for read-like tools
  for (const { prefix, ttlMs } of PREFIX_TTL_TABLE) {
    if (lower.startsWith(prefix)) return ttlMs;
  }

  return DEFAULT_TTL_MS;
}

/**
 * Returns true when this tool should be cached (TTL > 0).
 */
export function isCacheable(
  tool: ToolDefinition | null | undefined,
  serverPolicies?: ServerPolicies
): boolean {
  return resolveTtl(tool, serverPolicies) > 0;
}
