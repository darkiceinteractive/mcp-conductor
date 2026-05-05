# Real-MCP Nightly Benchmark — Setup Walkthrough

**Audience**: maintainer setting up the GitHub Actions nightly workflow for the first time.
**Output**: nightly run that connects to 10 real popular MCP servers, exercises functional + token-savings tests, and uploads JSON artifacts comparing **code-execution mode** (sandboxed) vs **passthrough direct calls** (no sandbox).
**Schedule**: 02:00 UTC daily. Workflow file: `.github/workflows/nightly.yml`.

---

## TL;DR — what you need

| MCP server | Secret name | Where to get it | Free? |
|---|---|---|---|
| GitHub | `GH_TOKEN_FOR_LIVE_TESTS` | https://github.com/settings/tokens (classic) — `read:user`, `repo` (read-only) scopes | yes |
| Google (Drive + Calendar + Gmail) | `GOOGLE_OAUTH_CREDS` | OAuth JSON from a throwaway Google account, base64-encoded | yes |
| Brave Search | `BRAVE_API_KEY` | https://brave.com/search/api/ (free tier: 2k queries/month) | yes |
| Slack | `SLACK_BOT_TOKEN` | https://api.slack.com/apps → create app → Bot scopes: `channels:read`, `search:read` | yes |
| Notion | `NOTION_TOKEN` | https://www.notion.so/my-integrations → new integration, read-only | yes |
| Linear | `LINEAR_API_KEY` | https://linear.app/settings/api → personal API key | yes |
| Filesystem | (none) | Tests use a temp dir — no creds needed | yes |
| Memory | (none) | In-process MCP — no creds needed | yes |

Total time to set up: **~30 min** if you already have accounts on Slack/Notion/Linear; **~60 min** if making fresh test accounts.

---

## Step 1 — Create dedicated test accounts (recommended)

Don't use your personal accounts. The nightly suite reads + occasionally writes test artifacts (e.g. a Linear test issue, a Notion test page). Make a throwaway test workspace per service so the noise doesn't pollute real data.

- **Google**: create a fresh `mcp-conductor-test@gmail.com` account; populate ~10 emails, ~5 calendar events, ~5 Drive files for the suite to find.
- **Slack**: create a free workspace `mcp-conductor-test`; add 2-3 channels with sample messages.
- **Notion**: create a fresh workspace `mcp-conductor-test`; add 3-5 pages with varied content.
- **Linear**: free tier supports a personal workspace; create issues `MCT-1` through `MCT-5` for the suite.
- **GitHub**: a personal token on your existing account is fine (read-only scopes).
- **Brave**: free tier API key on your real account is fine (read-only).

---

## Step 2 — Get each credential

### GitHub (`GH_TOKEN_FOR_LIVE_TESTS`)

```bash
# Browser: https://github.com/settings/tokens?type=beta (or classic)
# Scopes for classic token:
#   - read:user
#   - repo (read-only)
# Copy the token (ghp_...)
```

### Google (`GOOGLE_OAUTH_CREDS`)

The Google MCP servers (Drive/Gmail/Calendar) take an OAuth credential JSON. Easiest path:

```bash
# 1. Go to https://console.cloud.google.com/
# 2. Create new project "mcp-conductor-test"
# 3. APIs & Services → Library → enable: Drive API, Gmail API, Calendar API
# 4. APIs & Services → Credentials → Create OAuth client ID → Desktop app
# 5. Download JSON (looks like client_secret_xxx.json)
# 6. Run a one-off OAuth flow on your laptop to mint refresh tokens:
npx @modelcontextprotocol/server-gdrive auth
# 7. This produces ~/.gdrive-credentials.json with access + refresh tokens
# 8. Base64-encode it for GitHub Actions:
cat ~/.gdrive-credentials.json | base64 | pbcopy
# 9. Paste as the GOOGLE_OAUTH_CREDS secret value
```

### Brave Search (`BRAVE_API_KEY`)

```bash
# Browser: https://brave.com/search/api/
# Sign up → "Free" plan → copy API key (starts with BSA...)
```

### Slack (`SLACK_BOT_TOKEN`)

```bash
# Browser: https://api.slack.com/apps → Create New App → From scratch
# Name: "mcp-conductor-test"
# Workspace: pick your test workspace
# OAuth & Permissions → Bot Token Scopes → add:
#   - channels:read
#   - search:read
#   - users:read
# Install to workspace → copy "Bot User OAuth Token" (starts with xoxb-)
```

### Notion (`NOTION_TOKEN`)

```bash
# Browser: https://www.notion.so/my-integrations
# New integration → name "mcp-conductor-test" → workspace = test workspace
# Capabilities: Read content (read-only is enough)
# Copy "Internal Integration Token" (starts with secret_)
# IMPORTANT: also share at least one page with the integration so it has access
```

### Linear (`LINEAR_API_KEY`)

```bash
# Browser: https://linear.app/settings/api
# Personal API keys → Create new → name "mcp-conductor-nightly"
# Copy key (starts with lin_api_)
```

---

## Step 3 — Add secrets to GitHub repo

```bash
# From the repo root:
gh secret set GH_TOKEN_FOR_LIVE_TESTS --body "ghp_xxx..."
gh secret set GOOGLE_OAUTH_CREDS --body "$(cat ~/.gdrive-credentials.json | base64)"
gh secret set BRAVE_API_KEY --body "BSA-xxx..."
gh secret set SLACK_BOT_TOKEN --body "xoxb-xxx..."
gh secret set NOTION_TOKEN --body "secret_xxx..."
gh secret set LINEAR_API_KEY --body "lin_api_xxx..."

# Verify:
gh secret list
```

---

## Step 4 — Trigger the workflow manually (smoke test)

```bash
# Run nightly on demand:
gh workflow run nightly.yml --ref main

# Watch the run:
gh run watch
```

Each job's behaviour:

| Job | Purpose | Expected duration |
|---|---|---|
| `memory-soak` | T2 memory leak suite at full iteration counts (10k calls, 100k cache writes) | ~30 min |
| `real-api-popular-mcps` | T4 functional + T5 token-savings against 10 live MCPs | ~20-40 min |
| `security-fuzz` | T3 security vectors — auth fuzz, CORS, ReDoS, path traversal | ~15 min |
| `stress-tests` | S+P+R+D heavy variants behind `STRESS=1` | ~60 min |

If a job needs a missing secret it will fail with `Error: secret X not set` — add the secret and re-run.

---

## Step 5 — Read the benchmark output

After a successful run:

```bash
# Download artifacts from the run:
gh run download <run-id>
```

You'll get:

- `docs/benchmarks/popular-mcps/<server>-<date>.json` — per-server token savings
- `docs/benchmarks/perf/*.json` — perf curves (cold-start, warm-call, etc.)
- `docs/benchmarks/stress/*.json` — stress curves (concurrency, RPS, payload scaling)

The token-savings JSON shape:

```json
{
  "server": "github",
  "tool": "list_repos",
  "date": "2026-05-05T02:14:33Z",
  "passthrough": {
    "responseBytes": 18432,
    "estimatedTokens": 4763
  },
  "execution": {
    "responseBytes": 240,
    "actualTokens": 88
  },
  "savingsPercent": 98.15,
  "category": "listing",
  "categoryFloor": 95
}
```

The CI gate fails if `savingsPercent < categoryFloor` for any tool. Floors per category:

| Category | Floor |
|---|---|
| listing (lists items) | 95% |
| detail (fetch single object) | 70% |
| read-content (file/page body) | 90% |
| search (search results) | 92% |

---

## Step 6 — Local benchmark run (optional)

To validate before the nightly:

```bash
# Set env vars in your shell:
export LIVE_TESTS=1
export GH_TOKEN_FOR_LIVE_TESTS="ghp_..."
export BRAVE_API_KEY="BSA-..."
# ... etc

# Run only the cheap ones first:
npm test -- test/popular-mcps/github/live.test.ts
npm test -- test/popular-mcps/brave-search/live.test.ts

# Or full token-savings benchmark (writes to docs/benchmarks/popular-mcps/):
npm run benchmark:token-savings
```

---

## Step 7 — Comparing code-execution vs passthrough

The `benchmark:token-savings` script runs **each tool twice**:

1. **Passthrough mode**: tool exposed as a first-class MCP tool, response goes straight back to Claude (no sandbox).
2. **Code-execution mode**: same tool called from inside the sandbox via `mcp.<server>.<tool>(args)`; response transformed by user-provided JS, only the digest goes back to Claude.

The JSON artifact lets you see per-tool which mode wins. Heuristic baked into the suite (and surfaced via `mcp-conductor recommend-routing`):

| Avg response size | Recommended routing |
|---|---|
| < 1 KB | `passthrough` (tool-call overhead dominates) |
| 1–10 KB | depends on whether you summarise (try both) |
| > 10 KB | `execute_code` (transformation savings dominate) |

The benchmark suite produces `docs/benchmarks/recommendations-<date>.json`:

```json
{
  "github.list_repos": {
    "passthrough_tokens": 4763,
    "execution_tokens": 88,
    "winner": "execute_code",
    "savings": "98.15%"
  },
  "github.get_user": {
    "passthrough_tokens": 312,
    "execution_tokens": 295,
    "winner": "passthrough",
    "savings": "5.4%"
  }
}
```

Push these recommendations into your `~/.mcp-conductor.json` via:

```bash
mcp-conductor recommend-routing --apply
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Job fails with `Error: secret X not set` | Forgot to add a secret | `gh secret set X --body "..."` |
| Google tests fail with `invalid_grant` | OAuth refresh token expired | Re-run `npx @modelcontextprotocol/server-gdrive auth` and update `GOOGLE_OAUTH_CREDS` |
| Slack test fails with `not_in_channel` | Bot not invited to the channel it's searching | In Slack: `/invite @mcp-conductor-test` in the channel |
| Notion test fails with `object_not_found` | Integration not shared with the page | Open the page → Connections → add the integration |
| Linear test fails with `AuthenticationError` | Wrong API key prefix (use personal not OAuth) | Regenerate at https://linear.app/settings/api |
| Token-savings gate fails for one tool | Real-world response size diverged from the recorded fixture | Re-record: `npm run record:fixtures -- <server>` |

---

## What changes in v3.2

- **C1** — passthrough tools will carry upstream MCP annotations (`readOnlyHint`, `destructiveHint`, etc.) directly from the source server, replacing the v3.1 name-pattern heuristic. The nightly already exercises this via the live tests; failures will surface as annotation mismatches.
- **C4** — if v3.1 nightly metrics show TF-IDF `findTool` top-3 hit rate < 80% over 7 days, ONNX upgrade triggers. The metric to watch: `docs/benchmarks/findtool-hits-<date>.json` field `top3_rate`.

The nightly walkthrough above is the input that produces those metrics. Set it up before starting v3.2 work.
