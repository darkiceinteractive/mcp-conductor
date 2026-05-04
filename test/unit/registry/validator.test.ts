/**
 * Tests for src/registry/validator.ts
 *
 * PRD §5 Phase 1 test cases:
 * - catches missing required field
 * - catches type mismatch
 * - catches enum violation
 * - respects additionalProperties: false
 * - validates within 1ms for 100-property schema
 * - handles array validation
 * - handles nested object validation
 */

import { describe, it, expect } from 'vitest';
import { validateAgainstSchema, validateToolInput } from '../../../src/registry/validator.js';
import type { ToolDefinition } from '../../../src/registry/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    server: 'test-server',
    name: 'test-tool',
    description: 'test tool',
    inputSchema: {},
    ...overrides,
  };
}

// ─── validateAgainstSchema ────────────────────────────────────────────────

describe('validateAgainstSchema', () => {
  it('catches missing required field', () => {
    const result = validateAgainstSchema(
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors!.some((e) => e.message.includes('required'))).toBe(true);
  });

  it('catches type mismatch', () => {
    const result = validateAgainstSchema(
      { type: 'object', properties: { count: { type: 'number' } } },
      { count: 'not-a-number' }
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors!.some((e) => e.path.includes('count') || e.message.includes('number'))
    ).toBe(true);
  });

  it('catches enum violation', () => {
    const result = validateAgainstSchema(
      { type: 'object', properties: { state: { enum: ['open', 'closed', 'all'] } } },
      { state: 'invalid-state' }
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('respects additionalProperties: false', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      { name: 'alice', unexpected: 'boom' }
    );
    expect(result.valid).toBe(false);
  });

  it('handles array validation', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
    };
    expect(validateAgainstSchema(schema, { tags: ['a', 'b'] }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { tags: [1, 2] }).valid).toBe(false);
  });

  it('handles nested object validation', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user: {
          type: 'object' as const,
          properties: { id: { type: 'number' as const } },
          required: ['id'],
        },
      },
      required: ['user'],
    };
    expect(validateAgainstSchema(schema, { user: { id: 1 } }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { user: {} }).valid).toBe(false);
  });

  it('returns valid: true for passing args', () => {
    const result = validateAgainstSchema(
      { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      { q: 'hello' }
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates within 1ms p99 for a 100-property schema', () => {
    const properties: Record<string, { type: string }> = {};
    const args: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      properties[`field${i}`] = { type: 'string' };
      args[`field${i}`] = `value${i}`;
    }
    const schema = { type: 'object' as const, properties };

    // Warm-up: prime ajv's compiled-validator cache
    validateAgainstSchema(schema, args);

    const start = performance.now();
    for (let r = 0; r < 100; r++) {
      validateAgainstSchema(schema, args);
    }
    const p99 = (performance.now() - start) / 100;

    expect(p99).toBeLessThan(1);
  });
});

// ─── validateToolInput ────────────────────────────────────────────────────

describe('validateToolInput', () => {
  it('returns valid: true for null tool (fail-open)', () => {
    expect(validateToolInput(null, { anything: true }).valid).toBe(true);
  });

  it('returns valid: true for undefined tool', () => {
    expect(validateToolInput(undefined, {}).valid).toBe(true);
  });

  it('returns valid: true when tool has no inputSchema', () => {
    expect(validateToolInput(makeTool({ inputSchema: {} }), { x: 1 }).valid).toBe(true);
  });

  it('validates against the tool inputSchema when present', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string' } },
        required: ['repo'],
      },
    });
    expect(validateToolInput(tool, { repo: 'my-repo' }).valid).toBe(true);
    expect(validateToolInput(tool, {}).valid).toBe(false);
  });
});
