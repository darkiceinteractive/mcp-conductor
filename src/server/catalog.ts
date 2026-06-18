/**
 * Catalog Presence Layer — heuristic server/tool summarisation.
 *
 * Generates concise text descriptions of backend servers and their tools
 * using only string analysis (no model calls, no external dependencies).
 *
 * Exported functions:
 *   buildServerSummary          — one ServerCatalogEntry for a single server
 *   buildCatalogInstructions    — budget-capped catalog for the handshake `instructions` field
 *   buildServerCatalogDetail    — full per-server markdown (used for catalog resources)
 */

export interface ServerCatalogEntry {
  name: string;
  toolCount: number;
  /** One-line summary, ≈25 tokens */
  summary: string;
  /** Up to 5 representative tool names */
  topTools: string[];
  status: 'connected' | 'connecting' | 'failed';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Common leading verb prefixes to strip/cluster. Ordered longest-first. */
const VERB_PREFIXES: string[] = [
  'calculate_',
  'preview_',
  'create_',
  'delete_',
  'remove_',
  'update_',
  'search_',
  'filter_',
  'stream_',
  'cancel_',
  'submit_',
  'export_',
  'import_',
  'upload_',
  'download_',
  'fetch_',
  'query_',
  'place_',
  'send_',
  'list_',
  'find_',
  'scan_',
  'get_',
  'set_',
  'run_',
  'add_',
];

/** Verbs whose tools suggest write/destructive intent */
const WRITE_VERBS = new Set(['create', 'delete', 'remove', 'update', 'place', 'send', 'submit', 'add', 'upload', 'import']);
/** Verbs whose tools are read-heavy */
const READ_VERBS = new Set(['get', 'list', 'find', 'search', 'fetch', 'query', 'scan', 'stream', 'filter', 'download', 'export']);

/**
 * Extract leading verb from a tool name.
 * Returns the matched verb (without trailing underscore) or '' if none found.
 */
function extractVerb(toolName: string): string {
  const lower = toolName.toLowerCase();
  for (const prefix of VERB_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return prefix.slice(0, -1); // strip trailing underscore
    }
  }
  return '';
}

/**
 * Strip leading verb prefix from a tool name.
 */
function stripVerb(toolName: string): string {
  const lower = toolName.toLowerCase();
  for (const prefix of VERB_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

/**
 * Convert a snake_case identifier into a human-readable phrase.
 * "options_chain" → "options chain", "account_summary" → "account summary"
 */
function humanize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract domain nouns from a cluster of tool names (all share the same verb).
 * Returns up to 3 representative noun phrases.
 */
function extractDomainNouns(toolNames: string[]): string[] {
  // Strip verbs, deduplicate prefixes, take the most generic (shortest)
  const stripped = toolNames.map(stripVerb);

  // Group by first word to find family clusters
  const firstWordGroups: Map<string, string[]> = new Map();
  for (const n of stripped) {
    const firstWord = n.split('_')[0];
    if (firstWord) {
      const group = firstWordGroups.get(firstWord) ?? [];
      group.push(n);
      firstWordGroups.set(firstWord, group);
    }
  }

  // Pick representative: smallest name per group
  const representatives: string[] = [];
  for (const [, names] of firstWordGroups) {
    const shortest = names.reduce((a, b) => (a.length <= b.length ? a : b));
    representatives.push(humanize(shortest));
  }

  // Sort by length (shorter = more generic) and return up to 3
  return representatives
    .sort((a, b) => a.length - b.length)
    .slice(0, 3)
    .filter((n) => n.length > 0);
}

/**
 * Token estimate: chars / 4 (conservative heuristic).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a {@link ServerCatalogEntry} for one backend server.
 *
 * Uses heuristic verb-clustering to produce a concise one-line summary and
 * select up to 5 representative tool names. No model calls, no I/O.
 */
export function buildServerSummary(
  name: string,
  tools: Array<{ name: string; description?: string }>,
  status: ServerCatalogEntry['status'] = 'connected',
): ServerCatalogEntry {
  const toolCount = tools.length;

  if (toolCount === 0) {
    return {
      name,
      toolCount: 0,
      summary: `${name} (0 tools): no tools available`,
      topTools: [],
      status,
    };
  }

  // ── Step 1: cluster by leading verb ──────────────────────────────────────
  const clustersByVerb: Map<string, string[]> = new Map();
  const verbless: string[] = [];

  for (const t of tools) {
    const verb = extractVerb(t.name);
    if (verb) {
      const cluster = clustersByVerb.get(verb) ?? [];
      cluster.push(t.name);
      clustersByVerb.set(verb, cluster);
    } else {
      verbless.push(t.name);
    }
  }

  // Sort clusters by size (largest first) to find the dominant patterns
  const sortedClusters = Array.from(clustersByVerb.entries()).sort((a, b) => b[1].length - a[1].length);

  // ── Step 2: extract domain nouns from 2–3 largest clusters ───────────────
  const topClusters = sortedClusters.slice(0, 3);
  const domainNounPhrases: string[] = [];
  for (const [, clusterTools] of topClusters) {
    const nouns = extractDomainNouns(clusterTools);
    for (const noun of nouns) {
      if (!domainNounPhrases.includes(noun)) {
        domainNounPhrases.push(noun);
      }
    }
  }

  const nounPhrase = domainNounPhrases.slice(0, 4).join(', ') || 'various capabilities';

  // ── Step 3: verb profile ─────────────────────────────────────────────────
  let readCount = 0;
  let writeCount = 0;
  for (const [verb] of clustersByVerb) {
    const size = clustersByVerb.get(verb)?.length ?? 0;
    if (READ_VERBS.has(verb)) readCount += size;
    if (WRITE_VERBS.has(verb)) writeCount += size;
  }

  let verbProfile: string;
  if (readCount === 0 && writeCount === 0) {
    verbProfile = 'mixed operations';
  } else if (writeCount === 0 || readCount / Math.max(writeCount, 1) > 4) {
    verbProfile = 'read-heavy';
  } else if (readCount === 0 || writeCount / Math.max(readCount, 1) > 4) {
    verbProfile = 'write-heavy';
  } else {
    // Find if there's a dominant action (e.g. "preview" is common for trading)
    const previewCount = clustersByVerb.get('preview')?.length ?? 0;
    const calcCount = clustersByVerb.get('calculate')?.length ?? 0;
    if (previewCount > 0 && writeCount > 0) {
      verbProfile = 'read-heavy + order preview';
    } else if (calcCount > readCount / 3) {
      verbProfile = 'read + calculate';
    } else {
      verbProfile = 'read + write';
    }
  }

  // ── Step 4: pick top 5 tools ─────────────────────────────────────────────
  // Select by: (a) one per major verb cluster, (b) prefer shorter/more-generic names
  const topToolNames: string[] = [];
  const usedVerbs = new Set<string>();

  // Pass 1: one per verb cluster (largest clusters first)
  for (const [verb, clusterTools] of sortedClusters) {
    if (topToolNames.length >= 5) break;
    if (usedVerbs.has(verb)) continue;
    usedVerbs.add(verb);

    // Prefer shortest name (most generic)
    const best = clusterTools.reduce((a, b) => (a.length <= b.length ? a : b));
    topToolNames.push(best);
  }

  // Pass 2: fill remaining slots from verbless tools or next-best cluster tools
  for (const t of verbless) {
    if (topToolNames.length >= 5) break;
    if (!topToolNames.includes(t)) {
      topToolNames.push(t);
    }
  }

  // Pass 3: if still short, add from first cluster (variety)
  for (const [, clusterTools] of sortedClusters) {
    for (const t of clusterTools) {
      if (topToolNames.length >= 5) break;
      if (!topToolNames.includes(t)) {
        topToolNames.push(t);
      }
    }
    if (topToolNames.length >= 5) break;
  }

  // ── Step 5: assemble summary ─────────────────────────────────────────────
  const summary = `${name} (${toolCount} tools): ${nounPhrase} — ${verbProfile}`;

  return {
    name,
    toolCount,
    summary,
    topTools: topToolNames,
    status,
  };
}

/**
 * Build the handshake `instructions` string for the MCP initialize response.
 *
 * Renders a compact catalog of all backend servers, budget-capped to
 * `budgetTokens` (default 1200). When over budget, first drops the
 * "e.g. ..." tool lists, then collapses smallest servers into "+N more".
 */
export function buildCatalogInstructions(
  entries: ServerCatalogEntry[],
  budgetTokens: number = 1200,
): string {
  const connectedEntries = entries.filter((e) => e.status === 'connected' || e.status === 'connecting');
  const failedEntries = entries.filter((e) => e.status === 'failed');

  const totalServers = entries.length;
  const totalTools = entries.reduce((sum, e) => sum + e.toolCount, 0);

  // Header — always included
  const header =
    `mcp-conductor proxies ${totalServers} backend MCP server${totalServers !== 1 ? 's' : ''} (${totalTools} tools total). ` +
    `Their schemas stay out of context to save tokens. ` +
    `To use any of them: call discover_tools to find a tool, then execute_code to invoke it via mcp.server('<name>').call('<tool>', args). Catalog:`;

  const footer = `\nFull per-server detail: read resource conductor://catalog or call list_servers.`;

  const failedNote =
    failedEntries.length > 0
      ? `\n(${failedEntries.length} server${failedEntries.length !== 1 ? 's' : ''} failed to connect: ${failedEntries.map((e) => e.name).join(', ')})`
      : '';

  if (connectedEntries.length === 0) {
    const base = `${header}\n(no servers connected yet)${failedNote}${footer}`;
    return base;
  }

  // ── Pass A: render with e.g. tool lists ────────────────────────────────
  const renderLineWithTools = (entry: ServerCatalogEntry): string => {
    const tools = entry.topTools.length > 0 ? ` — e.g. ${entry.topTools.slice(0, 5).join(', ')}` : '';
    return `- ${entry.summary}${tools}`;
  };

  const renderLineNoTools = (entry: ServerCatalogEntry): string => {
    return `- ${entry.summary}`;
  };

  const tryRender = (
    lines: string[],
    withTools: boolean,
    collapsed: number,
  ): string => {
    const catalogLines = lines.join('\n');
    const collapsedNote = collapsed > 0 ? `\n- +${collapsed} more servers — use list_servers` : '';
    return `${header}\n${catalogLines}${collapsedNote}${failedNote}${footer}`;
  };

  // Attempt full render with tool lists
  const fullLinesWithTools = connectedEntries.map(renderLineWithTools);
  const fullWithTools = tryRender(fullLinesWithTools, true, 0);

  if (estimateTokens(fullWithTools) <= budgetTokens) {
    return fullWithTools;
  }

  // Drop tool lists
  const fullLinesNoTools = connectedEntries.map(renderLineNoTools);
  const fullNoTools = tryRender(fullLinesNoTools, false, 0);

  if (estimateTokens(fullNoTools) <= budgetTokens) {
    return fullNoTools;
  }

  // Collapse smallest servers until we fit — sort by toolCount desc (keep largest)
  const sorted = [...connectedEntries].sort((a, b) => b.toolCount - a.toolCount);
  let collapsed = 0;

  for (let keep = sorted.length; keep >= 1; keep--) {
    collapsed = sorted.length - keep;
    const keptLines = sorted.slice(0, keep).map(renderLineNoTools);
    const attempt = tryRender(keptLines, false, collapsed);
    if (estimateTokens(attempt) <= budgetTokens || keep === 1) {
      return attempt;
    }
  }

  // Absolute fallback — just the header with count info
  return `${header}\n- (${connectedEntries.length} servers — use list_servers for details)${failedNote}${footer}`;
}

/**
 * Build full per-server detail markdown.
 *
 * Returns a markdown string with one line per tool: `- **name** — description_first_sentence`.
 * Used for the `conductor://catalog/{server}` resource.
 */
export function buildServerCatalogDetail(
  name: string,
  tools: Array<{ name: string; description?: string }>,
): string {
  if (tools.length === 0) {
    return `## ${name}\n\n_No tools available._\n`;
  }

  const lines = tools.map((t) => {
    const firstSentence = (t.description ?? '')
      .split(/[.!?](\s|$)/)[0]
      ?.trim() ?? '';
    const desc = firstSentence.length > 0 ? ` — ${firstSentence}` : '';
    return `- **${t.name}**${desc}`;
  });

  return `## ${name} (${tools.length} tools)\n\n${lines.join('\n')}\n`;
}
