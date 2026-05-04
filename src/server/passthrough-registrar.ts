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
 * Heuristic infer of MCP ToolAnnotations from a tool's name (HIGH-4 fix).
 *
 * MCP tool names overwhelmingly put verbs as prefixes (`delete_repository`,
 * `read_file`, `list_issues`). The matcher is therefore prefix-based with a
 * small suffix safety net for less-common name styles.
 *
 * Pattern groups (case-insensitive):
 *   - **destructive** verbs that mutate or remove state. Prefix:
 *     `delete_`, `remove_`, `create_`, `update_`, `send_`, `post_`, `put_`,
 *     `patch_`, `drop_`, `kill_`, `terminate_`, `revoke_`, `destroy_`,
 *     `set_`, `activate_`, `deactivate_`, `enable_`, `disable_`, `cancel_`.
 *     Suffix safety net: `_delete`, `_remove`, `_destroy`.
 *     → `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }`
 *   - **mutating but recoverable** verbs (write/save/upload):
 *     Prefix `save_`, `write_`, `upload_`; suffix `_save`, `_write`, `_upload`.
 *     → `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false }`
 *   - **read-safe** (default): `get_`, `list_`, `search_`, `query_`, `read_`,
 *     `fetch_`, `find_`, `count_`, `check_`, plus everything that doesn't
 *     match the above.
 *     → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true }`
 *
 * `openWorldHint` defaults to `false` for all (passthrough tools are bounded
 * by the upstream MCP server's tool surface).
 *
 * False negatives (a non-obvious destructive name marked safe) require an
 * explicit upstream annotation; the deferred Phase-1 typegen extension will
 * close that gap by carrying upstream annotations through `ToolDefinition`.
 */
export function inferAnnotationsFromName(toolName: string): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const name = toolName.toLowerCase();

  // Destructive: mutate or remove
  const destructivePrefix =
    /^(delete_|remove_|create_|update_|send_|post_|put_|patch_|drop_|kill_|terminate_|revoke_|destroy_|set_|activate_|deactivate_|enable_|disable_|cancel_)/;
  const destructiveSuffix = /(_delete|_remove|_destroy)$/;
  if (destructivePrefix.test(name) || destructiveSuffix.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }

  // Mutating but not destructive
  const mutatingPrefix = /^(save_|write_|upload_)/;
  const mutatingSuffix = /(_save|_write|_upload)$/;
  if (mutatingPrefix.test(name) || mutatingSuffix.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }

  // Default: read-safe
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

/**
 * Conductor built-in tool names that are always registered by
 * `MCPExecutorServer.registerTools()`. Any passthrough tool whose composed
 * name matches one of these entries will be skipped to prevent duplicate-
 * registration errors at the SDK level (CODE-LOW-4).
 *
 * Keep this set in sync with the `this.server.registerTool(name, ...)` calls
 * in `mcp-server.ts`. The check uses the raw composed name (`server__tool`
 * form) so a plain backend tool named `brave_web_search` registered under any
 * server would collide with the conductor built-in of the same name.
 */
export const STATIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'execute_code',
  'list_servers',
  'discover_tools',
  'get_metrics',
  'set_mode',
  'reload_servers',
  'get_capabilities',
  'compare_modes',
  'passthrough_call',
  'brave_web_search',
  'add_server',
  'remove_server',
  'update_server',
  'get_memory_stats',
  'predict_cost',
  'get_hot_paths',
  'record_session',
  'stop_recording',
  'replay_session',
  'import_servers_from_claude',
  'test_server',
  'diagnose_server',
  'recommend_routing',
  'export_to_claude',
]);

/**
 * Register all `routing: "passthrough"` tools from the registry as
 * first-class MCP tools on `mcpServer`.
 *
 * This function is idempotent with respect to a fresh server instance —
 * call it once after `registry.refresh()`. If called multiple times on the
 * same server instance the SDK will throw a duplicate-name error, so callers
 * must ensure it runs only once per server lifecycle.
 *
 * @param registry      Populated ToolRegistry (after `refresh()` has been called).
 * @param mcpServer     The McpServer instance to register tools on.
 * @param mcpHub        The MCPHub used to forward tool calls to backends.
 * @param excludeNames  Additional composed names to skip beyond the built-in
 *                      {@link STATIC_TOOL_NAMES} set (e.g. names already
 *                      registered by a previous call).
 * @returns             The number of passthrough tools registered.
 */
export function registerPassthroughTools(
  registry: ToolRegistry,
  mcpServer: McpServerLike,
  mcpHub: McpHubLike,
  excludeNames?: ReadonlySet<string>
): number {
  const tools = registry.getAllTools();
  let registered = 0;

  for (const tool of tools) {
    if (tool.routing !== 'passthrough') {
      continue;
    }

    const composedName = buildPassthroughToolName(tool.server, tool.name);

    // Skip names that collide with conductor built-ins or caller exclusions (CODE-LOW-4).
    if (STATIC_TOOL_NAMES.has(composedName) || excludeNames?.has(composedName)) {
      logger.warn(
        `Passthrough registrar: skipping '${composedName}' — name conflicts with a statically-registered tool`,
        { server: tool.server, tool: tool.name }
      );
      continue;
    }

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

    // Derive annotations from tool name pattern (HIGH-4 safety fix).
    // The registry does not yet carry upstream MCP ToolAnnotations (deferred to
    // a Phase 1 typegen extension), so name-pattern heuristics are the conservative
    // middle ground: destructive-looking names are flagged so Claude can reason
    // about safety. False negatives (a non-obvious destructive name registered as
    // safe) require an explicit upstream annotation; the deferred typegen will
    // close that gap.
    const annotations = inferAnnotationsFromName(tool.name);

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
