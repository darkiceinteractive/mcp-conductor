import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPExecutorServer } from '../../src/server/mcp-server.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { shutdownStreamManager } from '../../src/streaming/index.js';
import { shutdownMetricsCollector } from '../../src/metrics/index.js';
import { shutdownModeHandler } from '../../src/modes/index.js';
import { shutdownSkillsEngine } from '../../src/skills/index.js';
import type { ExecutionResult } from '../../src/runtime/executor.js';

/**
 * Phase 1.5 — progress forwarding from sandbox to MCP client.
 *
 * When the tool request arrives with `_meta.progressToken`, the handler must
 * subscribe to the execution stream and forward each progress event as an
 * MCP `notifications/progress` message via `extra.sendNotification`.
 *
 * We swap out the real Deno executor for a stub so the test is fast and
 * doesn't need a running bridge or subprocess.
 */

type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: {
      _meta?: { progressToken?: string | number };
      signal?: AbortSignal;
      sendNotification?: (n: unknown) => Promise<void>;
    },
  ) => Promise<unknown>;
};

type McpServerInternals = {
  _registeredTools: Record<string, RegisteredTool>;
};

describe('execute_code progress forwarding', () => {
  let server: MCPExecutorServer;
  let callback: RegisteredTool['handler'];
  let capturedExecutionIds: string[] = [];
  let fireProgressDuringExecute: ((percent: number, message?: string) => void) | null = null;

  beforeAll(() => {
    server = new MCPExecutorServer(DEFAULT_CONFIG, { useMockServers: true });

    // Grab the registered callback so we can invoke it directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = ((server as any).server as McpServerInternals)._registeredTools;
    callback = registered.execute_code!.handler;

    // Stub the executor: captures executionId, fires a progress event via the
    // pre-created stream, then returns a successful result.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (server as any).bridge as {
      getStream: (id: string) => { progress: (p: number, m?: string) => void } | undefined;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).executor = {
      generateExecutionId: () => `test-exec-${capturedExecutionIds.length + 1}`,
      execute: async (_code: string, options: { executionId?: string }): Promise<ExecutionResult> => {
        const executionId = options.executionId ?? 'unknown';
        capturedExecutionIds.push(executionId);
        // Emit via the SAME stream the handler already subscribed to. Using
        // createStream would replace it, detaching the listener.
        if (fireProgressDuringExecute && options.executionId) {
          fireProgressDuringExecute = null;
          const stream = bridge.getStream(options.executionId);
          stream?.progress(42, 'halfway');
        }
        return {
          executionId,
          success: true,
          result: 'ok',
          logs: [],
          metrics: {
            executionTimeMs: 1,
            toolCalls: 0,
            dataProcessedBytes: 0,
            resultSizeBytes: 0,
          },
        };
      },
    };
  });

  afterAll(() => {
    shutdownStreamManager();
    shutdownMetricsCollector();
    shutdownModeHandler();
    shutdownSkillsEngine();
  });

  it('does not preallocate an execution id when no progressToken is provided', async () => {
    capturedExecutionIds = [];
    await callback(
      { code: 'return 1;' },
      { signal: new AbortController().signal },
    );
    // Without a progressToken and without stream=true, the handler should
    // let the executor mint its own id — ours is 'unknown' because the stub
    // reads options.executionId.
    expect(capturedExecutionIds).toEqual(['unknown']);
  });

  it('forwards progress events as MCP notifications when progressToken is set', async () => {
    capturedExecutionIds = [];
    const notifications: Array<Record<string, unknown>> = [];
    fireProgressDuringExecute = () => {};

    await callback(
      { code: 'return 1;' },
      {
        signal: new AbortController().signal,
        _meta: { progressToken: 'tok-123' },
        sendNotification: async (n: unknown) => {
          notifications.push(n as Record<string, unknown>);
        },
      },
    );

    expect(capturedExecutionIds[0]).toMatch(/^test-exec-/);
    // Exactly one progress notification forwarded.
    expect(notifications).toHaveLength(1);
    const note = notifications[0] as { method: string; params: Record<string, unknown> };
    expect(note.method).toBe('notifications/progress');
    expect(note.params.progressToken).toBe('tok-123');
    expect(note.params.progress).toBe(42);
    expect(note.params.total).toBe(100);
    expect(note.params.message).toBe('halfway');
  });

  it('does not forward progress events when progressToken is absent', async () => {
    capturedExecutionIds = [];
    const notifications: unknown[] = [];
    fireProgressDuringExecute = () => {};

    await callback(
      { code: 'return 1;', stream: true },
      {
        signal: new AbortController().signal,
        sendNotification: async (n: unknown) => {
          notifications.push(n);
        },
      },
    );

    // stream=true creates a stream but without a token we don't forward.
    expect(notifications).toHaveLength(0);
  });
});
