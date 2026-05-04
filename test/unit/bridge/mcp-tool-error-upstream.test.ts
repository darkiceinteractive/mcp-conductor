/**
 * CRIT-2: MCPToolError.upstream serialization round-trip
 *
 * Verifies that the bridge serializes the `upstream` field of MCPToolError
 * in a JSON-safe way and that the sandbox reconstruction restores the original
 * structure (including Error instances).
 */

import { describe, it, expect } from 'vitest';
import { MCPToolError } from '../../../src/reliability/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Simulate bridge serialization (mirrors http-server.ts catch block)
// ─────────────────────────────────────────────────────────────────────────────

function serializeUpstream(upstream: unknown): unknown {
  if (upstream instanceof Error) {
    return {
      __error__: true,
      name: upstream.name,
      message: upstream.message,
      stack: upstream.stack,
    };
  }
  try {
    return JSON.parse(JSON.stringify(upstream));
  } catch {
    return String(upstream);
  }
}

function serializeMCPToolError(err: MCPToolError): Record<string, unknown> {
  return {
    type: 'mcp_tool_error',
    code: err.code,
    server: err.server,
    tool: err.tool,
    message: err.message,
    upstream: serializeUpstream(err.upstream),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulate sandbox reconstruction (mirrors executor.ts MCPServerClient.call)
// ─────────────────────────────────────────────────────────────────────────────

function reconstructUpstream(serialized: unknown): unknown {
  if (serialized && typeof serialized === 'object' && (serialized as Record<string, unknown>).__error__) {
    const u = serialized as Record<string, unknown>;
    const reconstructed = new Error(u.message as string);
    reconstructed.name = u.name as string;
    if (u.stack) reconstructed.stack = u.stack as string;
    return reconstructed;
  }
  return serialized;
}

function reconstructMCPToolError(wire: Record<string, unknown>, defaultServer: string): MCPToolError {
  const upstream = reconstructUpstream(wire.upstream);
  return new MCPToolError(
    wire.code as string,
    (wire.server as string) ?? defaultServer,
    wire.tool as string,
    upstream,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CRIT-2: MCPToolError.upstream serialization round-trip', () => {
  describe('structured object upstream', () => {
    it('round-trips a plain object through serialize → deserialize', () => {
      const original = new MCPToolError('contract_not_found', 'ibkr', 'get_portfolio', { foo: 'bar', count: 42 });
      const wire = serializeMCPToolError(original);
      const restored = reconstructMCPToolError(wire, 'ibkr');

      expect(restored.code).toBe('contract_not_found');
      expect(restored.server).toBe('ibkr');
      expect(restored.tool).toBe('get_portfolio');
      expect(restored.upstream).toEqual({ foo: 'bar', count: 42 });
      expect((restored.upstream as Record<string, unknown>).foo).toBe('bar');
    });

    it('round-trips a nested object upstream', () => {
      const upstream = { error: { code: 'RATE_LIMIT', details: { retryAfter: 60 } } };
      const original = new MCPToolError('RATE_LIMIT', 'github', 'create_issue', upstream);
      const wire = serializeMCPToolError(original);
      const restored = reconstructMCPToolError(wire, 'github');

      const u = restored.upstream as typeof upstream;
      expect(u.error.code).toBe('RATE_LIMIT');
      expect(u.error.details.retryAfter).toBe(60);
    });

    it('round-trips null upstream', () => {
      const original = new MCPToolError('UNKNOWN', 'myserver', 'mytool', null);
      const wire = serializeMCPToolError(original);
      const restored = reconstructMCPToolError(wire, 'myserver');
      expect(restored.upstream).toBeNull();
    });
  });

  describe('Error instance upstream', () => {
    it('reconstructs an Error from the __error__ sentinel', () => {
      const cause = new Error('upstream network failure');
      cause.name = 'NetworkError';
      const original = new MCPToolError('NETWORK', 'crm', 'lookup', cause);
      const wire = serializeMCPToolError(original);

      // Wire must carry __error__ sentinel
      const upstreamOnWire = (wire.upstream as Record<string, unknown>);
      expect(upstreamOnWire.__error__).toBe(true);
      expect(upstreamOnWire.name).toBe('NetworkError');
      expect(upstreamOnWire.message).toBe('upstream network failure');

      // Reconstruction restores Error instance
      const restored = reconstructMCPToolError(wire, 'crm');
      expect(restored.upstream instanceof Error).toBe(true);
      const u = restored.upstream as Error;
      expect(u.message).toBe('upstream network failure');
      expect(u.name).toBe('NetworkError');
    });

    it('restores stack trace from the serialized form', () => {
      const cause = new Error('disk full');
      const original = new MCPToolError('DISK_FULL', 'storage', 'write', cause);
      const wire = serializeMCPToolError(original);
      const restored = reconstructMCPToolError(wire, 'storage');
      const u = restored.upstream as Error;
      // Stack is present and non-empty
      expect(typeof u.stack).toBe('string');
      expect(u.stack!.length).toBeGreaterThan(0);
    });

    it('sandbox code can access e.upstream.code when upstream is a structured object', () => {
      const upstream = { code: 'X_RATE', message: 'too many requests' };
      const original = new MCPToolError('X_RATE', 'api', 'fetch', upstream);
      const wire = serializeMCPToolError(original);
      const restored = reconstructMCPToolError(wire, 'api');
      expect((restored.upstream as typeof upstream).code).toBe('X_RATE');
    });
  });

  describe('non-serializable upstream fallback', () => {
    it('converts a circular-reference upstream to its string form', () => {
      // Create a circular reference that JSON.stringify cannot handle
      const circular: Record<string, unknown> = { key: 'value' };
      circular.self = circular;
      const original = new MCPToolError('CIRC', 'x', 'y', circular);
      const wire = serializeMCPToolError(original);
      // Upstream on wire should be a string (fallback)
      expect(typeof wire.upstream).toBe('string');
    });
  });
});
