# Deploying docs.darkice.co (Cloudflare Pages)

## One-time setup

### 1. Connect the repository to Cloudflare Pages

1. Open **Cloudflare Dashboard** → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Authorise Cloudflare to access the `darkiceinteractive` GitHub organisation
3. Select repository: `darkiceinteractive/mcp-conductor`
4. Configure the build:

   | Setting | Value |
   |---------|-------|
   | Project name | `mcp-conductor-docs` |
   | Production branch | `main` |
   | Build command | `cd docs-site && npm ci && npm run build` |
   | Build output directory | `docs-site/build` |
   | Root directory | `/` (default — leave blank) |

5. Click **Save and Deploy**. The first deploy runs immediately.

### 2. Add the custom domain

1. Cloudflare Pages project → **Custom domains** → **Set up a custom domain**
2. Enter: `docs.darkice.co`
3. Cloudflare detects that `darkice.co` is already on Cloudflare DNS and auto-configures a CNAME:
   - Record: `docs` CNAME → `mcp-conductor-docs.pages.dev`
4. SSL certificate is provisioned automatically (allow 1–2 minutes)
5. Visit `https://docs.darkice.co` to confirm

### 3. Environment variables

No environment variables are required for the current build. If future builds need them, add them under **Settings → Environment variables** in the Pages project.

### 4. Branch previews

Cloudflare Pages automatically creates a unique preview URL for every pull request:

```
https://<commit-hash>.mcp-conductor-docs.pages.dev
```

To surface this in PRs, add the following to your PR description template:

```
Docs preview: https://<commit-hash>.mcp-conductor-docs.pages.dev
```

The Cloudflare GitHub App posts a deployment status check to each PR with the live preview URL.

---

## Local build (works now — no Cloudflare account needed)

```bash
cd docs-site
npm ci
npm run build        # outputs to docs-site/build/ (gitignored)
npm run serve        # preview the production build locally at http://localhost:3000
```

---

## CI build

The workflow `.github/workflows/docs-build.yml` runs on every push to `feature/v3.1` and `docs/v3.1-*` branches, and on every PR targeting `feature/v3.1` or `main`. It catches build breakage before merge.

---

## Verifying the deployment

After setup:

| Check | Expected |
|-------|----------|
| `https://docs.darkice.co` | Serves the latest `main` build |
| `https://docs.darkice.co/v2/intro` | v2.0 alpha placeholder page |
| Version dropdown in navbar | Shows "v3 (latest)" and "v2.0 (alpha)" |
| PR preview URL | Unique `*.pages.dev` URL in each PR's Cloudflare check |

---

## Troubleshooting

### Build failures

Cloudflare Pages → **Deployments** → click the failed deployment → **View build log**

Common causes:
- Node version mismatch: set `NODE_VERSION=20` in environment variables
- Missing `package-lock.json` in `docs-site/`: run `npm install` locally and commit it
- Broken MDX: check for unclosed JSX tags or missing imports in `.mdx` files

### DNS issues

Cloudflare Dashboard → **DNS** → verify the `docs` CNAME record exists pointing to `mcp-conductor-docs.pages.dev`.

If the CNAME is missing, add it manually:
- Type: `CNAME`
- Name: `docs`
- Target: `mcp-conductor-docs.pages.dev`
- Proxy status: Proxied (orange cloud)

### SSL issues

Cloudflare Pages → **Custom domains** → click `docs.darkice.co` → **Re-issue certificate**

Allow up to 5 minutes for propagation.

### Version selector not appearing

Ensure `versions.json` exists at `docs-site/versions.json` with `["2.0"]` and that `docusaurus.config.ts` has the `versions` block configured. Run `npm run build` locally to confirm no build errors.
