#!/usr/bin/env tsx
/**
 * build-articles.ts — Article authoring pipeline (D7a)
 *
 * Reads articles/<slug>/article.md, renders mermaid blocks to SVG via mmdc,
 * converts SVGs to PNG for Medium fallback via sharp, and emits:
 *   dist/article.html         — self-contained HTML, inline SVGs + CSS
 *   dist/article.md           — MD with SVG image references
 *   dist/article.medium.md    — MD with PNG image references (Medium-friendly)
 *   dist/diagrams/diagram-N.svg + diagram-N.png
 *
 * Hand-authored SVGs in svg-source/*.svg are copied to dist/diagrams/ as-is.
 *
 * CLI:
 *   npm run build:articles                         # all articles
 *   npm run build:articles -- --slug=_sample       # one slug only
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(REPO_ROOT, 'articles');
const MMDC = path.join(REPO_ROOT, 'node_modules', '.bin', 'mmdc');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildResult {
  slug: string;
  htmlPath: string;
  mdPath: string;
  mediumMdPath: string;
  diagrams: string[];
}

// ---------------------------------------------------------------------------
// Dependency injection interface (enables fast unit tests via mocks)
// ---------------------------------------------------------------------------

export interface BuildDeps {
  /**
   * Render mermaid source text to SVG at outSvgPath.
   */
  renderMermaid: (mermaidSrc: string, outSvgPath: string) => Promise<void>;

  /**
   * Convert an SVG file to a PNG file at 2x resolution.
   */
  svgToPng: (svgPath: string, pngPath: string) => Promise<void>;
}

/**
 * Real deps: mmdc for mermaid rendering + sharp for SVG→PNG.
 * Loaded lazily so tests can inject mocks without importing the heavy modules.
 */
async function defaultDeps(): Promise<BuildDeps> {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default;

  return {
    async renderMermaid(mermaidSrc: string, outSvgPath: string): Promise<void> {
      const tmpInput = outSvgPath + '.mmd';
      fs.writeFileSync(tmpInput, mermaidSrc, 'utf8');

      const result = spawnSync(
        MMDC,
        ['-i', tmpInput, '-o', outSvgPath, '--backgroundColor', 'white'],
        { encoding: 'utf8', timeout: 60_000 },
      );

      try {
        fs.unlinkSync(tmpInput);
      } catch {
        // non-fatal cleanup
      }

      if (result.error) {
        throw new Error(`mmdc spawn error: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(
          `mmdc exited with code ${result.status}. stderr: ${result.stderr ?? ''}`,
        );
      }
    },

    async svgToPng(svgPath: string, pngPath: string): Promise<void> {
      const svgBuffer = fs.readFileSync(svgPath);
      await sharp(svgBuffer, { density: 192 }) // 192 dpi ≈ 2x standard 96dpi
        .png()
        .toFile(pngPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal CSS for HTML output
// ---------------------------------------------------------------------------

const ARTICLE_CSS = `
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  line-height: 1.7;
  color: #1a1a1a;
  background: #fff;
}
h1, h2, h3, h4 { line-height: 1.3; margin-top: 2rem; }
h1 { font-size: 2rem; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.2rem; }
pre { background: #f6f8fa; border-radius: 6px; padding: 1rem; overflow-x: auto; }
code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9em; }
img, svg { max-width: 100%; height: auto; display: block; margin: 1.5rem auto; }
blockquote { border-left: 4px solid #e0e0e0; margin: 0; padding-left: 1rem; color: #555; }
a { color: #0366d6; }
`.trim();

// ---------------------------------------------------------------------------
// Build a single article
// ---------------------------------------------------------------------------

export async function buildArticle(
  slug: string,
  deps?: BuildDeps,
): Promise<BuildResult> {
  const resolvedDeps = deps ?? (await defaultDeps());

  const slugDir = path.join(ARTICLES_DIR, slug);
  const srcMdPath = path.join(slugDir, 'article.md');
  const distDir = path.join(slugDir, 'dist');
  const diagramsDir = path.join(distDir, 'diagrams');
  const svgSourceDir = path.join(slugDir, 'svg-source');

  if (!fs.existsSync(srcMdPath)) {
    throw new Error(`Article source not found: ${srcMdPath}`);
  }

  fs.mkdirSync(diagramsDir, { recursive: true });

  const md = fs.readFileSync(srcMdPath, 'utf8');

  // -------------------------------------------------------------------------
  // Step 1: Extract and render mermaid blocks
  // -------------------------------------------------------------------------

  const mermaidBlockRe = /```mermaid\n([\s\S]*?)```/g;
  const mermaidBlocks: Array<{ fullMatch: string; src: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = mermaidBlockRe.exec(md)) !== null) {
    mermaidBlocks.push({ fullMatch: match[0], src: match[1] });
  }

  const renderedDiagrams: string[] = [];

  for (let i = 0; i < mermaidBlocks.length; i++) {
    const diagramIndex = i + 1;
    const svgFilename = `diagram-${diagramIndex}.svg`;
    const pngFilename = `diagram-${diagramIndex}.png`;
    const svgPath = path.join(diagramsDir, svgFilename);
    const pngPath = path.join(diagramsDir, pngFilename);

    await resolvedDeps.renderMermaid(mermaidBlocks[i].src, svgPath);
    await resolvedDeps.svgToPng(svgPath, pngPath);

    renderedDiagrams.push(svgFilename);
  }

  // -------------------------------------------------------------------------
  // Step 2: Copy hand-authored SVGs from svg-source/
  // -------------------------------------------------------------------------

  if (fs.existsSync(svgSourceDir)) {
    const svgFiles = fs
      .readdirSync(svgSourceDir)
      .filter((f) => f.endsWith('.svg'));

    for (const svgFile of svgFiles) {
      const srcSvgPath = path.join(svgSourceDir, svgFile);
      const dstSvgPath = path.join(diagramsDir, svgFile);
      const dstPngPath = path.join(diagramsDir, svgFile.replace(/\.svg$/, '.png'));

      fs.copyFileSync(srcSvgPath, dstSvgPath);
      await resolvedDeps.svgToPng(dstSvgPath, dstPngPath);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Rewrite MD — replace mermaid blocks and svg-source refs
  // -------------------------------------------------------------------------

  let diagramCounter = 0;
  let mdWithRefs = md.replace(/```mermaid\n[\s\S]*?```/g, () => {
    diagramCounter++;
    return `![Diagram ${diagramCounter}](diagrams/diagram-${diagramCounter}.svg)`;
  });

  // Rewrite svg-source/ image references to diagrams/
  mdWithRefs = mdWithRefs.replace(
    /!\[([^\]]*)\]\(svg-source\/([^)]+\.svg)\)/g,
    '![$1](diagrams/$2)',
  );

  // -------------------------------------------------------------------------
  // Step 4: Emit dist/article.md (SVG references)
  // -------------------------------------------------------------------------

  const outMdPath = path.join(distDir, 'article.md');
  fs.writeFileSync(outMdPath, mdWithRefs, 'utf8');

  // -------------------------------------------------------------------------
  // Step 5: Emit dist/article.medium.md (PNG references for Medium)
  // -------------------------------------------------------------------------

  const mdForMedium = mdWithRefs.replace(
    /!\[([^\]]*)\]\(diagrams\/([^)]+)\.svg\)/g,
    '![$1](diagrams/$2.png)',
  );
  const outMediumMdPath = path.join(distDir, 'article.medium.md');
  fs.writeFileSync(outMediumMdPath, mdForMedium, 'utf8');

  // -------------------------------------------------------------------------
  // Step 6: Emit dist/article.html — self-contained with inline SVGs + CSS
  // -------------------------------------------------------------------------

  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true });

  const vfile = await processor.process(mdWithRefs);
  let htmlBody = String(vfile);

  // Inline each SVG: replace <img src="diagrams/diagram-N.svg"> with actual <svg>
  htmlBody = htmlBody.replace(
    /<img[^>]*src="diagrams\/([^"]+\.svg)"[^>]*alt="([^"]*)"[^>]*\/?>/g,
    (_imgTag, filename, alt) => {
      const svgPath = path.join(diagramsDir, filename);
      if (fs.existsSync(svgPath)) {
        const svgContent = fs.readFileSync(svgPath, 'utf8');
        const cleanSvg = svgContent
          .replace(/<\?xml[^?]*\?>\s*/g, '')
          .replace(/<!DOCTYPE[^>]*>\s*/g, '');
        return `<figure aria-label="${alt}">${cleanSvg}</figure>`;
      }
      return _imgTag;
    },
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${extractTitle(md)}</title>
  <style>${ARTICLE_CSS}</style>
</head>
<body>
${htmlBody}
</body>
</html>`;

  const outHtmlPath = path.join(distDir, 'article.html');
  fs.writeFileSync(outHtmlPath, html, 'utf8');

  return {
    slug,
    htmlPath: outHtmlPath,
    mdPath: outMdPath,
    mediumMdPath: outMediumMdPath,
    diagrams: renderedDiagrams,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTitle(md: string): string {
  const h1Match = md.match(/^#\s+(.+)$/m);
  return h1Match ? h1Match[1].trim() : 'Article';
}

function discoverSlugs(): string[] {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  return fs
    .readdirSync(ARTICLES_DIR)
    .filter((entry) => {
      const entryPath = path.join(ARTICLES_DIR, entry);
      return (
        fs.statSync(entryPath).isDirectory() &&
        fs.existsSync(path.join(entryPath, 'article.md'))
      );
    });
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const slugArg = process.argv
    .find((a) => a.startsWith('--slug='))
    ?.replace('--slug=', '');

  const slugs = slugArg ? [slugArg] : discoverSlugs();

  if (slugs.length === 0) {
    console.log('No articles found under articles/*/article.md');
    process.exit(0);
  }

  for (const slug of slugs) {
    console.log(`Building article: ${slug}`);
    try {
      const result = await buildArticle(slug);
      console.log(`  HTML:      ${path.relative(REPO_ROOT, result.htmlPath)}`);
      console.log(`  MD:        ${path.relative(REPO_ROOT, result.mdPath)}`);
      console.log(`  Medium MD: ${path.relative(REPO_ROOT, result.mediumMdPath)}`);
      console.log(`  Diagrams:  ${result.diagrams.length} mermaid diagram(s)`);
    } catch (err) {
      console.error(`  ERROR building ${slug}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
