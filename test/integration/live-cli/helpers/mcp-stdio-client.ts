/**
 * Minimal MCP client that speaks JSON-RPC 2.0 over stdio to a subprocess.
 *
 * Handles the two-phase conductor startup:
 *   1. Static tools are available immediately after initialize()
 *   2. Passthrough tools arrive via notifications/tools/list_changed once hub init completes
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content: McpContentItem[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class McpStdioClient extends EventEmitter {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrBuffer = '';
  private closed = false;
  private toolsChangedCount = 0;

  constructor(command: string, args: string[], env?: Record<string, string>) {
    super();

    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    // --- stdout: line-delimited JSON-RPC ---
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
        this._handleMessage(msg);
      } catch {
        // Non-JSON startup noise — ignore silently
      }
    });

    // --- stderr: capture for diagnostics ---
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
    });

    // --- process exit ---
    this.proc.once('exit', (code, signal) => {
      this.closed = true;
      // Reject any in-flight requests
      for (const [id, p] of this.pending) {
        p.reject(new Error(`Conductor exited (code=${code}, signal=${signal}) while waiting for request ${id}`));
        this.pending.delete(id);
      }
      this.emit('exit', code, signal);
    });

    this.proc.once('error', (err) => {
      this.emit('error', err);
    });

    // Last-resort cleanup when the test process exits
    process.once('exit', () => {
      if (!this.closed) {
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    });
  }

  private _handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // Notification (no id field)
    if (!('id' in msg)) {
      const notif = msg as JsonRpcNotification;
      if (notif.method === 'notifications/tools/list_changed') {
        this.toolsChangedCount++;
        this.emit('toolsChanged', this.toolsChangedCount);
      }
      this.emit('notification', notif);
      return;
    }

    // Response
    const resp = msg as JsonRpcResponse;
    const pending = this.pending.get(resp.id);
    if (!pending) return;
    this.pending.delete(resp.id);

    if (resp.error) {
      pending.reject(
        Object.assign(new Error(resp.error.message), { code: resp.error.code, data: resp.error.data })
      );
    } else {
      pending.resolve(resp.result);
    }
  }

  private _send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('McpStdioClient is closed'));
        return;
      }

      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
      if (params !== undefined) req.params = params;

      this.pending.set(id, { resolve, reject });

      const line = JSON.stringify(req) + '\n';
      this.proc.stdin!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mcp-stdio-test-client', version: '1.0.0' },
    });

    // Send initialized notification (no response expected)
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n';
    this.proc.stdin!.write(notification);

    return result;
  }

  async listTools(): Promise<McpToolsListResult> {
    const result = await this._send('tools/list') as { tools: McpTool[] };
    return result;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = await this._send('tools/call', {
      name,
      arguments: args ?? {},
    }) as McpCallToolResult;
    return result;
  }

  /**
   * Resolves when the next notifications/tools/list_changed arrives.
   * Safe to call before initialize() — the listener is registered immediately.
   */
  waitForToolsChanged(timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('McpStdioClient is closed'));
        return;
      }

      const timer = setTimeout(() => {
        this.off('toolsChanged', handler);
        reject(new Error(`Timed out waiting for tools/list_changed after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = () => {
        clearTimeout(timer);
        resolve();
      };

      this.once('toolsChanged', handler);
    });
  }

  getStderr(): string {
    return this.stderrBuffer;
  }

  getToolsChangedCount(): number {
    return this.toolsChangedCount;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    return new Promise((resolve) => {
      this.proc.once('exit', () => resolve());
      this.proc.stdin!.end();
      // Give it 3 seconds to exit gracefully, then SIGKILL
      const killTimer = setTimeout(() => {
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000);
      this.proc.once('exit', () => clearTimeout(killTimer));
    });
  }
}
