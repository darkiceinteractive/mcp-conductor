import { describe, it, expect } from 'vitest';
import { embed, cosineSimilarity, EMBED_DIM } from '../../../../src/runtime/findtool/embed.js';

describe('embed', () => {
  it('returns a Float32Array of correct dimension', () => {
    const vec = embed('list github issues');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBED_DIM);
  });

  it('returns a zero vector for empty string', () => {
    const vec = embed('');
    const norm = Array.from(vec).reduce((s, v) => s + v * v, 0);
    expect(norm).toBeCloseTo(0);
  });

  it('produces L2-normalised vectors for non-empty text', () => {
    const vec = embed('hello world');
    const norm = Array.from(vec).reduce((s, v) => s + v * v, 0);
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('similar texts have higher cosine similarity than dissimilar texts', () => {
    const a = embed('list github issues pull requests');
    const b = embed('list github issues');
    const c = embed('send slack message notification');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it('identical texts produce cosine similarity of 1', () => {
    const text = 'create a github pull request';
    const a = embed(text);
    const b = embed(text);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});
