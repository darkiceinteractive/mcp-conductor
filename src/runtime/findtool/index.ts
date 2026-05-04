/**
 * findTool — semantic tool discovery
 *
 * Provides `findTool(query, options)` for sandbox code. Lazily initialises
 * the vector index on first call and re-indexes whenever the registry
 * publishes a hot-reload event.
 *
 * @module runtime/findtool
 */

import { VectorIndex } from './vector-index.js';
export type { SearchResult } from './vector-index.js';
export { embed, cosineSimilarity, EMBED_DIM } from './embed.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface FindToolOptions {
  /** Number of results to return (default: 5) */
  topK?: number;
  /** Restrict search to these servers */
  serverFilter?: string[];
}

export interface ToolEntry {
  server: string;
  tool: string;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton index
// ─────────────────────────────────────────────────────────────────────────────

let _index: VectorIndex | null = null;
let _initialised = false;
let _toolLoader: (() => Promise<ToolEntry[]>) | null = null;

function getIndex(): VectorIndex {
  if (!_index) {
    _index = new VectorIndex();
  }
  return _index;
}

/**
 * Register a tool loader callback. Called during system startup so the
 * findTool module can lazily pull tool definitions from the registry.
 */
export function registerToolLoader(loader: () => Promise<ToolEntry[]>): void {
  _toolLoader = loader;
  _initialised = false; // force re-init on next search
}

/**
 * Immediately re-index all tools. Call this when the registry hot-reloads.
 */
export async function reindex(): Promise<void> {
  if (!_toolLoader) return;
  const tools = await _toolLoader();
  getIndex().rebuild(tools);
  _initialised = true;
}

async function ensureInitialised(): Promise<void> {
  if (_initialised) return;
  if (_toolLoader) {
    await reindex();
  }
  _initialised = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find MCP tools semantically similar to `query`.
 *
 * @example
 * const tools = await findTool('list github issues', { topK: 3 });
 */
export async function findTool(
  query: string,
  options: FindToolOptions = {},
): Promise<Array<{ server: string; tool: string; description: string; score: number }>> {
  await ensureInitialised();
  return getIndex().search(query, options.topK ?? 5, options.serverFilter);
}

/**
 * Seed the index directly (used in tests and worker bootstrap).
 */
export function seedIndex(tools: ToolEntry[]): void {
  getIndex().rebuild(tools);
  _initialised = true;
}

/**
 * Reset state (tests only).
 */
export function resetFindTool(): void {
  _index = null;
  _initialised = false;
  _toolLoader = null;
}
