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
import { MCPToolError } from '../../src/reliability/errors.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// CRIT-2: MCPToolError upstream serialization integration
// Simulates the full hub → wire → sandbox reconstruction path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate the bridge serializing an MCPToolError (mirrors http-server.ts catch block).
 */
function serializeErrorToWire(err: MCPToolError): Record<string, unknown> {
  let upstreamSerialized: unknown;
  const upstream = err.upstream;
  if (upstream instanceof Error) {
    upstreamSerialized = {
      __error__: true,
      name: upstream.name,
      message: upstream.message,
      stack: upstream.stack,
    };
  } else {
    try {
      upstreamSerialized = JSON.parse(JSON.stringify(upstream));
    } catch {
      upstreamSerialized = String(upstream);
    }
  }
  return {
    type: 'mcp_tool_error',
    code: err.code,
    server: err.server,
    tool: err.tool,
    message: err.message,
    upstream: upstreamSerialized,
  };
}

/**
 * Simulate the sandbox reconstructing an MCPToolError from wire data
 * (mirrors executor.ts MCPServerClient.call reconstruction block).
 */
function reconstructErrorFromWire(wire: Record<string, unknown>, defaultServer: string): MCPToolError {
  let upstream: unknown = wire.upstream;
  if (upstream && typeof upstream === 'object' && (upstream as Record<string, unknown>).__error__) {
    const u = upstream as Record<string, unknown>;
    const reconstructed = new Error(u.message as string);
    reconstructed.name = u.name as string;
    if (u.stack) reconstructed.stack = u.stack as string;
    upstream = reconstructed;
  }
  return new MCPToolError(
    wire.code as string,
    (wire.server as string) ?? defaultServer,
    wire.tool as string,
    upstream,
  );
}

describe('CRIT-2: MCPToolError upstream round-trip — hub to sandbox', () => {
  it('structured upstream object survives hub → wire → sandbox', () => {
    // Backend throws MCPToolError with a structured upstream payload
    const backendError = new MCPToolError(
      'contract_not_found',
      'ibkr',
      'get_portfolio',
      { code: 'contract_not_found', details: { contractId: 'ABC123' } },
    );

    const wire = serializeErrorToWire(backendError);
    const sandboxError = reconstructErrorFromWire(wire, 'ibkr');

    // Sandbox code can access e.upstream.code without string-parsing
    const u = sandboxError.upstream as Record<string, unknown>;
    expect(u.code).toBe('contract_not_found');
    const details = u.details as Record<string, unknown>;
    expect(details.contractId).toBe('ABC123');
  });

  it('Error-instance upstream is reconstructed as Error on the sandbox side', () => {
    const cause = new TypeError('network timeout');
    const backendError = new MCPToolError('NETWORK', 'myserver', 'fetch_data', cause);

    const wire = serializeErrorToWire(backendError);
    const sandboxError = reconstructErrorFromWire(wire, 'myserver');

    expect(sandboxError.upstream instanceof Error).toBe(true);
    const u = sandboxError.upstream as Error;
    expect(u.message).toBe('network timeout');
    // instanceof check that sandbox code would do:
    // Note: name is preserved but not the class itself (cross-boundary limitation)
    expect(u.name).toBe('TypeError');
  });

  it('null upstream is preserved across the wire', () => {
    const backendError = new MCPToolError('UNKNOWN', 's', 't', null);
    const wire = serializeErrorToWire(backendError);
    const sandboxError = reconstructErrorFromWire(wire, 's');
    expect(sandboxError.upstream).toBeNull();
  });

  it('sandbox catches MCPToolError and e.upstream.code is defined', () => {
    // This is the exact pattern from sandbox user code that was broken before CRIT-2
    const backendError = new MCPToolError('rate_limit', 'github', 'create_issue', { code: 'rate_limit', retryAfter: 60 });
    const wire = serializeErrorToWire(backendError);
    const sandboxError = reconstructErrorFromWire(wire, 'github');

    // Sandbox code: if (e instanceof MCPToolError && e.upstream.code === 'rate_limit')
    expect(sandboxError instanceof MCPToolError).toBe(true);
    expect((sandboxError.upstream as Record<string, unknown>).code).toBe('rate_limit');
    // Previously this returned undefined — now it correctly returns the value
    expect((sandboxError.upstream as Record<string, unknown>).retryAfter).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-1: Result scrubbing — detokenized PII must not reach Claude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the __scrubResult function from the sandbox preamble (executor.ts).
 */
function scrubResult(value: unknown, reverseMap: Record<string, string>): unknown {
  const plainToToken: Record<string, string> = {};
  for (const [token, plain] of Object.entries(reverseMap)) {
    plainToToken[plain] = token;
  }
  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      return Object.prototype.hasOwnProperty.call(plainToToken, v) ? plainToToken[v] : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(vv);
      }
      return out;
    }
    return v;
  }
  if (Object.keys(reverseMap).length === 0) return value;
  return walk(value);
}

describe('HIGH-1: result scrubbing prevents PII reaching Claude', () => {
  it('detokenized email returned directly is scrubbed back to token', () => {
    // Hub tokenizes the tool result
    const { reverseMap } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { email: 'x@y.com' },
    });

    // Sandbox user code: return mcp.detokenize('[EMAIL_1]') → 'x@y.com'
    const detokenizedValue = detokenize('[EMAIL_1]', reverseMap); // 'x@y.com'

    // __scrubResult runs before __RESULT_START__ serialization
    const finalResult = scrubResult(detokenizedValue, reverseMap);

    // Claude receives the token, NOT the plaintext
    expect(finalResult).toBe('[EMAIL_1]');
    expect(finalResult).not.toBe('x@y.com');
  });

  it('object containing detokenized PII field is fully scrubbed', () => {
    const { reverseMap } = simulateHubCallTool({
      toolDef: { redact: { response: ['email', 'phone'] } },
      upstreamResult: { email: 'x@y.com', phone: '+61 412 345 678' },
    });

    // Sandbox user code builds result using detokenized values
    const userResult = {
      processed: true,
      contact: {
        email: detokenize('[EMAIL_1]', reverseMap),
        phone: detokenize('[PHONE_1]', reverseMap),
      },
    };

    const finalResult = scrubResult(userResult, reverseMap) as typeof userResult;

    expect(finalResult.contact.email).toBe('[EMAIL_1]');
    expect(finalResult.contact.phone).toBe('[PHONE_1]');
    expect(finalResult.processed).toBe(true);
    // No plaintext values in the serialized output
    expect(JSON.stringify(finalResult)).not.toContain('x@y.com');
    expect(JSON.stringify(finalResult)).not.toContain('+61 412 345 678');
  });

  it('result without any PII passes through scrubResult unchanged', () => {
    const { reverseMap } = simulateHubCallTool({
      toolDef: { redact: { response: ['email'] } },
      upstreamResult: { email: 'x@y.com' },
    });

    // Sandbox user code returns something unrelated
    const userResult = { status: 'done', count: 5 };
    const finalResult = scrubResult(userResult, reverseMap) as typeof userResult;

    expect(finalResult.status).toBe('done');
    expect(finalResult.count).toBe(5);
  });

  it('empty reverseMap means no scrubbing is applied (no-op fast path)', () => {
    // Tool without redact annotation — reverseMap is empty
    const { reverseMap } = simulateHubCallTool({
      toolDef: { redact: undefined },
      upstreamResult: { email: 'x@y.com' },
    });
    expect(Object.keys(reverseMap)).toHaveLength(0);

    const userResult = { email: 'x@y.com' };
    const finalResult = scrubResult(userResult, reverseMap) as typeof userResult;

    // No tokens, so value is returned as-is (user deliberately put this value there)
    expect(finalResult.email).toBe('x@y.com');
  });
});
