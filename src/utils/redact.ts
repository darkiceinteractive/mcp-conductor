/**
 * Secret redaction for log output.
 *
 * Logs from Conductor land on stderr and may include error strings, tool
 * arguments, or stdout/stderr captured from backend MCP processes. Any of
 * those could contain API tokens (e.g. a user's Brave Search key showing
 * up in a server-side error). We scan for well-known key formats and
 * replace the matching region with `[REDACTED_<KIND>]` before the line
 * is written.
 *
 * This is defensive, not a replacement for careful logging — callers should
 * still avoid putting secrets in log fields.
 */

interface RedactPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Ordered list of known secret shapes. Each entry redacts its match to
 * `[REDACTED_<NAME>]` so operators can tell what kind of credential was
 * scrubbed without exposing the value.
 *
 * Add new patterns here as new providers become relevant.
 */
const PATTERNS: readonly RedactPattern[] = [
  // GitHub — ghp_, gho_, ghu_, ghs_, ghr_ prefixes
  { name: 'GITHUB_TOKEN', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  // Anthropic
  { name: 'ANTHROPIC_KEY', pattern: /sk-ant-[A-Za-z0-9_-]{30,}/g },
  // OpenAI (sk-proj-, sk-svcacct-, sk-...)
  { name: 'OPENAI_KEY', pattern: /sk-[A-Za-z0-9_-]{30,}/g },
  // Brave Search
  { name: 'BRAVE_KEY', pattern: /BSA[A-Za-z0-9_-]{25,}/g },
  // AWS Access Key ID (paired secret is high-entropy but unmarked)
  { name: 'AWS_ACCESS_KEY', pattern: /AKIA[A-Z0-9]{16}/g },
  // Google API keys
  { name: 'GOOGLE_API_KEY', pattern: /AIza[A-Za-z0-9_-]{35}/g },
  // Slack tokens
  { name: 'SLACK_TOKEN', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { name, pattern } of PATTERNS) {
    // Reset lastIndex because /g regexes retain state across calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED_${name}]`);
  }
  return out;
}
