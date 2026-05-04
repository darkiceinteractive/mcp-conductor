# Docs Deployment (Cloudflare Pages)

The `docs-site/` Docusaurus site is scaffolded and builds locally. Full
deployment to Cloudflare Pages and custom-domain wiring are handled in
follow-up blocks:

- **D4** — Cloudflare Pages project creation, `docs.darkice.co` custom domain,
  DNS records, and the Pages build preset (`npm ci && npm run build`,
  output dir `build`).
- **D3** — Docusaurus versioning (`docusaurus docs:version`) wired once stable
  content exists.

## Local build (works now)

```bash
cd docs-site
npm ci
npm run build        # outputs to docs-site/build/ (gitignored)
npm run serve        # preview the production build locally
```

## CI build

The workflow `.github/workflows/docs-build.yml` runs `npm ci && npm run build`
on every PR and push to `feature/v3.1`, catching breakage early.

## What D4 will add

1. `wrangler pages project create mcp-conductor-docs`
2. Cloudflare Pages build settings: build command `npm ci && npm run build`,
   output directory `build`, root directory `docs-site`.
3. Custom domain `docs.darkice.co` with CNAME to Pages deployment URL.
4. Production branch set to `main`; preview branches enabled for PRs.
