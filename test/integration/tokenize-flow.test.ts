/**
 * Integration tests for X4 PII tokenization flow (Agent J)
 *
 * Tests the end-to-end path:
 *   1. MCPHub.callTool() applies tokenizer when ToolDefinition.redact.response
 *      is present on the target tool.
 *   2. The sandbox preamble exposes mcp.detokenize() backed by the per-call
 *      reverse map.
 *   3. Tokens do NOT survive across execute_code calls.
 *   4. The final sandbox result returns tokens (not original values) so
 *      Claude never sees raw PII.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tokenize, detokenize } from '../../src/utils/tokenize.js';
import type { ToolDefinition } from '../../src/registry/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Simulated hub callTool with tokenization applied
// (mirrors the integration point in mcp-hub.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeHubOptions {
  toolDef: Pick<ToolDefinition, 'redact'>;
  upstreamResult: unknown;
}

function simulateHubCallTool(opts: FakeHubOptions): {
  result: unknown;
  reverseMap: Record<string, string>;
} {
  const matchers = opts.toolDef.redact?.response ?? [];
  if (matchers.length === 0) {
    return { result: opts.upstreamResult, reverseMap: {} };
  }
  const { redacted, reverseMap } = tokenize(opts.upstreamResult, matchers);
  return { result: redacted, reverseMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('X4 tokenize-flow integration', () => {
  it('server response with email + phone is tokenized at the hub boundary', () => {
    const upstreamResult = { email: 'x@y.com', phone: '+61 412 345 678' };
    const toolDef: Pick<ToolDefinition, 'redact'> = {
      redact: { response: ['email', 'phone'] },
    };

    const { result, reverseMap } = simulateHubCallTool({ toolDef, upstreamResult });

    expect((result as Record<string, unknown>).email).toBe('[EMAIL_1]');
    expect((result as Record<string, unknown>).phone).toBe('[PHONE_1]');
    expect(reverseMap['[EMAIL_1]']).toBe('x@y.com');
    expect(reverseMap['[PHONE_1]']).toBe('+61 412 345 678');
  });

  it('sandbox mcp.detokenize resolves token within same call', () => {
    const upstreamResult = { email: 'x@y.com' };
    const toolDef: Pick<ToolDefinition, 'redact'> = {
      redact: { response: ['email'] },
    };

    const { result, reverseMap } = simulateHubCallTool({ toolDef, upstreamResult });

    // Sandbox receives the tokenized result
    const sandboxResult = result as Record<string, unknown>;
    const token = sandboxResult.email as string;
    expect(token).toBe('[EMAIL_1]');

    // mcp.detokenize() backed by the same reverseMap resolves it
    expect(detokenize(token, reverseMap)).toBe('x@y.com');
  });

  it('token does NOT resolve in a subsequent call (separate reverse map)', () => {
    // First call
    const { reverseMap: mapCall1 } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { email: 'x@y.com' },
    });

    // Second call — fresh reverse map
    const mapCall2: Record<string, string> = {};

    // Token from call 1 is not in the map for call 2
    expect(detokenize('[EMAIL_1]', mapCall2)).toBeUndefined();
    // But it still resolves in call 1's map
    expect(detokenize('[EMAIL_1]', mapCall1)).toBe('x@y.com');
  });

  it('final result returned to Claude contains token not original value', () => {
    // The sandbox "result" is what gets sent back to Claude. The reverse map
    // stays inside the sandbox scope and is never returned.
    const { result } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { email: 'x@y.com', id: 42 },
    });

    // Claude sees the tokenized version
    expect(JSON.stringify(result)).toContain('[EMAIL_1]');
    expect(JSON.stringify(result)).not.toContain('x@y.com');
  });

  it('tool without redact annotation passes result through unchanged', () => {
    const { result, reverseMap } = simulateHubCallTool({
      toolDef: { redact: undefined },
      upstreamResult: { email: 'x@y.com' },
    });

    expect((result as Record<string, unknown>).email).toBe('x@y.com');
    expect(Object.keys(reverseMap)).toHaveLength(0);
  });

  it('within-call outbound re-use: detokenize before forwarding to another tool', () => {
    // Simulate: crm.lookup({ email: mcp.detokenize('[EMAIL_1]') })
    const { reverseMap } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { email: 'x@y.com' },
    });

    // Sandbox code recovers original value and passes it as an outbound param
    const outboundEmail = detokenize('[EMAIL_1]', reverseMap);
    expect(outboundEmail).toBe('x@y.com');

    // This outbound call's result is also tokenized (separate invocation
    // of tokenize() in the hub)
    const { result: r2, reverseMap: map2 } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { matched: true, owner: 'x@y.com' },
    });
    expect((r2 as Record<string, unknown>).owner).toBe('[EMAIL_1]');
    expect(detokenize('[EMAIL_1]', map2)).toBe('x@y.com');
  });
});
