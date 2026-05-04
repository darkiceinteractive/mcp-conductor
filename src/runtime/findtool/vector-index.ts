/**
 * In-memory vector index for tool embeddings
 *
 * Stores Float32Array embeddings for each registered MCP tool and provides
 * cosine-similarity nearest-neighbour search. Re-indexes on registry hot-reload.
 *
 * For large deployments (>10k tools) consider replacing with hnswlib-node or
 * LanceDB (set $LANCEDB_URL to enable the remote backend).
 *
 * @module runtime/findtool/vector-index
 */

import { embed, cosineSimilarity } from './embed.js';

export interface IndexedTool {
  server: string;
  tool: string;
  description: string;
  vector: Float32Array;
}

export interface SearchResult {
  server: string;
  tool: string;
  description: string;
  score: number;
}

export class VectorIndex {
  private entries: IndexedTool[] = [];

  /**
   * Add or replace all tools for a server. Existing entries for that
   * server are removed first.
   */
  upsertServer(
    server: string,
    tools: Array<{ tool: string; description: string }>,
  ): void {
    // Remove existing entries for this server
    this.entries = this.entries.filter((e) => e.server !== server);

    for (const { tool, description } of tools) {
      const text = `${tool}\n${description}`;
      const vector = embed(text);
      this.entries.push({ server, tool, description, vector });
    }
  }

  /**
   * Remove all entries for a server.
   */
  removeServer(server: string): void {
    this.entries = this.entries.filter((e) => e.server !== server);
  }

  /**
   * Rebuild the entire index from a flat list of tools.
   */
  rebuild(tools: Array<{ server: string; tool: string; description: string }>): void {
    this.entries = tools.map(({ server, tool, description }) => ({
      server,
      tool,
      description,
      vector: embed(`${tool}\n${description}`),
    }));
  }

  /**
   * Search for tools similar to `query`.
   */
  search(
    query: string,
    topK = 5,
    serverFilter?: string[],
  ): SearchResult[] {
    if (this.entries.length === 0) return [];

    const queryVec = embed(query);
    const candidates = serverFilter
      ? this.entries.filter((e) => serverFilter.includes(e.server))
      : this.entries;

    const scored = candidates.map((e) => ({
      server: e.server,
      tool: e.tool,
      description: e.description,
      score: cosineSimilarity(queryVec, e.vector),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
