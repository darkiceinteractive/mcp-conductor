/**
 * mcp.summarize — Heuristic summarization helper
 *
 * Converts arbitrary data into a compact string representation that fits
 * within a token budget. Uses a simple heuristic: 1 token ≈ 4 characters.
 * No LLM calls — fully in-process and zero-roundtrip.
 *
 * @module runtime/helpers/summarize
 */

export type SummarizeStyle = 'list' | 'paragraph' | 'json';

export interface SummarizeOptions {
  /** Target token budget. Output will not exceed this. */
  maxTokens: number;
  /** Output format. Defaults to 'list'. */
  style?: SummarizeStyle;
}

// Characters per token (conservative heuristic)
const CHARS_PER_TOKEN = 4;

function tokenBudgetToChars(maxTokens: number): number {
  return maxTokens * CHARS_PER_TOKEN;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// Style renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderJson(data: unknown, maxChars: number): string {
  try {
    const full = JSON.stringify(data, null, 2);
    return clip(full, maxChars);
  } catch {
    return clip(String(data), maxChars);
  }
}

function renderList(data: unknown, maxChars: number): string {
  const lines: string[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'object' && item !== null) {
        const pairs = Object.entries(item as Record<string, unknown>)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        lines.push(`• ${pairs}`);
      } else {
        lines.push(`• ${String(item)}`);
      }
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  } else {
    lines.push(String(data));
  }

  // Build output within budget, line by line
  const budget = maxChars;
  let result = '';
  for (const line of lines) {
    const candidate = result ? result + '\n' + line : line;
    if (candidate.length > budget) {
      // Try to fit partial line
      const remaining = budget - result.length - 1; // 1 for newline
      if (remaining > 4) {
        result += (result ? '\n' : '') + clip(line, remaining);
      }
      break;
    }
    result = candidate;
  }

  return result || clip(String(data), budget);
}

function renderParagraph(data: unknown, maxChars: number): string {
  let text: string;

  if (typeof data === 'string') {
    text = data;
  } else if (Array.isArray(data)) {
    // Summarise array as "N items: first, second, ..."
    const count = data.length;
    const previews = data
      .slice(0, 3)
      .map((x) =>
        typeof x === 'object' && x !== null
          ? JSON.stringify(x).slice(0, 60)
          : String(x).slice(0, 60)
      )
      .join(', ');
    text = `${count} item${count !== 1 ? 's' : ''}: ${previews}${count > 3 ? '...' : ''}`;
  } else if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data as object);
    const previews = keys
      .slice(0, 5)
      .map((k) => `${k}: ${JSON.stringify((data as Record<string, unknown>)[k]).slice(0, 30)}`)
      .join('; ');
    text = `Object with ${keys.length} field${keys.length !== 1 ? 's' : ''}: ${previews}`;
  } else {
    text = String(data);
  }

  return clip(text, maxChars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarize arbitrary data into a string that fits within `maxTokens`.
 *
 * @example
 * const summary = summarize(issues, { maxTokens: 200, style: 'list' });
 */
export function summarize(data: unknown, options: SummarizeOptions): string {
  const maxChars = tokenBudgetToChars(options.maxTokens);
  const style: SummarizeStyle = options.style ?? 'list';

  switch (style) {
    case 'json':
      return renderJson(data, maxChars);
    case 'paragraph':
      return renderParagraph(data, maxChars);
    case 'list':
    default:
      return renderList(data, maxChars);
  }
}
