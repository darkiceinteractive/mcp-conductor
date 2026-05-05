# Nightly Workflow

The nightly CI workflow (`.github/workflows/nightly.yml`) runs three jobs at 02:00 UTC daily and can be triggered manually via `workflow_dispatch`.

## Jobs

### 1. memory-soak (T2)

**Timeout:** 90 minutes

Runs the full memory-leak test suite (`npm run test:memory-leak`) at production iteration counts:

- 10 000 sequential `execute_code` calls — RSS growth must stay within 10% of baseline
- 1 000 calls with recycle every 10 jobs — no zombie Deno PIDs
- 10 000 cache acquire/release cycles — FD count stable
- 100 000 cache writes — memory bounded by config limits
- 10 000 daemon connect/disconnect cycles — no leaked handles
- 1 000 streamed executions (half aborted mid-stream) — StreamManager cleared

**Controlled by:** `NIGHTLY=1` environment variable. Without it the T2 suite runs at 10% of these counts (fast mode for PR gate).

**No secrets required.**

---

### 2. real-api-popular-mcps (T4 + T5)

**Timeout:** 60 minutes

Runs the live MCP tests (`test/popular-mcps/*/live.test.ts`) and the token-savings benchmark (`npm run benchmark:token-savings`) against real APIs.

**Required GitHub secrets:**

| Secret | Scope | Used by |
|--------|-------|---------|
| `GH_TOKEN_FOR_LIVE_TESTS` | `read:user`, `repo` (read-only) | `github/live.test.ts` |
| `GOOGLE_OAUTH_CREDS` | Base64-encoded OAuth JSON for a read-only test Google account | `gmail/live.test.ts`, `gdrive/live.test.ts`, `gcalendar/live.test.ts` |
| `BRAVE_API_KEY` | Brave Search API key (free tier sufficient) | `brave-search/live.test.ts` |
| `SLACK_BOT_TOKEN` | `channels:read`, `search:read` | `slack/live.test.ts` |
| `NOTION_TOKEN` | Integration token with read access to a test workspace | `notion/live.test.ts` |
| `LINEAR_API_KEY` | API key with read access | `linear/live.test.ts` |

**Adding a secret:**
```
gh secret set GH_TOKEN_FOR_LIVE_TESTS --body "ghp_..."
```

**Artifacts:** benchmark reports are uploaded to `nightly-benchmarks-<run_number>` (30-day retention) and written to `docs/benchmarks/popular-mcps-YYYY-MM-DD.md`.

---

### 3. security-fuzz (T3)

**Timeout:** 30 minutes

Runs the full security fuzzing suite (`npm run test:security`) at extended iteration counts:

- 10 000 random/malformed payloads at daemon auth handshake
- 10 000 CRLF/header injection variants on the HTTP bridge
- 1 000 path traversal attempts on `import_servers_from_claude`
- Full timing-attack test for HMAC comparison (500 samples per branch)
- ReDoS pathological inputs against all 6 PII matchers

**Controlled by:** `EXTENDED_FUZZ=1` environment variable.

**No secrets required.**

---

## Manual dispatch

Trigger any job manually:

```bash
gh workflow run nightly.yml
# or with a specific ref:
gh workflow run nightly.yml --ref feature/v3.1
```

## Viewing results

```bash
# List recent nightly runs
gh run list --workflow=nightly.yml

# Download artifacts from a run
gh run download <run-id>

# View job logs
gh run view <run-id> --log
```

## Failure handling

If a nightly job fails:

1. Check the run log: `gh run view <run-id> --log`
2. Download artifacts: benchmark reports may still be present even if tests fail
3. File an issue tagged `nightly-failure` with the run URL
4. The nightly workflow does **not** block PRs — it runs independently of the PR gate

## Relationship to PR gate

| Concern | PR gate (`ci.yml`) | Nightly (`nightly.yml`) |
|---------|--------------------|------------------------|
| Memory leak | Fast mode (10% iterations) | Full soak (100%) |
| Popular MCP tests | Recorded fixtures only | Live API + recorded |
| Security fuzzing | 500 payloads | 10 000 payloads |
| Token savings | Assertion tests only | Assertion + full benchmark report |
| Wall time budget | < 2 min | < 3 h total |
