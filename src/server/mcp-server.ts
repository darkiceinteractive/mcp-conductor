/**
 * MCP Executor Server
 *
 * Main MCP server that exposes the execute_code tool and other utilities.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { logger } from '../utils/index.js';
import { HttpBridge, type BridgeHandlers, type ServerInfo } from '../bridge/index.js';
import { DenoExecutor, type ExecutionResult } from '../runtime/index.js';
import { MCPHub } from '../hub/index.js';
import { ToolRegistry } from '../registry/registry.js';
import { applyBuiltInRecommendations } from '../registry/built-in-recommendations.js';
import { registerPassthroughTools } from './passthrough-registrar.js';
import { SkillsEngine, type SkillsEngineConfig } from '../skills/index.js';
import { ModeHandler, type ModeMetrics } from '../modes/index.js';
import { MetricsCollector } from '../metrics/index.js';
import { shutdownStreamManager } from '../streaming/index.js';
import { shutdownMetricsCollector } from '../metrics/index.js';
import { shutdownModeHandler } from '../modes/index.js';
import { shutdownSkillsEngine } from '../skills/index.js';
import type { MCPExecutorConfig, ExecutionMode, ConductorConfig } from '../config/index.js';
import { loadConductorConfig, saveConductorConfig, getDefaultConductorConfigPath } from '../config/index.js';
import { VERSION } from '../version.js';
import {
  getCostPredictor,
  getHotPathProfiler,
  getAnomalyDetector,
  getReplayRecorder,
  shutdownCostPredictor,
  shutdownHotPathProfiler,
  shutdownAnomalyDetector,
  shutdownReplayRecorder,
} from '../observability/index.js';
import {
  findClaudeConfigsWithServers,
  importServers,
  formatImportResults,
  stripServersFromConfig,
  writeBackup,
} from '../cli/commands/import-servers.js';
import { exportToClaude } from '../cli/commands/export-servers.js';
import { testServer } from '../cli/commands/test-server.js';
import { getRoutingRecommendations } from '../cli/commands/routing.js';

/**
 * MCP Executor Server
 */
export class MCPExecutorServer {
  private server: McpServer;
  private bridge: HttpBridge;
  private executor: DenoExecutor;
  private hub: MCPHub;
  private skills: SkillsEngine | null = null;
  private modeHandler: ModeHandler;
  private metricsCollector: MetricsCollector;
  private config: MCPExecutorConfig;
  private useMockServers: boolean;
  private currentMode: ExecutionMode;
  private registry: ToolRegistry;

  // Mock server data for testing when no real servers configured
  private mockServers: Map<string, { tools: Array<{ name: string; description: string }> }> = new Map();

  constructor(config: MCPExecutorConfig, options?: { useMockServers?: boolean }) {
    this.config = config;
    this.useMockServers = options?.useMockServers ?? false;
    this.currentMode = config.execution.mode;

    // Initialise mode handler
    this.modeHandler = new ModeHandler({
      defaultMode: config.execution.mode,
      hybridToolCallThreshold: 3,
      hybridDataThreshold: 5,
    });

    // Initialise metrics collector
    this.metricsCollector = new MetricsCollector(config.metrics);

    // Initialise MCP server with metadata
    this.server = new McpServer({
      name: 'mcp-conductor',
      title: 'MCP Conductor',
      version: VERSION,
      websiteUrl: 'https://github.com/darkiceinteractive/mcp-conductor',
      icons: [
        {
          // Conductor baton/orchestrator icon (SVG data URI)
          src: 'data:image/svg+xml;base64,' + Buffer.from(`
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="22" fill="#1a1a2e" stroke="#6366f1" stroke-width="2"/>
              <circle cx="24" cy="14" r="4" fill="#6366f1"/>
              <path d="M24 18 L24 34" stroke="#6366f1" stroke-width="3" stroke-linecap="round"/>
              <path d="M16 26 L24 22 L32 26" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M12 32 L24 26 L36 32" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="32" r="2" fill="#22d3ee"/>
              <circle cx="24" cy="26" r="2" fill="#22d3ee"/>
              <circle cx="36" cy="32" r="2" fill="#22d3ee"/>
              <circle cx="16" cy="26" r="1.5" fill="#34d399"/>
              <circle cx="32" cy="26" r="1.5" fill="#34d399"/>
            </svg>
          `).toString('base64'),
          mimeType: 'image/svg+xml',
          sizes: ['48x48', 'any'],
        },
      ],
    });

    // Initialise HTTP bridge
    this.bridge = new HttpBridge(config.bridge);

    // Initialise Deno executor
    this.executor = new DenoExecutor(config.sandbox);

    // Initialise MCP Hub for real server connections
    this.hub = new MCPHub({
      servers: config.servers,
      autoReconnect: true,
      reconnectDelayMs: 5000,
      maxReconnectAttempts: 3,
    });

    // Initialise the ToolRegistry backed by the hub.
    // registry.refresh() + registerPassthroughTools() are called in start()
    // after the hub has connected, so the registry is fully populated before
    // any passthrough tool handler can be invoked.
    this.registry = new ToolRegistry({ bridge: this.hub });

    // Set up mock servers for fallback/testing
    this.setupMockServers();

    // Register tools
    this.registerTools();
  }

  /**
   * Set up mock servers for testing/fallback
   */
  private setupMockServers(): void {
    // Mock filesystem server
    this.mockServers.set('filesystem', {
      tools: [
        { name: 'read_file', description: 'Read the contents of a file' },
        { name: 'write_file', description: 'Write content to a file' },
        { name: 'list_directory', description: 'List files in a directory' },
        { name: 'search_files', description: 'Search for files matching a pattern' },
      ],
    });

    // Mock echo server for testing
    this.mockServers.set('echo', {
      tools: [
        { name: 'echo', description: 'Echo back the input message' },
        { name: 'reverse', description: 'Reverse the input string' },
      ],
    });
  }

  /**
   * Register all MCP tools
   */
  /**
   * Record metrics + shape the execute_code tool response. Extracted so the
   * progress/cancel wiring in the handler stays readable.
   */
  private finaliseExecuteCodeResult(
    result: ExecutionResult,
    code: string,
    servers: string[] | undefined,
    verbose: boolean | undefined,
  ): { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown> } {
    const executionMetrics = this.metricsCollector.recordExecution({
      executionId: result.executionId,
      code,
      result: result.result,
      success: result.success,
      durationMs: result.metrics.executionTimeMs,
      toolCalls: result.metrics.toolCalls,
      dataProcessedBytes: result.metrics.dataProcessedBytes,
      resultSizeBytes: result.metrics.resultSizeBytes,
      mode: 'execution',
      serversUsed: servers || [],
      errorType: result.error?.type,
    });

    this.modeHandler.recordExecutionCall(executionMetrics.estimatedTokensSaved);

    const output: Record<string, unknown> = {
      success: result.success,
      result: result.result,
      error: result.error,
    };

    if (verbose) {
      output.metrics = {
        execution_time_ms: result.metrics.executionTimeMs,
        tool_calls: result.metrics.toolCalls,
        data_processed_bytes: result.metrics.dataProcessedBytes,
        result_size_bytes: result.metrics.resultSizeBytes,
        estimated_tokens_saved: executionMetrics.estimatedTokensSaved,
        savings_percent: executionMetrics.savingsPercent,
      };
      output.logs = result.logs;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }

  private registerTools(): void {
    // Register execute_code tool
    this.server.registerTool(
      'execute_code',
      {
        title: 'Execute Code',
        description: `Execute TypeScript/JavaScript code to perform MCP operations efficiently.

**Token Savings:** 90-98% vs individual tool calls. Batch operations in a single execution.

**API:** \`mcp.server('name').call('tool', params)\` | \`mcp.searchTools('query')\` | \`mcp.log('msg')\`

**Example:** \`const files = await mcp.filesystem.call('list_directory', { path: '/src' }); return files;\`

Use passthrough_call only for debugging - it has HIGH token cost.`,
        annotations: {
          // execute_code proxies arbitrary code that can call any backend MCP
          // tool, so it inherits the most permissive capability surface.
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          code: z.string().describe('TypeScript/JavaScript code to execute. Must include a return statement.'),
          servers: z.array(z.string()).optional().describe('Optional: List of MCP server names to load.'),
          timeout_ms: z.number().optional().describe('Maximum execution time in milliseconds. Default: 30000.'),
          stream: z.boolean().optional().describe('If true, stream progress updates. Default: false.'),
          verbose: z.boolean().optional().describe('If true, include detailed metrics in response. Default: false.'),
        },
        outputSchema: {
          success: z.boolean(),
          result: z.unknown().optional(),
          error: z.object({
            type: z.enum(['syntax', 'runtime', 'timeout', 'security']),
            message: z.string(),
            stack: z.string().optional(),
            line: z.number().optional(),
          }).optional(),
          metrics: z.object({
            execution_time_ms: z.number(),
            tool_calls: z.number(),
            data_processed_bytes: z.number(),
            result_size_bytes: z.number(),
            estimated_tokens_saved: z.number(),
          }).optional(),
          logs: z.array(z.string()).optional(),
        },
      },
      async ({ code, servers, timeout_ms, stream, verbose }, extra) => {
        const timeoutMs = Math.min(
          timeout_ms || this.config.execution.defaultTimeoutMs,
          this.config.execution.maxTimeoutMs
        );

        logger.info('Executing code', {
          codeLength: code.length,
          timeout: timeoutMs,
          servers: servers || 'all',
        });

        // If the client supplied a progressToken in _meta, forward sandbox
        // progress() calls as MCP notifications/progress. We preallocate the
        // execution id + stream so we never miss the first event.
        const progressToken = extra?._meta?.progressToken;
        const wantProgress = progressToken !== undefined;
        const wantStream = stream || wantProgress;
        const executionId = wantStream ? this.executor.generateExecutionId() : undefined;
        const execStream = executionId ? this.bridge.createStream(executionId) : undefined;

        const forwardProgress = (percent: number, message?: string): void => {
          if (!wantProgress || !extra?.sendNotification) return;
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: percent,
                total: 100,
                ...(message ? { message } : {}),
              },
            })
            .catch((err: unknown) => {
              logger.debug('Failed to forward progress notification', { error: String(err) });
            });
        };
        if (execStream && wantProgress) {
          execStream.on('progress', (ev: { data: { percent: number; message?: string } }) => {
            forwardProgress(ev.data.percent, ev.data.message);
          });
        }

        let result: ExecutionResult | undefined;
        try {
          result = await this.executor.execute(code, {
            timeoutMs,
            bridgeUrl: this.bridge.getUrl(),
            servers: servers || [],
            stream: wantStream,
            signal: extra?.signal,
            executionId,
          });
          return this.finaliseExecuteCodeResult(result, code, servers, verbose);
        } finally {
          if (execStream) {
            // Flip the stream out of `running` so StreamManager's normal
            // 5/10-min cleanup applies instead of the 15-min stuck-stream
            // sweep. Only fire complete() if we actually got a result —
            // if execute() threw, the stream will time out via the stuck
            // path which is the right safety net.
            if (result) {
              execStream.complete({
                success: result.success,
                result: result.result,
                error: result.error,
                metrics: {
                  executionTimeMs: result.metrics.executionTimeMs,
                  toolCalls: result.metrics.toolCalls,
                  dataProcessedBytes: result.metrics.dataProcessedBytes,
                },
              });
            }
            execStream.removeAllListeners('progress');
          }
        }
      }
    );

    // Register list_servers tool
    this.server.registerTool(
      'list_servers',
      {
        title: 'List Servers',
        description: 'List all MCP servers connected through MCP Executor.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          include_tools: z.boolean().optional().describe('If true, include list of tool names.'),
        },
        outputSchema: {
          servers: z.array(z.object({
            name: z.string(),
            status: z.enum(['connected', 'disconnected', 'error']),
            tool_count: z.number(),
            tools: z.array(z.string()).optional(),
          })),
          total_servers: z.number(),
          total_tools: z.number(),
        },
      },
      async ({ include_tools }) => {
        let servers: Array<{
          name: string;
          status: 'connected' | 'disconnected' | 'error';
          tool_count: number;
          tools?: string[];
        }>;

        if (this.useMockServers) {
          // Use mock servers for testing
          servers = Array.from(this.mockServers.entries()).map(([name, data]) => ({
            name,
            status: 'connected' as const,
            tool_count: data.tools.length,
            tools: include_tools ? data.tools.map((t) => t.name) : undefined,
          }));
        } else {
          // Use real hub servers
          servers = this.hub.listServers().map((s) => ({
            name: s.name,
            status: s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : 'disconnected',
            tool_count: s.toolCount,
            tools: include_tools ? this.hub.getServerTools(s.name).map((t) => t.name) : undefined,
          }));
        }

        const totalTools = servers.reduce((sum, s) => sum + s.tool_count, 0);

        const output = {
          servers,
          total_servers: servers.length,
          total_tools: totalTools,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register discover_tools tool
    this.server.registerTool(
      'discover_tools',
      {
        title: 'Discover Tools',
        description: 'Search for available tools across all connected MCP servers.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          query: z.string().optional().describe('Search query. Matches against tool names and descriptions.'),
          server: z.string().optional().describe('Optional: limit search to a specific server.'),
          limit: z.number().optional().describe('Maximum results to return. Default: 20.'),
        },
        outputSchema: {
          results: z.array(z.object({
            server: z.string(),
            tool: z.string(),
            description: z.string(),
            relevance: z.number(),
          })),
          total_matches: z.number(),
          servers_searched: z.number(),
        },
      },
      async ({ query, server, limit }) => {
        const maxResults = limit || 20;
        const results: Array<{ server: string; tool: string; description: string; relevance: number }> = [];
        const searchLower = (query || '').toLowerCase();
        let serversSearched = 0;

        if (this.useMockServers) {
          // Search mock servers
          for (const [serverName, data] of this.mockServers.entries()) {
            if (server && serverName !== server) continue;
            serversSearched++;

            for (const tool of data.tools) {
              const nameMatch = tool.name.toLowerCase().includes(searchLower);
              const descMatch = tool.description.toLowerCase().includes(searchLower);

              if (!query || nameMatch || descMatch) {
                const relevance = nameMatch ? 1.0 : descMatch ? 0.7 : 0.5;
                results.push({
                  server: serverName,
                  tool: tool.name,
                  description: tool.description,
                  relevance,
                });
              }
            }
          }
        } else {
          // Search real hub servers
          const hubServers = this.hub.listServers();
          for (const hubServer of hubServers) {
            if (server && hubServer.name !== server) continue;
            serversSearched++;

            const tools = this.hub.getServerTools(hubServer.name);
            for (const tool of tools) {
              const nameMatch = tool.name.toLowerCase().includes(searchLower);
              const descMatch = (tool.description || '').toLowerCase().includes(searchLower);

              if (!query || nameMatch || descMatch) {
                const relevance = nameMatch ? 1.0 : descMatch ? 0.7 : 0.5;
                results.push({
                  server: hubServer.name,
                  tool: tool.name,
                  description: tool.description || '',
                  relevance,
                });
              }
            }
          }
        }

        // Sort by relevance and limit
        results.sort((a, b) => b.relevance - a.relevance);
        const limited = results.slice(0, maxResults);

        const output = {
          results: limited,
          total_matches: results.length,
          servers_searched: serversSearched,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register get_metrics tool
    this.server.registerTool(
      'get_metrics',
      {
        title: 'Get Metrics',
        description: 'Get detailed aggregated metrics for the current session including token savings, performance, and usage patterns.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          reset: z.boolean().optional().describe('Reset metrics after returning.'),
          include_details: z.boolean().optional().describe('Include detailed breakdowns (servers, tools, recent executions).'),
        },
        outputSchema: {
          session: z.object({
            session_id: z.string(),
            session_start: z.string(),
            uptime_ms: z.number(),
          }),
          executions: z.object({
            total: z.number(),
            successful: z.number(),
            failed: z.number(),
          }),
          tokens: z.object({
            total_saved: z.number(),
            average_saved: z.number(),
            average_savings_percent: z.number(),
          }),
          performance: z.object({
            average_duration_ms: z.number(),
            min_duration_ms: z.number(),
            max_duration_ms: z.number(),
          }),
          data: z.object({
            total_processed_bytes: z.number(),
            total_result_bytes: z.number(),
          }),
          mode_breakdown: z.object({
            execution_calls: z.number(),
            passthrough_calls: z.number(),
          }),
          current_mode: z.enum(['execution', 'passthrough', 'hybrid']),
          details: z.object({
            top_servers: z.array(z.object({ server: z.string(), calls: z.number() })).optional(),
            top_tools: z.array(z.object({ tool: z.string(), calls: z.number() })).optional(),
            recent_executions: z.array(z.object({
              execution_id: z.string(),
              success: z.boolean(),
              duration_ms: z.number(),
              tokens_saved: z.number(),
            })).optional(),
          }).optional(),
        },
      },
      async ({ reset, include_details }) => {
        const sessionMetrics = this.metricsCollector.getSessionMetrics();

        const output: Record<string, unknown> = {
          session: {
            session_id: sessionMetrics.sessionId,
            session_start: sessionMetrics.sessionStart.toISOString(),
            uptime_ms: sessionMetrics.uptime,
          },
          executions: {
            total: sessionMetrics.totalExecutions,
            successful: sessionMetrics.successfulExecutions,
            failed: sessionMetrics.failedExecutions,
          },
          tokens: {
            total_saved: sessionMetrics.totalTokensSaved,
            average_saved: Math.round(sessionMetrics.averageTokensSaved),
            average_savings_percent: Math.round(sessionMetrics.averageSavingsPercent),
          },
          performance: {
            average_duration_ms: Math.round(sessionMetrics.averageDurationMs),
            min_duration_ms: sessionMetrics.minDurationMs,
            max_duration_ms: sessionMetrics.maxDurationMs,
          },
          data: {
            total_processed_bytes: sessionMetrics.totalDataProcessedBytes,
            total_result_bytes: sessionMetrics.totalResultBytes,
          },
          mode_breakdown: {
            execution_calls: sessionMetrics.executionModeCount,
            passthrough_calls: sessionMetrics.passthroughModeCount,
          },
          current_mode: this.currentMode,
        };

        // Include detailed breakdowns if requested
        if (include_details) {
          const topServers = this.metricsCollector.getTopServers(5);
          const topTools = this.metricsCollector.getTopTools(5);
          const recentExecutions = this.metricsCollector.getRecentExecutions(5);

          output['details'] = {
            top_servers: topServers,
            top_tools: topTools,
            recent_executions: recentExecutions.map(e => ({
              execution_id: e.executionId,
              success: e.success,
              duration_ms: e.durationMs,
              tokens_saved: e.estimatedTokensSaved,
            })),
          };
        }

        if (reset) {
          this.metricsCollector.reset();
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register set_mode tool
    this.server.registerTool(
      'set_mode',
      {
        title: 'Set Operation Mode',
        description: `Switch between operation modes:
- execution: All requests go through the code executor (default, maximum token savings)
- passthrough: Direct tool calls without code execution (for debugging/comparison)
- hybrid: Automatic selection based on task complexity`,
        annotations: {
          // Changes global server behaviour; future tool calls take the new path.
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          mode: z.enum(['execution', 'passthrough', 'hybrid']).describe('The operation mode to switch to.'),
        },
        outputSchema: {
          previous_mode: z.enum(['execution', 'passthrough', 'hybrid']),
          current_mode: z.enum(['execution', 'passthrough', 'hybrid']),
          message: z.string(),
        },
      },
      async ({ mode }) => {
        const previousMode = this.currentMode;
        this.currentMode = mode;
        this.modeHandler.setMode(mode);

        const output = {
          previous_mode: previousMode,
          current_mode: mode,
          message: `Mode changed from '${previousMode}' to '${mode}'`,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register reload_servers tool
    this.server.registerTool(
      'reload_servers',
      {
        title: 'Reload Servers',
        description: 'Reload MCP server configurations. Useful after modifying claude_desktop_config.json.',
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {},
        outputSchema: {
          added: z.array(z.string()),
          removed: z.array(z.string()),
          total_servers: z.number(),
          message: z.string(),
        },
      },
      async () => {
        const result = await this.reloadServers();

        const output = {
          added: result.added,
          removed: result.removed,
          total_servers: this.hub.getStats().total,
          message: `Reloaded servers. Added: ${result.added.length}, Removed: ${result.removed.length}`,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register get_capabilities tool
    this.server.registerTool(
      'get_capabilities',
      {
        title: 'Get Capabilities',
        description: 'Get detailed information about MCP Executor capabilities and configuration.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {},
        outputSchema: {
          version: z.string(),
          current_mode: z.enum(['execution', 'passthrough', 'hybrid']),
          features: z.object({
            streaming: z.boolean(),
            hot_reload: z.boolean(),
            skills: z.boolean(),
          }),
          limits: z.object({
            max_timeout_ms: z.number(),
            default_timeout_ms: z.number(),
            max_memory_mb: z.number(),
          }),
          servers: z.object({
            total: z.number(),
            connected: z.number(),
          }),
          skills: z.object({
            loaded: z.number(),
            categories: z.array(z.string()),
          }),
        },
      },
      async () => {
        const hubStats = this.hub.getStats();
        const skillsInfo = this.skills
          ? { loaded: this.skills.getSkillCount(), categories: this.skills.getCategories() }
          : { loaded: 0, categories: [] };

        const output = {
          version: VERSION,
          current_mode: this.currentMode,
          features: {
            streaming: this.config.execution.streamingEnabled,
            hot_reload: this.config.hotReload.enabled,
            skills: this.skills !== null && this.skills.isLoaded(),
          },
          limits: {
            max_timeout_ms: this.config.execution.maxTimeoutMs,
            default_timeout_ms: this.config.execution.defaultTimeoutMs,
            max_memory_mb: this.config.sandbox.maxMemoryMb,
          },
          servers: {
            total: hubStats.total,
            connected: hubStats.connected,
          },
          skills: skillsInfo,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register compare_modes tool
    this.server.registerTool(
      'compare_modes',
      {
        title: 'Compare Modes',
        description: `Analyse how a task would be handled in different modes.
Returns estimated token usage and approach for each mode.`,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          task_description: z.string().describe('Description of the task to analyse.'),
          estimated_tool_calls: z.number().optional().describe('Estimated number of tool calls needed.'),
          estimated_data_kb: z.number().optional().describe('Estimated data to process in KB.'),
        },
        outputSchema: {
          task: z.string(),
          modes: z.object({
            execution: z.object({
              approach: z.string(),
              estimated_tokens: z.number(),
              advantages: z.array(z.string()),
            }),
            passthrough: z.object({
              approach: z.string(),
              estimated_tokens: z.number(),
              advantages: z.array(z.string()),
            }),
          }),
          recommendation: z.string(),
          token_savings_percent: z.number(),
        },
      },
      async ({ task_description, estimated_tool_calls, estimated_data_kb }) => {
        const toolCalls = estimated_tool_calls || 5;
        const dataKb = estimated_data_kb || 10;

        // Estimate tokens for passthrough mode
        // Each tool call involves request + response in context
        const tokensPerToolCall = 200; // Average tokens per tool call overhead
        const tokensPerKb = 250; // Approximate tokens per KB of data
        const passthroughTokens = (toolCalls * tokensPerToolCall) + (dataKb * tokensPerKb);

        // Estimate tokens for execution mode
        // Code + summarised result
        const codeTokens = 100; // Typical code block
        const resultTokens = 50; // Summarised result
        const executionTokens = codeTokens + resultTokens;

        const savingsPercent = Math.round(((passthroughTokens - executionTokens) / passthroughTokens) * 100);

        const output = {
          task: task_description,
          modes: {
            execution: {
              approach: 'Write code that processes data and returns only the relevant summary',
              estimated_tokens: executionTokens,
              advantages: [
                'Minimal context usage',
                'Data processing happens in sandbox',
                'Only final result returned to context',
                'Can handle large datasets efficiently',
              ],
            },
            passthrough: {
              approach: 'Make direct tool calls with full results in context',
              estimated_tokens: passthroughTokens,
              advantages: [
                'Simpler for quick, single tool calls',
                'No code writing overhead',
                'Direct access to full tool responses',
                'Better for debugging',
              ],
            },
          },
          recommendation: savingsPercent > 50
            ? 'Use execution mode for significant token savings'
            : savingsPercent > 20
            ? 'Execution mode recommended for moderate savings'
            : 'Passthrough mode may be simpler for this task',
          token_savings_percent: Math.max(0, savingsPercent),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register passthrough_call tool for direct tool invocations
    this.server.registerTool(
      'passthrough_call',
      {
        title: 'Passthrough Call',
        description: `⚠️ DEBUGGING TOOL - Direct MCP tool call. HIGH TOKEN COST (10-100x vs execute_code).

Only use for debugging raw tool input/output. Use execute_code for all normal operations.`,
        annotations: {
          // Proxies into a backend MCP server so the effect depends on the
          // downstream tool. Conservative defaults: assume external + mutable.
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          server: z.string().describe('Name of the MCP server to call.'),
          tool: z.string().describe('Name of the tool to invoke.'),
          params: z.record(z.unknown()).optional().describe('Parameters to pass to the tool.'),
        },
        outputSchema: {
          success: z.boolean(),
          result: z.unknown().optional(),
          error: z.string().optional(),
          metrics: z.object({
            duration_ms: z.number(),
            mode: z.enum(['passthrough', 'hybrid']),
          }),
        },
      },
      async ({ server, tool, params }) => {
        const startTime = Date.now();
        const passthroughId = `passthrough_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Check mode - warn if in execution mode
        if (this.currentMode === 'execution') {
          logger.warn('passthrough_call used in execution mode', { server, tool });
        }

        try {
          let result: unknown;

          if (this.useMockServers) {
            // Use mock handlers for testing
            const mockServer = this.mockServers.get(server);
            if (!mockServer) {
              throw new Error(`Server not found: ${server}`);
            }
            const mockTool = mockServer.tools.find((t) => t.name === tool);
            if (!mockTool) {
              throw new Error(`Tool not found: ${server}.${tool}`);
            }

            // Mock implementations
            if (server === 'echo' && tool === 'echo') {
              result = { message: (params as Record<string, unknown>)?.['message'] || '' };
            } else if (server === 'echo' && tool === 'reverse') {
              const msg = String((params as Record<string, unknown>)?.['message'] || '');
              result = { reversed: msg.split('').reverse().join('') };
            } else if (server === 'filesystem') {
              if (tool === 'list_directory') {
                result = { entries: [{ name: 'file1.ts', type: 'file' }] };
              } else if (tool === 'read_file') {
                result = { content: '// Mock file content' };
              }
            } else {
              throw new Error(`Mock not implemented: ${server}.${tool}`);
            }
          } else {
            // Use real hub
            result = await this.hub.callTool(server, tool, params || {});
          }

          const durationMs = Date.now() - startTime;

          // Record successful passthrough execution
          const resultStr = JSON.stringify(result);
          this.metricsCollector.recordExecution({
            executionId: passthroughId,
            code: '', // No code for passthrough
            result,
            success: true,
            durationMs,
            toolCalls: 1,
            dataProcessedBytes: resultStr.length,
            resultSizeBytes: resultStr.length,
            mode: 'passthrough',
            serversUsed: [server],
            toolsUsed: [`${server}.${tool}`],
          });

          // Track with mode handler
          this.modeHandler.recordPassthroughCall({
            server,
            tool,
            params: params || {},
            success: true,
            durationMs,
          });

          const output: Record<string, unknown> = {
            success: true,
            result,
            metrics: {
              duration_ms: durationMs,
              mode: this.currentMode === 'hybrid' ? 'hybrid' as const : 'passthrough' as const,
            },
          };

          // Add warning when used in execution mode
          if (this.currentMode === 'execution') {
            output['warning'] = '⚠️ INEFFICIENT: You used passthrough_call in execution mode. Use execute_code instead for 90%+ token savings. Each passthrough_call adds full request/response JSON to context.';
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          const durationMs = Date.now() - startTime;

          // Record failed passthrough execution
          this.metricsCollector.recordExecution({
            executionId: passthroughId,
            code: '', // No code for passthrough
            result: null,
            success: false,
            durationMs,
            toolCalls: 1,
            dataProcessedBytes: 0,
            resultSizeBytes: 0,
            mode: 'passthrough',
            serversUsed: [server],
            toolsUsed: [`${server}.${tool}`],
            errorType: 'runtime',
          });

          // Track with mode handler
          this.modeHandler.recordPassthroughCall({
            server,
            tool,
            params: params || {},
            success: false,
            error: String(error),
            durationMs,
          });

          const output = {
            success: false,
            error: String(error),
            metrics: {
              duration_ms: durationMs,
              mode: this.currentMode === 'hybrid' ? 'hybrid' as const : 'passthrough' as const,
            },
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
      }
    );

    // Register brave_web_search tool - direct access to Brave Search API
    // This provides a token-efficient alternative to native WebSearch
    this.server.registerTool(
      'brave_web_search',
      {
        title: 'Brave Web Search',
        description: `Web search via Brave Search API. Uses 90% fewer tokens than native WebSearch.

Routes to brave-search MCP server internally. Requires brave-search server to be configured.`,
        annotations: {
          readOnlyHint: true,
          idempotentHint: false, // Web results change between calls
          openWorldHint: true,
        },
        inputSchema: {
          query: z.string().describe('Search query (max 400 chars, 50 words).'),
          count: z.number().optional().describe('Number of results (1-20, default 10).'),
        },
        outputSchema: {
          success: z.boolean(),
          results: z.array(z.object({
            title: z.string(),
            description: z.string(),
            url: z.string(),
          })).optional(),
          error: z.string().optional(),
        },
      },
      async ({ query, count }) => {
        const resultCount = Math.min(count || 10, 20);

        try {
          // Route to brave-search MCP server
          const rawResult = await this.hub.callTool('brave-search', 'brave_web_search', {
            query,
            count: resultCount,
          });

          // Parse the text response from brave-search into structured results
          const parseResults = (text: unknown): Array<{ title: string; description: string; url: string }> => {
            if (typeof text !== 'string' || text.startsWith('Error:')) return [];
            return text.split(/\n\nTitle:/).map((block: string, i: number) => {
              const b = i === 0 ? block : 'Title:' + block;
              const title = b.match(/Title:\s*([^\n]+)/)?.[1]?.trim() || '';
              const url = b.match(/URL:\s*([^\n]+)/)?.[1]?.trim() || '';
              const desc = b.match(/Description:\s*([^\n]+)/)?.[1]?.trim() || '';
              return title && url ? { title, description: desc, url } : null;
            }).filter((r): r is { title: string; description: string; url: string } => r !== null);
          };

          const results = parseResults(rawResult);

          const output = {
            success: true,
            results,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          const output = {
            success: false,
            error: `Brave search failed: ${String(error)}. Ensure brave-search server is configured.`,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
      }
    );

    // Register add_server tool for runtime server management
    this.server.registerTool(
      'add_server',
      {
        title: 'Add Server',
        description: `Add a new MCP server to conductor config and connect immediately.

Saves the server configuration to ~/.mcp-conductor.json and triggers a reload.
Use this to dynamically add servers without restarting Claude.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false, // Adds a new server; not destructive by itself
          idempotentHint: false, // Re-adding the same name returns an error
          openWorldHint: false,
        },
        inputSchema: {
          name: z.string().describe('Unique server name (e.g., "github", "filesystem").'),
          command: z.string().describe('Command to run the server (e.g., "npx", "node", "python").'),
          args: z.array(z.string()).optional().describe('Command arguments (e.g., ["-y", "@modelcontextprotocol/server-github"]).'),
          env: z.record(z.string()).optional().describe('Environment variables for the server (e.g., { "GITHUB_TOKEN": "..." }).'),
        },
        outputSchema: {
          success: z.boolean(),
          server_name: z.string(),
          config_path: z.string(),
          message: z.string(),
          servers_after: z.number(),
        },
      },
      async ({ name, command, args, env }) => {
        try {
          // Load existing conductor config or create new one
          let config = loadConductorConfig();
          if (!config) {
            config = {
              exclusive: false,
              servers: {},
            };
          }

          // Check if server already exists
          if (config.servers[name]) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: `Server '${name}' already exists. Use remove_server first to replace it.`,
                servers_after: Object.keys(config.servers).length,
              }, null, 2) }],
            };
          }

          // Add new server
          config.servers[name] = {
            command,
            args: args || [],
            env: env || {},
          };

          // Save config
          const saveResult = saveConductorConfig(config);
          if (!saveResult.success) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: saveResult.path,
                message: `Failed to save config: ${saveResult.error}`,
                servers_after: Object.keys(config.servers).length - 1,
              }, null, 2) }],
            };
          }

          // Reload servers to connect to the new one
          const reloadResult = await this.reloadServers();

          const output = {
            success: true,
            server_name: name,
            config_path: saveResult.path,
            message: `Server '${name}' added successfully. ${reloadResult.added.includes(name) ? 'Connected.' : 'Will connect on next initialisation.'}`,
            servers_after: Object.keys(config.servers).length,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              server_name: name,
              config_path: getDefaultConductorConfigPath(),
              message: `Error adding server: ${String(error)}`,
              servers_after: 0,
            }, null, 2) }],
          };
        }
      }
    );

    // Register remove_server tool for runtime server management
    this.server.registerTool(
      'remove_server',
      {
        title: 'Remove Server',
        description: `Remove an MCP server from conductor config and disconnect it.

Removes the server configuration from ~/.mcp-conductor.json and triggers a reload.
Use this to dynamically remove servers without restarting Claude.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true, // Removing an already-gone server is a safe no-op
          openWorldHint: false,
        },
        inputSchema: {
          name: z.string().describe('Name of the server to remove.'),
        },
        outputSchema: {
          success: z.boolean(),
          server_name: z.string(),
          config_path: z.string(),
          message: z.string(),
          servers_after: z.number(),
        },
      },
      async ({ name }) => {
        try {
          // Load existing conductor config
          const config = loadConductorConfig();
          if (!config) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: 'No conductor config found. Nothing to remove.',
                servers_after: 0,
              }, null, 2) }],
            };
          }

          // Check if server exists
          if (!config.servers[name]) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: `Server '${name}' not found in conductor config.`,
                servers_after: Object.keys(config.servers).length,
              }, null, 2) }],
            };
          }

          // Remove server
          delete config.servers[name];

          // Save config
          const saveResult = saveConductorConfig(config);
          if (!saveResult.success) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: saveResult.path,
                message: `Failed to save config: ${saveResult.error}`,
                servers_after: Object.keys(config.servers).length + 1,
              }, null, 2) }],
            };
          }

          // Reload servers to disconnect the removed one
          const reloadResult = await this.reloadServers();

          const output = {
            success: true,
            server_name: name,
            config_path: saveResult.path,
            message: `Server '${name}' removed successfully. ${reloadResult.removed.includes(name) ? 'Disconnected.' : 'Will be removed on next initialisation.'}`,
            servers_after: Object.keys(config.servers).length,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              server_name: name,
              config_path: getDefaultConductorConfigPath(),
              message: `Error removing server: ${String(error)}`,
              servers_after: 0,
            }, null, 2) }],
          };
        }
      }
    );

    // Register update_server tool for updating server config (e.g., API keys)
    this.server.registerTool(
      'update_server',
      {
        title: 'Update Server',
        description: `Update an existing MCP server's configuration (command, args, or env vars).

Use this to update API keys or other settings without removing and re-adding the server.
Triggers a reload to apply changes immediately.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true, // Overwrites existing config; may disconnect/reconnect
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          name: z.string().describe('Name of the server to update.'),
          command: z.string().optional().describe('New command (optional, keeps existing if not provided).'),
          args: z.array(z.string()).optional().describe('New arguments (optional, keeps existing if not provided).'),
          env: z.record(z.string()).optional().describe('Environment variables to update (merges with existing).'),
          replace_env: z.boolean().optional().describe('If true, replace all env vars instead of merging (default: false).'),
        },
        outputSchema: {
          success: z.boolean(),
          server_name: z.string(),
          config_path: z.string(),
          message: z.string(),
          updated_fields: z.array(z.string()),
        },
      },
      async ({ name, command, args, env, replace_env }) => {
        try {
          // Load existing conductor config
          const config = loadConductorConfig();
          if (!config) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: 'No conductor config found.',
                updated_fields: [],
              }, null, 2) }],
            };
          }

          // Check if server exists
          if (!config.servers[name]) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: `Server '${name}' not found. Use add_server to create it first.`,
                updated_fields: [],
              }, null, 2) }],
            };
          }

          const updatedFields: string[] = [];
          const serverConfig = config.servers[name];

          // Update command if provided
          if (command !== undefined) {
            serverConfig.command = command;
            updatedFields.push('command');
          }

          // Update args if provided
          if (args !== undefined) {
            serverConfig.args = args;
            updatedFields.push('args');
          }

          // Update env vars
          if (env !== undefined) {
            if (replace_env) {
              serverConfig.env = env;
              updatedFields.push('env (replaced)');
            } else {
              serverConfig.env = { ...serverConfig.env, ...env };
              updatedFields.push(`env (merged: ${Object.keys(env).join(', ')})`);
            }
          }

          if (updatedFields.length === 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: getDefaultConductorConfigPath(),
                message: 'No fields to update. Provide command, args, or env.',
                updated_fields: [],
              }, null, 2) }],
            };
          }

          // Save config
          const saveResult = saveConductorConfig(config);
          if (!saveResult.success) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                success: false,
                server_name: name,
                config_path: saveResult.path,
                message: `Failed to save config: ${saveResult.error}`,
                updated_fields: [],
              }, null, 2) }],
            };
          }

          // Reload servers to apply changes
          await this.reloadServers();

          const output = {
            success: true,
            server_name: name,
            config_path: saveResult.path,
            message: `Server '${name}' updated successfully. Changes applied.`,
            updated_fields: updatedFields,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              server_name: name,
              config_path: getDefaultConductorConfigPath(),
              message: `Error updating server: ${String(error)}`,
              updated_fields: [],
            }, null, 2) }],
          };
        }
      }
    );

    // Register get_memory_stats tool for runtime diagnostics
    this.server.registerTool(
      'get_memory_stats',
      {
        title: 'Get Memory Stats',
        description: 'Returns live memory usage and resource counts for the conductor process. Use this to diagnose memory issues.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {},
        outputSchema: {
          heap_used_mb: z.number(),
          heap_total_mb: z.number(),
          rss_mb: z.number(),
          external_mb: z.number(),
          array_buffers_mb: z.number(),
          active_deno_processes: z.number(),
          connected_servers: z.object({
            total: z.number(),
            connected: z.number(),
            error: z.number(),
            disconnected: z.number(),
          }),
          active_streams: z.number(),
          uptime_seconds: z.number(),
        },
      },
      async () => {
        const mem = process.memoryUsage();
        const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;

        const { getStreamManager } = await import('../streaming/index.js');
        const streamManager = getStreamManager();

        const output = {
          heap_used_mb: toMB(mem.heapUsed),
          heap_total_mb: toMB(mem.heapTotal),
          rss_mb: toMB(mem.rss),
          external_mb: toMB(mem.external),
          array_buffers_mb: toMB(mem.arrayBuffers),
          active_deno_processes: this.executor.getActiveProcessCount(),
          connected_servers: this.hub.getStats(),
          active_streams: streamManager.getStreamCount(),
          uptime_seconds: Math.round(process.uptime()),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }
    );
    // Register predict_cost tool
    this.server.registerTool(
      'predict_cost',
      {
        title: 'Predict Cost',
        description: 'Predict the token cost and latency of executing code based on historical samples for similar call patterns.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          code: z.string().describe('The code whose cost you want to estimate.'),
        },
        outputSchema: {
          estimatedInputTokens: z.number(),
          estimatedOutputTokens: z.number(),
          estimatedLatencyMs: z.number(),
          basedOn: z.number(),
          available: z.boolean(),
        },
      },
      async ({ code }) => {
        const predictor = getCostPredictor();
        const prediction = predictor.predictFromCode(code);
        const output = prediction
          ? { ...prediction, available: true }
          : { estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedLatencyMs: 0, basedOn: 0, available: false };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register get_hot_paths tool
    this.server.registerTool(
      'get_hot_paths',
      {
        title: 'Get Hot Paths',
        description: 'Return the top-K tool call paths by total latency or p99 within a rolling time window.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          sinceMs: z.number().optional().describe('Only include calls made in the last N milliseconds.'),
          topK: z.number().optional().describe('Maximum number of paths to return (default: 10).'),
          sortBy: z.enum(['totalLatency', 'p99', 'callCount']).optional().describe('Ranking dimension (default: totalLatency).'),
        },
        outputSchema: {
          paths: z.array(z.object({
            server: z.string(),
            tool: z.string(),
            callCount: z.number(),
            totalLatencyMs: z.number(),
            meanLatencyMs: z.number(),
            p99LatencyMs: z.number(),
          })),
        },
      },
      async ({ sinceMs, topK, sortBy }) => {
        const profiler = getHotPathProfiler();
        const paths = profiler.getHotPaths({
          sinceMs,
          topK: topK ?? 10,
          sortBy: sortBy ?? 'totalLatency',
        });
        const output = { paths };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // Register record_session tool
    this.server.registerTool(
      'record_session',
      {
        title: 'Record Session',
        description: 'Start recording all tool calls in the current session to a replay journal.',
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          sessionId: z.string().optional().describe('Optional session ID. A UUID is generated if omitted.'),
        },
        outputSchema: {
          sessionId: z.string(),
          recordingPath: z.string(),
        },
      },
      async ({ sessionId }) => {
        const recorder = getReplayRecorder();
        const result = recorder.startRecording(sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );

    // Register stop_recording tool
    this.server.registerTool(
      'stop_recording',
      {
        title: 'Stop Recording',
        description: 'Stop an active recording session and finalise the replay journal.',
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          sessionId: z.string().describe('Session ID returned by record_session.'),
        },
        outputSchema: {
          recordingPath: z.string(),
          eventCount: z.number(),
        },
      },
      async ({ sessionId }) => {
        const recorder = getReplayRecorder();
        const result = recorder.stopRecording(sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );

    // Register replay_session tool
    this.server.registerTool(
      'replay_session',
      {
        title: 'Replay Session',
        description: 'Replay a recorded session, optionally applying modifications. Detects divergence when replayed result differs from recorded result.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          recordingPath: z.string().describe('Path to the .jsonl recording file.'),
          modifications: z.array(z.object({
            at: z.number().describe('Zero-based sequence index to target.'),
            op: z.enum(['replace', 'skip']).describe('Operation: replace the result or skip the event.'),
            with: z.unknown().optional().describe('Replacement value for replace operation.'),
          })).optional().describe('Optional list of modifications to apply during replay.'),
        },
        outputSchema: {
          result: z.unknown(),
          divergence: z.object({
            at: z.number(),
            expected: z.unknown(),
            actual: z.unknown(),
          }).optional(),
        },
      },
      async ({ recordingPath, modifications }) => {
        const recorder = getReplayRecorder();
        const { result, divergence } = recorder.replay(recordingPath, modifications ?? []);
        const output = { result, divergence };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
    );

    // ------------------------------------------------------------------
    // Lifecycle tools (Workstream X2)
    // ------------------------------------------------------------------

    // import_servers_from_claude
    this.server.registerTool(
      'import_servers_from_claude',
      {
        title: 'Import Servers from Claude',
        description: `Import MCP servers from Claude config files into ~/.mcp-conductor.json.

Reads ~/.claude/settings.json, ~/Library/Application Support/Claude/claude_desktop_config.json and other standard paths.
Shows a diff of what will be imported. On confirm=true, copies entries into the conductor config and writes .bak backups of each source file.
Optionally strips the imported servers from their source configs.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          confirm: z.boolean().optional().default(false).describe('Set true to actually perform the import. False (default) shows a dry-run diff.'),
          remove_originals: z.boolean().optional().default(false).describe('After import, remove the imported servers from their source Claude config files.'),
        },
        outputSchema: {
          dry_run: z.boolean(),
          sources_found: z.number(),
          total_imported: z.number(),
          total_skipped: z.number(),
          summary: z.string(),
        },
      },
      async ({ confirm: doImport, remove_originals }) => {
        const sources = findClaudeConfigsWithServers();
        if (sources.length === 0) {
          const output = { dry_run: !doImport, sources_found: 0, total_imported: 0, total_skipped: 0, summary: 'No Claude config files with MCP servers found.' };
          return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
        }

        const results = importServers({
          yes: true,
          removeOriginals: remove_originals ?? false,
          dryRun: !doImport,
        });

        const totalImported = results.reduce((sum, r) => sum + r.imported.length, 0);
        const totalSkipped = results.reduce((sum, r) => sum + r.skipped.length, 0);
        const summary = formatImportResults(results, !doImport);

        const output = {
          dry_run: !doImport,
          sources_found: sources.length,
          total_imported: totalImported,
          total_skipped: totalSkipped,
          summary,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
      }
    );

    // test_server
    this.server.registerTool(
      'test_server',
      {
        title: 'Test Server',
        description: `Transiently connect to an MCP server, list its tools and measure latency.
Does NOT persist the connection or register the server. Safe to call on any server definition.
Provide either a name (looks up conductor config) or command+args directly.`,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          name: z.string().optional().describe('Server name in conductor config to test.'),
          command: z.string().optional().describe('Direct command to run (bypasses config lookup).'),
          args: z.array(z.string()).optional().describe('Arguments for the command.'),
          env: z.record(z.string()).optional().describe('Environment variables for the command.'),
          timeout_ms: z.number().optional().default(15000).describe('Connection timeout in milliseconds.'),
        },
        outputSchema: {
          success: z.boolean(),
          server_name: z.string(),
          connected: z.boolean(),
          tool_count: z.number(),
          tools: z.array(z.object({ name: z.string(), description: z.string() })),
          latency_ms: z.number(),
          error: z.string().optional(),
        },
      },
      async ({ name, command, args, env, timeout_ms }) => {
        const result = await testServer({ name, command, args, env, timeoutMs: timeout_ms ?? 15000 });
        const output = {
          success: result.success,
          server_name: result.serverName,
          connected: result.connected,
          tool_count: result.toolCount,
          tools: result.tools,
          latency_ms: result.latencyMs,
          ...(result.error ? { error: result.error } : {}),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
      }
    );

    // diagnose_server
    this.server.registerTool(
      'diagnose_server',
      {
        title: 'Diagnose Server',
        description: `Diagnose a registered MCP server: process health, connection status, recent errors, reconnect attempts, last successful call, and registry state.
Returns actionable information about why a server may be failing.`,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          name: z.string().describe('Server name to diagnose (must be in conductor config).'),
        },
        outputSchema: {
          server_name: z.string(),
          status: z.string(),
          tool_count: z.number(),
          connected_at: z.string().optional(),
          last_error: z.string().optional(),
          reconnect_attempts: z.number(),
          is_connected: z.boolean(),
          registry_state: z.object({
            in_config: z.boolean(),
            command: z.string().optional(),
          }),
          suggestions: z.array(z.string()),
        },
      },
      async ({ name }) => {
        const servers = this.hub.listServers();
        const found = servers.find((s) => s.name === name);

        const conductorConfig = loadConductorConfig();
        const inConfig = !!(conductorConfig?.servers[name]);
        const configEntry = conductorConfig?.servers[name];

        const suggestions: string[] = [];
        if (!found && !inConfig) {
          suggestions.push(`Server '${name}' is not in conductor config. Add it with add_server or import_servers_from_claude.`);
        } else if (!found) {
          suggestions.push(`Server '${name}' is in config but not connected. Try reload_servers or restart conductor.`);
        } else if (found.status === 'error') {
          suggestions.push(`Server has error status: ${found.lastError ?? 'unknown'}. Check the command path and env vars.`);
          suggestions.push('Run test_server to verify connectivity.');
        } else if (found.status === 'disconnected') {
          suggestions.push('Server is disconnected. Conductor will auto-reconnect; or call reload_servers.');
        }

        const output = {
          server_name: name,
          status: found?.status ?? 'not_registered',
          tool_count: found?.toolCount ?? 0,
          connected_at: found?.connectedAt?.toISOString(),
          last_error: found?.lastError,
          reconnect_attempts: 0, // hub does not expose per-server attempt count publicly yet
          is_connected: found?.status === 'connected',
          registry_state: {
            in_config: inConfig,
            command: configEntry?.command,
          },
          suggestions,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
      }
    );

    // recommend_routing
    this.server.registerTool(
      'recommend_routing',
      {
        title: 'Recommend Routing',
        description: `Apply the X1 routing heuristic to one or all configured servers.
Servers whose names match lightweight-payload patterns (search, calendar, email, etc.) are recommended as "passthrough".
All others default to "execute_code" (safe default). Use apply=true to write the hints into conductor config.`,
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          server_name: z.string().optional().describe('Analyse a single server (omit for all servers).'),
          apply: z.boolean().optional().default(false).describe('Write routing hints to ~/.mcp-conductor.json.'),
        },
        outputSchema: {
          recommendations: z.array(z.object({
            server_name: z.string(),
            recommendation: z.enum(['passthrough', 'execute_code']),
            reason: z.string(),
          })),
          applied: z.boolean(),
          config_path: z.string().optional(),
        },
      },
      async ({ server_name, apply }) => {
        const result = getRoutingRecommendations({ serverName: server_name, apply: apply ?? false });
        const output = {
          recommendations: result.recommendations,
          applied: result.applied,
          config_path: result.configPath,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
      }
    );

    // export_to_claude
    this.server.registerTool(
      'export_to_claude',
      {
        title: 'Export to Claude',
        description: `Generate a mcpServers JSON block that points Claude back at mcp-conductor stdio.
This is the rollback path: paste the output into your Claude Desktop or Claude Code config to restore direct connectivity.
Formats: "claude-desktop" (full wrapper object), "claude-code" (flat mcpServers), "raw" (inner object only).`,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          format: z.enum(['claude-desktop', 'claude-code', 'raw']).optional().default('claude-desktop').describe('Output format.'),
          conductor_path: z.string().optional().describe('Override the conductor binary path (default: npx @darkiceinteractive/mcp-conductor).'),
        },
        outputSchema: {
          json: z.string(),
          format: z.string(),
          server_count: z.number(),
          instructions: z.string(),
        },
      },
      async ({ format, conductor_path }) => {
        const result = exportToClaude({ format: format ?? 'claude-desktop', conductorPath: conductor_path });
        const instructions = format === 'claude-code'
          ? 'Merge this into ~/.claude/settings.json under the mcpServers key.'
          : format === 'raw'
          ? 'Add these entries under the mcpServers key in your Claude config.'
          : 'Merge this into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or equivalent.';
        const output = { json: result.json, format: result.format, server_count: result.serverCount, instructions };
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
      }
    );
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    // Initialise the MCP Hub (connect to real servers)
    if (!this.useMockServers) {
      logger.info('Initialising MCP Hub...');
      await this.hub.initialise();
      const stats = this.hub.getStats();
      logger.info('MCP Hub initialised', {
        connected: stats.connected,
        total: stats.total,
      });

      // Populate the registry from the now-connected hub, apply built-in
      // routing recommendations for known servers, then register all
      // `routing: "passthrough"` tools as first-class MCP tools.
      await this.registry.refresh();
      applyBuiltInRecommendations(
        this.registry.getAllTools(),
        (server, name, meta) => this.registry.annotate(server, name, meta)
      );
      registerPassthroughTools(this.registry, this.server as unknown as import('./passthrough-registrar.js').McpServerLike, this.hub);
    }

    // Set up bridge handlers
    const handlers: BridgeHandlers = {
      callTool: async (serverName, toolName, params) => {
        if (this.useMockServers) {
          // Use mock implementations for testing
          if (serverName === 'echo') {
            if (toolName === 'echo') {
              return { message: params['message'] || '' };
            }
            if (toolName === 'reverse') {
              const msg = String(params['message'] || '');
              return { reversed: msg.split('').reverse().join('') };
            }
          }

          // Mock filesystem responses
          if (serverName === 'filesystem') {
            if (toolName === 'list_directory') {
              return {
                entries: [
                  { name: 'file1.ts', type: 'file' },
                  { name: 'file2.ts', type: 'file' },
                  { name: 'src', type: 'directory' },
                ],
              };
            }
            if (toolName === 'read_file') {
              return { content: '// Mock file content' };
            }
          }

          throw new Error(`Unknown tool: ${serverName}.${toolName}`);
        } else {
          // Check registry for X4 redact annotation on this tool
          const toolDef = this.registry.getTool(serverName, toolName);
          const matchers = toolDef?.redact?.response ?? [];

          // Use real hub for tool calls — instrument for observability
          const _obsStart = Date.now();

          if (matchers.length > 0) {
            // Tokenize PII before the result reaches the sandbox
            const { result, reverseMap } = await this.hub.callToolTokenized(
              serverName,
              toolName,
              params,
              matchers
            );
            const _obsLatency = Date.now() - _obsStart;
            const _obsResultStr = JSON.stringify(result ?? '');
            getHotPathProfiler().record(serverName, toolName, _obsLatency);
            getAnomalyDetector().record(serverName, toolName, _obsLatency, _obsResultStr.length);
            getCostPredictor().record(serverName, toolName, params as Record<string, unknown>, {
              outputText: _obsResultStr,
              latencyMs: _obsLatency,
            });
            // Return TokenizedCallResult sentinel — http-server.ts unwraps it
            return { __x4_result: result, __x4_reverseMap: reverseMap };
          }

          const _obsResult = await this.hub.callTool(serverName, toolName, params);
          const _obsLatency = Date.now() - _obsStart;
          const _obsResultStr = JSON.stringify(_obsResult ?? '');
          // Feed hot-path profiler
          getHotPathProfiler().record(serverName, toolName, _obsLatency);
          // Feed anomaly detector
          getAnomalyDetector().record(serverName, toolName, _obsLatency, _obsResultStr.length);
          // Feed cost predictor
          getCostPredictor().record(serverName, toolName, params as Record<string, unknown>, {
            outputText: _obsResultStr,
            latencyMs: _obsLatency,
          });
          return _obsResult;
        }
      },

      listServers: (): ServerInfo[] => {
        if (this.useMockServers) {
          return Array.from(this.mockServers.entries()).map(([name, data]) => ({
            name,
            toolCount: data.tools.length,
            status: 'connected',
          }));
        } else {
          return this.hub.listServers().map((s) => ({
            name: s.name,
            toolCount: s.toolCount,
            status: s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : 'disconnected',
          }));
        }
      },

      listTools: (serverName: string) => {
        if (this.useMockServers) {
          const server = this.mockServers.get(serverName);
          return server?.tools || [];
        } else {
          return this.hub.getServerTools(serverName).map((t) => ({
            name: t.name,
            description: t.description || '',
          }));
        }
      },

      searchTools: (query: string) => {
        if (this.useMockServers) {
          const results: Array<{ server: string; tool: string; description: string }> = [];
          const searchLower = query.toLowerCase();

          for (const [serverName, data] of this.mockServers.entries()) {
            for (const tool of data.tools) {
              if (
                tool.name.toLowerCase().includes(searchLower) ||
                tool.description.toLowerCase().includes(searchLower)
              ) {
                results.push({
                  server: serverName,
                  tool: tool.name,
                  description: tool.description,
                });
              }
            }
          }

          return results;
        } else {
          return this.hub.searchTools(query);
        }
      },
    };

    this.bridge.setHandlers(handlers);

    // Start bridge server
    await this.bridge.start();

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('MCP Executor server started');
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    logger.info('Stopping MCP Executor server...');

    // 1. Kill all in-flight Deno processes first
    await this.executor.shutdown();

    // 2. Shutdown hub connections (disconnects backend MCP servers)
    if (!this.useMockServers) {
      await this.hub.shutdown();
    }

    // 3. Shutdown global singletons (intervals, listeners, caches)
    shutdownStreamManager();
    shutdownMetricsCollector();
    shutdownModeHandler();
    shutdownSkillsEngine();
    shutdownCostPredictor();
    shutdownHotPathProfiler();
    shutdownAnomalyDetector();
    shutdownReplayRecorder();

    // 4. Stop HTTP bridge last (Deno processes may still be calling it during cleanup)
    await this.bridge.stop();

    logger.info('MCP Executor server stopped');
  }

  /**
   * Get the MCP Hub instance (for advanced usage)
   */
  getHub(): MCPHub {
    return this.hub;
  }

  /**
   * Reload server configurations
   */
  async reloadServers(): Promise<{ added: string[]; removed: string[] }> {
    if (this.useMockServers) {
      return { added: [], removed: [] };
    }
    return await this.hub.reload();
  }

  /**
   * Get registered tools for testing purposes.
   * WARNING: This is an internal API for testing only.
   * @internal
   */
  getRegisteredTools(): Map<string, { handler: (params: unknown) => Promise<unknown> }> {
    // Access the private _registeredTools object from McpServer for testing
    // SDK stores tools as an object, not a Map, so we convert it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolsObj = (this.server as any)._registeredTools as Record<
      string,
      { handler: (params: unknown) => Promise<unknown> }
    >;
    const toolsMap = new Map<string, { handler: (params: unknown) => Promise<unknown> }>();
    for (const [name, tool] of Object.entries(toolsObj)) {
      toolsMap.set(name, tool);
    }
    return toolsMap;
  }
}
