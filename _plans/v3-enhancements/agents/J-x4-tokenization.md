# Agent J — Workstream X4 PII tokenization

You add per-server `redact.response` config that strips sensitive values from upstream responses **before** they enter the sandbox or Claude's context. Reverse map sandbox-local; `mcp.detokenize(value)` for outbound calls.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/J-x4
git branch --show-current  # feature/v3-x4-tokenization
git fetch origin
git rebase origin/feature/v3-phase-0-1   # registry needed
git rebase origin/feature/v3-x1-passthrough   # X1 routing annotations side-by-side with redact
npm install && npm run test:run
```

Read `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md` §3 Part C "Workstream X4".

Append start checkpoint to STATUS.md.

## Scope

Built-in matchers ONLY this cut (decision recorded — no inline-regex this sprint):
- email (RFC 5322 simplified)
- phone (loose international, e.g. `+CC NNNN NNN NNN`, `(NNN) NNN-NNNN`)
- SSN (`NNN-NN-NNNN` and 9-digit run with context)
- credit card (Luhn-validated, 13–19 digits with optional separators)
- IBAN (basic checksum)
- IPv4 + IPv6

Files:
- `src/utils/tokenize.ts` (NEW) — pure tokenizer; reuses Phase 1.6 redact infrastructure (`src/utils/redact.ts` already exists for log redaction) but generalises it to data-flow with a reverse map.
- `src/hub/mcp-hub.ts` — apply tokenizer to result before return when `ToolDefinition.redact.response` annotation present.
- `src/runtime/executor.ts` — sandbox preamble: `mcp.detokenize(value)` looks up the reverse map. Reverse map is per-execution (not shared across `execute_code` calls) so a token can't survive past the call that minted it.

Annotation read from `ToolDefinition.redact` (set via `update_server` MCP tool [Agent I's territory] or directly in `~/.mcp-conductor.json`).

## Acceptance

- Server returning `{"email":"x@y.com", "phone":"+61 412 345 678"}` surfaces `{"email":"[EMAIL_1]", "phone":"[PHONE_1]"}` in the sandbox.
- `mcp.detokenize("[EMAIL_1]")` returns `x@y.com` inside the same `execute_code` call.
- Token survives a within-call outbound MCP call (e.g. `mcp.server('crm').call('lookup', {email: mcp.detokenize('[EMAIL_1]')})` works).
- Token does NOT detokenize when returned as the final result (Claude sees `[EMAIL_1]`).
- A subsequent `execute_code` call cannot detokenize tokens from a prior call.
- `test/unit/tokenize.test.ts`, `test/integration/tokenize-flow.test.ts` (~12 cases) pass.

## Commit pattern

```
feat(v3-x4): tokenize.ts pure matcher engine (email/phone/SSN/CC-Luhn/IBAN/IP)
feat(v3-x4): hub applies tokenizer when ToolDefinition.redact.response present
feat(v3-x4): sandbox mcp.detokenize with per-execution reverse map
feat(v3-x4): integration glue with X1 passthrough adapter
test(v3-x4): full tokenize + integration flow test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 X4: PII tokenization (built-in matchers)"`. STATUS.md.
