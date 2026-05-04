/**
 * PII Tokenization — Workstream X4 (Agent J)
 *
 * Strips sensitive values from MCP tool responses *before* they enter
 * the Deno sandbox or Claude's context. Each detected value is replaced
 * with a stable token (e.g. `[EMAIL_1]`). A per-execution reverse map
 * lets sandbox code call `mcp.detokenize(token)` to recover the original
 * value for outbound MCP calls.
 *
 * Design:
 * - Built-in matchers only this sprint (email, phone, SSN, CC/Luhn,
 *   IBAN, IPv4/v6). Inline-regex matchers are deferred to the follow-up.
 * - The reverse map is passed to `generateSandboxCode` and embedded in
 *   the sandbox preamble as a frozen object. It is NOT persisted and
 *   cannot outlive the `execute_code` call that created it.
 * - Tokenization is deterministic within a call: the same value always
 *   gets the same token (idempotent within one tokenize() invocation via
 *   the `seen` map).
 *
 * @module utils/tokenize
 */

// ─────────────────────────────────────────────────────────────────────────────
// Matcher types
// ─────────────────────────────────────────────────────────────────────────────

export type BuiltinMatcherName =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'iban'
  | 'ipv4'
  | 'ipv6';

export type RedactMatcher = BuiltinMatcherName | string;

// ─────────────────────────────────────────────────────────────────────────────
// Token format
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_LABELS: Record<BuiltinMatcherName, string> = {
  email: 'EMAIL',
  phone: 'PHONE',
  ssn: 'SSN',
  credit_card: 'CC',
  iban: 'IBAN',
  ipv4: 'IPV4',
  ipv6: 'IPV6',
};

// ─────────────────────────────────────────────────────────────────────────────
// Luhn algorithm (credit-card validation)
// ─────────────────────────────────────────────────────────────────────────────

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// IBAN checksum (ISO 13616 mod-97)
// ─────────────────────────────────────────────────────────────────────────────

function ibanCheck(raw: string): boolean {
  // Move first 4 chars to end and convert letters to digits
  const rearranged = (raw.slice(4) + raw.slice(0, 4)).toUpperCase();
  let numeric = '';
  for (const ch of rearranged) {
    if (ch >= 'A' && ch <= 'Z') {
      numeric += (ch.charCodeAt(0) - 55).toString();
    } else {
      numeric += ch;
    }
  }
  // BigInt mod-97 (string is too long for Number)
  let remainder = BigInt(0);
  for (const ch of numeric) {
    remainder = (remainder * 10n + BigInt(ch)) % 97n;
  }
  return remainder === 1n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each entry specifies:
 * - `pattern`: a global RegExp. Use single-quoted delimiters and avoid
 *   stateful flags beyond `g`+`i`. lastIndex is reset before each use.
 * - `validate`: optional secondary validator (Luhn, IBAN mod-97, …)
 * - `extractDigits`: strips separators before validate; used for CC / IBAN.
 */
interface MatcherSpec {
  label: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
  extractDigits?: (match: string) => string;
}

const BUILTIN_MATCHERS: Record<BuiltinMatcherName, MatcherSpec> = {
  // RFC 5322 simplified — local@domain.tld
  email: {
    label: TOKEN_LABELS.email,
    pattern: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g,
  },

  // Loose international: +CC NNN…, (NNN) NNN-NNNN, NNN-NNN-NNNN, etc.
  // Last group is \d{3,} to cover 3-digit tails (+61 412 345 678) and
  // 4-digit tails ((555) 867-5309). \+\d{7,15} catches compact international
  // numbers without separators.
  phone: {
    label: TOKEN_LABELS.phone,
    pattern: /(?:\+\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{3,}|\+\d{7,15}/g,
  },

  // SSN: NNN-NN-NNNN or 9-digit run. The 9-digit run is only matched
  // when preceded/followed by a word boundary so we don't swallow longer IDs.
  ssn: {
    label: TOKEN_LABELS.ssn,
    pattern: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g,
  },

  // Credit card: 13–19 digits with optional spaces/dashes, Luhn-validated.
  credit_card: {
    label: TOKEN_LABELS.credit_card,
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    extractDigits: (m) => m.replace(/[ -]/g, ''),
    validate: (digits) => digits.length >= 13 && digits.length <= 19 && luhnCheck(digits),
  },

  // IBAN: 2-letter country, 2 check digits, 11–30 alphanumeric chars.
  // Tolerates spaces every 4 chars (SEPA print form).
  iban: {
    label: TOKEN_LABELS.iban,
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi,
    extractDigits: (m) => m.replace(/\s/g, ''),
    validate: (raw) => {
      const stripped = raw.replace(/\s/g, '');
      return stripped.length >= 15 && stripped.length <= 34 && ibanCheck(stripped);
    },
  },

  // IPv4: standard dotted-quad with optional CIDR suffix
  ipv4: {
    label: TOKEN_LABELS.ipv4,
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\/\d{1,2})?\b/g,
  },

  // IPv6: full, compressed (::), and mixed IPv4/v6 forms
  ipv6: {
    label: TOKEN_LABELS.ipv6,
    pattern: /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:)*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:)*::/g,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenizeResult {
  /** The redacted value (tokens replace original sensitive data) */
  redacted: unknown;
  /**
   * Reverse map from token → original value.
   * Scoped to one `execute_code` call; never persisted.
   */
  reverseMap: Record<string, string>;
}

/**
 * Tokenize PII in `value` according to the requested `matchers`.
 *
 * - Walks nested objects and arrays recursively.
 * - String values are scanned for all active matchers.
 * - Object keys are NOT tokenized (only values).
 * - If the same literal appears twice it receives the same token
 *   (idempotent within one call).
 *
 * **Token stability — IMPORTANT (B12):** Tokens are scoped to a single call
 * and are NOT stable across calls. `[EMAIL_1]` produced in call A may refer
 * to a completely different email address than `[EMAIL_1]` produced in call B,
 * because the per-label counter resets on every invocation and matching order
 * can differ. Never store, compare, or cache tokens across `execute_code`
 * invocations. Use the `reverseMap` returned from the same call to detokenize
 * within that call only.
 *
 * @param value   The data returned by an MCP tool.
 * @param matchers Array of built-in matcher names (e.g. `['email','phone']`).
 *   Unknown names are silently ignored (future-proof for inline-regex extension).
 * @returns `{ redacted, reverseMap }` where `reverseMap[token] = original`.
 */
export function tokenize(
  value: unknown,
  matchers: ReadonlyArray<RedactMatcher>
): TokenizeResult {
  // Build the active spec set once per call.
  const activeSpecs: MatcherSpec[] = [];
  for (const name of matchers) {
    if (name in BUILTIN_MATCHERS) {
      activeSpecs.push(BUILTIN_MATCHERS[name as BuiltinMatcherName]);
    }
    // Unknown names (future inline-regex) are skipped silently.
  }

  if (activeSpecs.length === 0) {
    return { redacted: value, reverseMap: {} };
  }

  const counters: Record<string, number> = {};
  const seen: Map<string, string> = new Map(); // originalValue → token
  const reverseMap: Record<string, string> = {};

  function nextToken(label: string): string {
    counters[label] = (counters[label] ?? 0) + 1;
    return `[${label}_${counters[label]}]`;
  }

  function redactString(input: string): string {
    let result = input;
    for (const spec of activeSpecs) {
      spec.pattern.lastIndex = 0; // reset stateful global regex
      result = result.replace(spec.pattern, (match) => {
        // Secondary validation (Luhn, IBAN mod-97)
        if (spec.validate) {
          const digits = spec.extractDigits ? spec.extractDigits(match) : match;
          if (!spec.validate(digits)) return match; // not a valid PAN/IBAN — leave it
        }

        // Idempotent: same value → same token
        if (seen.has(match)) {
          return seen.get(match)!;
        }

        const token = nextToken(spec.label);
        seen.set(match, token);
        reverseMap[token] = match;
        return token;
      });
    }
    return result;
  }

  function walk(node: unknown): unknown {
    if (typeof node === 'string') return redactString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node; // number, boolean, null, undefined — pass through
  }

  const redacted = walk(value);
  return { redacted, reverseMap };
}

/**
 * Given a reverse map and a token string, return the original value.
 * Returns `undefined` if the token is not in the map.
 *
 * Used in the sandbox preamble to implement `mcp.detokenize(token)`.
 */
export function detokenize(
  token: string,
  reverseMap: Readonly<Record<string, string>>
): string | undefined {
  return reverseMap[token];
}
