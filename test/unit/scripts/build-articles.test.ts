/**
 * test/unit/scripts/build-articles.test.ts
 *
 * Unit tests for the article authoring pipeline (D7a).
 * Mocks renderMermaid and svgToPng so tests are fast and hermetic —
 * no Chromium, no native sharp binaries required.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildArticle } from '../../../scripts/build-articles.js';
import type { BuildDeps } from '../../../scripts/build-articles.js';

// ---------------------------------------------------------------------------
// Fixture setup: a temporary articles directory with a test slug
// ---------------------------------------------------------------------------

const FIXTURE_SLUG = '_test_fixture';
let fixtureArticlesDir: string;
let slugDir: string;

/** Minimal but realistic mermaid SVG output from mmdc */
const FAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#eef"/><text x="10" y="30">Test diagram</text></svg>`;

/** Minimal PNG magic bytes (just need a non-empty file for path checks) */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Mock deps: no mmdc, no sharp — just write synthetic files to the paths.
 */
const mockDeps: BuildDeps = {
  async renderMermaid(_src: string, outSvgPath: string): Promise<void> {
    fs.writeFileSync(outSvgPath, FAKE_SVG, 'utf8');
  },
  async svgToPng(_svgPath: string, pngPath: string): Promise<void> {
    fs.writeFileSync(pngPath, FAKE_PNG);
  },
};

beforeAll(() => {
  // Create a temp directory that acts as the articles/ root for this test
  fixtureArticlesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-article-test-'));

  // Patch the articles dir lookup: buildArticle resolves slugs relative to
  // the repo root. We monkey-patch by creating a nested structure under the
  // real articles/ directory so the path resolution works without env hacks.
  //
  // Simpler: create the fixture inside the real articles/ dir (will be cleaned up).
  const repoRoot = path.resolve(__dirname, '../../../');
  slugDir = path.join(repoRoot, 'articles', FIXTURE_SLUG);

  fs.mkdirSync(path.join(slugDir, 'svg-source'), { recursive: true });

  // article.md with one mermaid block and one svg-source reference
  const articleMd = [
    '# Test Article',
    '',
    'Some introductory text about MCP Conductor.',
    '',
    '```mermaid',
    'flowchart LR',
    '    A[Start] --> B[End]',
    '```',
    '',
    'And a hand-authored diagram:',
    '',
    '![Hand diagram](svg-source/hand.svg)',
    '',
    'Final paragraph.',
  ].join('\n');

  fs.writeFileSync(path.join(slugDir, 'article.md'), articleMd, 'utf8');

  // A simple hand-authored SVG
  fs.writeFileSync(
    path.join(slugDir, 'svg-source', 'hand.svg'),
    FAKE_SVG,
    'utf8',
  );
});

afterAll(() => {
  // Remove the fixture directory
  fs.rmSync(slugDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildArticle', () => {
  let distDir: string;

  beforeAll(async () => {
    // Run the pipeline once; all tests inspect the output
    const result = await buildArticle(FIXTURE_SLUG, mockDeps);
    distDir = path.join(path.dirname(result.htmlPath));
  });

  it('emits dist/article.html', () => {
    const htmlPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'article.html',
    );
    expect(fs.existsSync(htmlPath)).toBe(true);
  });

  it('emits dist/article.md', () => {
    const mdPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'article.md',
    );
    expect(fs.existsSync(mdPath)).toBe(true);
  });

  it('emits dist/article.medium.md with PNG references', () => {
    const medPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'article.medium.md',
    );
    expect(fs.existsSync(medPath)).toBe(true);

    const content = fs.readFileSync(medPath, 'utf8');
    expect(content).toContain('diagrams/diagram-1.png');
  });

  it('emits dist/diagrams/diagram-1.svg', () => {
    const svgPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'diagrams',
      'diagram-1.svg',
    );
    expect(fs.existsSync(svgPath)).toBe(true);
  });

  it('HTML output contains inline SVG content (<svg)', () => {
    const htmlPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'article.html',
    );
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('<svg');
  });

  it('Medium MD references diagrams/diagram-1.png not .svg', () => {
    const medPath = path.join(
      path.resolve(__dirname, '../../../'),
      'articles',
      FIXTURE_SLUG,
      'dist',
      'article.medium.md',
    );
    const content = fs.readFileSync(medPath, 'utf8');
    // PNG reference present
    expect(content).toContain('diagram-1.png');
    // No raw mermaid fences in output
    expect(content).not.toContain('```mermaid');
  });
});
