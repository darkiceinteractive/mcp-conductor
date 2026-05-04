/**
 * Built-in routing recommendations for well-known MCP servers.
 *
 * These defaults apply when a server is discovered but has no user-provided
 * routing annotation. User config always takes precedence — these are applied
 * only when `routing` is absent from a tool's existing registry entry.
 *
 * Rationale for each entry:
 * - github: read-only identity/listing tools are safe direct passthrough;
 *   mutation tools stay execute_code to preserve sandbox audit trail.
 * - filesystem: read-only traversal is passthrough; writes/deletes stay in
 *   execute_code so the sandbox can enforce path policies.
 * - brave-search: single query → result, no side effects, tiny response.
 *
 * @module registry/built-in-recommendations
 */

/**
 * Per-server routing recommendations.
 *
 * Each entry maps a server name to:
 *   - `passthrough`: tools that should be exposed as first-class MCP tools.
 *
 * Every tool not listed in `passthrough` defaults to `execute_code`.
 */
export interface ServerRoutingRecommendation {
  /** Tool names that should be routed as passthrough. */
  passthrough: string[];
}

/**
 * Default routing table for known public MCP servers.
 *
 * Apply with `applyBuiltInRecommendations()` after `registry.refresh()`.
 * User config overrides (any existing `routing` annotation) are preserved.
 */
export const BUILT_IN_ROUTING: Record<string, ServerRoutingRecommendation> = {
  github: {
    passthrough: ['get_me', 'list_repositories'],
  },
  filesystem: {
    passthrough: ['read_file', 'list_directory'],
  },
  'brave-search': {
    passthrough: ['brave_web_search'],
  },
};

/**
 * Apply built-in routing recommendations to registry-discovered tools.
 *
 * Only sets `routing` when none is already present — user annotations and
 * config-file overrides are never overwritten.
 *
 * Returns the number of tools that were annotated.
 *
 * @param tools   All tools returned by `registry.getAllTools()`.
 * @param annotate  The `registry.annotate()` method bound to the ToolRegistry.
 */
export function applyBuiltInRecommendations(
  tools: Array<{ server: string; name: string; routing?: string }>,
  annotate: (server: string, name: string, meta: { routing: 'passthrough' | 'execute_code' }) => void
): number {
  let annotated = 0;

  for (const tool of tools) {
    // Never override a user-configured routing value.
    if (tool.routing !== undefined) {
      continue;
    }

    const rec = BUILT_IN_ROUTING[tool.server];
    if (!rec) {
      // Unknown server — default remains execute_code (no annotation needed).
      continue;
    }

    const routing: 'passthrough' | 'execute_code' = rec.passthrough.includes(tool.name)
      ? 'passthrough'
      : 'execute_code';

    annotate(tool.server, tool.name, { routing });
    annotated++;
  }

  return annotated;
}
