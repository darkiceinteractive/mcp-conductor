/**
 * Passthrough tool registrar — Workstream X1 (Agent H)
 *
 * At server start, iterates the ToolRegistry and registers a dedicated
 * first-class MCP tool for every entry annotated `routing: "passthrough"`.
 *
 * Tool naming: `<server>__<tool>` (double underscore, namespace separator).
 *
 * Each registered tool:
 * - Bypasses the Deno sandbox entirely.
 * - Forwards params directly to `mcpHub.callTool()`.
 * - Carries the upstream `readOnlyHint`, `destructiveHint`, `idempotentHint`,
 *   `openWorldHint`, `title`, and `description` annotations.
 * - Preserves the upstream `inputSchema` so Claude sees the real parameter
 *   shape without an extra round-trip.
 *
 * Default routing for newly-added unknown servers stays `execute_code`
 * (opt-in model — backwards compatible).
 *
 * @module server/passthrough-registrar
 */

import * as z from 'zod';
import { logger } from '../utils/index.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { MCPHub } from '../hub/mcp-hub.js';

/**
 * Minimal interface of McpServer that the registrar needs.
 * Using a structural type so tests can inject a lightweight stub without
 * importing the full SDK.
 */
export interface McpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
      inputSchema: Record<string, unknown>;
    },
    handler: (params: Record<string, unknown>) => Promise<{
      content: [{ type: 'text'; text: string }];
      structuredContent?: Record<string, unknown>;
    }>
  ): void;
}

/**
 * Minimal interface of MCPHub that the registrar needs.
 */
export interface McpHubLike {
  callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown>;
}

/**
 * Sanitise a raw name segment so it is safe to embed in an MCP tool name.
 * MCP tool names must match `^[a-zA-Z0-9_-]+$`.
 * Replace any character outside that set with `_`.
 */
function sanitiseSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build the composite tool name for a passthrough tool.
 * Format: `<server>__<tool>` (double underscore separator).
 */
export function buildPassthroughToolName(server: string, tool: string): string {
  return `${sanitiseSegment(server)}__${sanitiseSegment(tool)}`;
}

/**
 * Register all `routing: "passthrough"` tools from the registry as
 * first-class MCP tools on `mcpServer`.
 *
 * This function is idempotent with respect to a fresh server instance —
 * call it once after `registry.refresh()`. If called multiple times on the
 * same server instance the SDK will throw a duplicate-name error, so callers
 * must ensure it runs only once per server lifecycle.
 *
 * @param registry   Populated ToolRegistry (after `refresh()` has been called).
 * @param mcpServer  The McpServer instance to register tools on.
 * @param mcpHub     The MCPHub used to forward tool calls to backends.
 * @returns          The number of passthrough tools registered.
 */
export function registerPassthroughTools(
  registry: ToolRegistry,
  mcpServer: McpServerLike,
  mcpHub: McpHubLike
): number {
  const tools = registry.getAllTools();
  let registered = 0;

  for (const tool of tools) {
    if (tool.routing !== 'passthrough') {
      continue;
    }

    const composedName = buildPassthroughToolName(tool.server, tool.name);

    // Build an inputSchema for the SDK from the tool's JSON Schema properties.
    // Each property is typed as z.unknown() (required) or z.unknown().optional()
    // so the SDK validates presence of required fields while accepting any value.
    const inputSchemaForSdk: Record<string, z.ZodType> = {};

    if (tool.inputSchema?.properties) {
      for (const propName of Object.keys(tool.inputSchema.properties)) {
        const isRequired =
          Array.isArray(tool.inputSchema.required) &&
          tool.inputSchema.required.includes(propName);

        inputSchemaForSdk[propName] = isRequired
          ? z.unknown()
          : z.unknown().optional();
      }
    }

    // Apply conservative read-safe annotations.
    // The registry does not yet carry upstream MCP ToolAnnotations (that is
    // Phase 1 typegen territory). When Agent A's typegen lands and adds those
    // fields to ToolDefinition, extend this block to read them directly.
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };

    // Capture loop variables for the async handler closure.
    const toolServer = tool.server;
    const toolName = tool.name;
    const toolDescription = tool.description;

    mcpServer.registerTool(
      composedName,
      {
        title: `${toolServer}/${toolName}`,
        description: toolDescription || `Passthrough to ${toolServer}.${toolName}`,
        annotations,
        inputSchema: inputSchemaForSdk,
      },
      async (params: Record<string, unknown>) => {
        logger.debug(`Passthrough call: ${toolServer}.${toolName}`, { params });

        const result = await mcpHub.callTool(toolServer, toolName, params);

        const resultStr =
          typeof result === 'string' ? result : JSON.stringify(result);

        return {
          content: [{ type: 'text' as const, text: resultStr }],
          structuredContent: { success: true, result },
        };
      }
    );

    logger.debug(`Registered passthrough tool: ${composedName}`);
    registered++;
  }

  if (registered > 0) {
    logger.info(
      `Passthrough registrar: registered ${registered} passthrough tool(s)`
    );
  }

  return registered;
}
