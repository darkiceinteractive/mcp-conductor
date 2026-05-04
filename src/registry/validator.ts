/**
 * Input validation using ajv (JSON Schema draft 7).
 * Validates tool call arguments before they hit the backend — eliminating
 * unnecessary round-trips for bad params.
 *
 * Performance target: <1ms p99 for typical schemas (ajv compiles schemas
 * once and caches the resulting validate function).
 *
 * @module registry/validator
 */

// ajv v8 ships a named export AND a default export that both point to the
// class. TypeScript's ESM interop with CJS packages sometimes resolves the
// module-level value as the namespace rather than the default; importing the
// named export is the most portable form.
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import type { JsonSchema, ToolDefinition, ValidationResult } from './index.js';

// One shared Ajv instance — compiled validators are cached internally.
// allErrors:true collects all violations rather than stopping at the first.
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate `args` against a raw JSON Schema.
 * Returns a `ValidationResult` — never throws.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  args: unknown
): ValidationResult {
  const valid = ajv.validate(schema as object, args);

  if (valid) {
    return { valid: true };
  }

  const errors = (ajv.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'validation error',
  }));

  return { valid: false, errors };
}

/**
 * Validate `args` against a specific tool's inputSchema.
 * Returns `{ valid: true }` when the tool is unknown (fail-open — the
 * backend will surface its own error) or when no schema is present.
 */
export function validateToolInput(
  tool: ToolDefinition | null | undefined,
  args: unknown
): ValidationResult {
  if (!tool) {
    // Unknown tool — fail open; backend handles the error.
    return { valid: true };
  }

  if (!tool.inputSchema || Object.keys(tool.inputSchema).length === 0) {
    // No schema to validate against — treat as valid.
    return { valid: true };
  }

  return validateAgainstSchema(tool.inputSchema, args);
}
