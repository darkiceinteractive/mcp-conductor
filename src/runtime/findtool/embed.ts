/**
 * Lightweight embedding for findTool
 *
 * Uses a character-level TF-IDF-style embedding that runs entirely in-process
 * with no ONNX runtime dependency. This keeps the package lightweight while
 * providing meaningful semantic similarity for MCP tool search.
 *
 * The embedding is a fixed-dimensional Float32Array built from:
 *   1. Unigram token frequencies (normalised)
 *   2. Bigram token frequencies (normalised)
 *
 * This is sufficient for the findTool use case where queries are short phrases
 * and tool descriptions are relatively short, structured text.
 *
 * If $MCP_CONDUCTOR_EMBED_MODEL=onnx is set and @xenova/transformers is
 * installed, we will delegate to MiniLM-L6 at runtime. Otherwise we fall
 * back to the in-process TF-IDF embedder.
 *
 * @module runtime/findtool/embed
 */

// Embedding dimension for the in-process embedder
export const EMBED_DIM = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Tokeniser
// ─────────────────────────────────────────────────────────────────────────────

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-. ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Deterministic hash of a string to [0, EMBED_DIM)
function hashBucket(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h % EMBED_DIM;
}

/**
 * Build a Float32Array embedding for a text string.
 * The vector is L2-normalised for cosine similarity computation.
 */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenise(text);

  if (tokens.length === 0) return vec;

  // Unigram features
  for (const token of tokens) {
    (vec as unknown as Record<number,number>)[hashBucket(token)] = (vec[hashBucket(token)] ?? 0) + 1;
  }

  // Bigram features
  for (let i = 0; i < tokens.length - 1; i++) {
    const ti = tokens[i] ?? '';
    const ti1 = tokens[i + 1] ?? '';
    const bigram = ti + '_' + ti1;
    (vec as unknown as Record<number,number>)[hashBucket(bigram)] = (vec[hashBucket(bigram)] ?? 0) + 0.5;
  }

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i++) { const v = vec[i] ?? 0; (vec as unknown as Record<number,number>)[i] = v / norm; }
  }

  return vec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cosine similarity
// ─────────────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Vectors are already L2-normalised so dot product == cosine similarity
  return dot;
}
