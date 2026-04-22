/**
 * HTTP Bridge Server
 *
 * Internal HTTP server that the Deno sandbox uses to communicate with MCP servers.
 * Runs on localhost only for security. Also provides SSE streaming endpoints for
 * real-time execution progress updates.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../utils/index.js';
import type { BridgeConfig } from '../config/index.js';
import { getStreamManager, type ExecutionStream } from '../streaming/index.js';

export interface ToolCallRequest {
  server: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolCallResponse {
  result?: unknown;
  error?: {
    type: string;
    message: string;
  };
  metrics?: {
    durationMs: number;
    dataSize: number;
  };
}

export interface ServerInfo {
  name: string;
  toolCount: number;
  status: 'connected' | 'disconnected' | 'error';
}

export type ToolCallHandler = (
  server: string,
  tool: string,
  params: Record<string, unknown>
) => Promise<unknown>;

export type ListServersHandler = () => ServerInfo[];

export type ListToolsHandler = (serverName: string) => Array<{ name: string; description: string }>;

export type SearchToolsHandler = (query: string) => Array<{
  server: string;
  tool: string;
  description: string;
}>;

export interface BridgeHandlers {
  callTool: ToolCallHandler;
  listServers: ListServersHandler;
  listTools: ListToolsHandler;
  searchTools: SearchToolsHandler;
}

export interface ProgressRequest {
  executionId: string;
  percent: number;
  message?: string;
}

export interface LogRequest {
  executionId: string;
  message: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

export interface ToolEventRequest {
  executionId: string;
  server: string;
  tool: string;
  status: 'started' | 'completed' | 'error';
  durationMs?: number;
  error?: string;
}

/**
 * HTTP Bridge Server class
 */
export class HttpBridge {
  private server: Server | null = null;
  private config: BridgeConfig;
  private handlers: BridgeHandlers | null = null;
  private startTime: number = Date.now();
  private actualPort: number = 0; // The actual port after binding (for dynamic port allocation)

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * Set the handlers for bridge operations
   */
  setHandlers(handlers: BridgeHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Start the HTTP bridge server
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Bridge server already running');
    }

    this.startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          logger.error('Unhandled bridge error', { error: String(error) });
          this.sendError(res, 500, 'Internal server error');
        });
      });

      this.server.on('error', (error) => {
        logger.error('Bridge server error', { error: String(error) });
        reject(error);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        // Get the actual port after binding (important for dynamic port allocation with port 0)
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.actualPort = address.port;
        } else {
          this.actualPort = this.config.port;
        }
        logger.info(`HTTP bridge started on ${this.config.host}:${this.actualPort}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP bridge server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info('HTTP bridge stopped');
        this.server = null;
        this.actualPort = 0; // Reset actual port on stop
        resolve();
      });
    });
  }

  /**
   * Get the bridge URL
   */
  getUrl(): string {
    // Use actualPort which is set after server binds (handles dynamic port allocation)
    const port = this.actualPort || this.config.port;
    return `http://${this.config.host}:${port}`;
  }

  /**
   * Get the actual port the server is listening on
   */
  getPort(): number {
    return this.actualPort || this.config.port;
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method || 'GET';

    // Enable CORS for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname;

    try {
      // Route handling
      if (method === 'GET' && path === '/health') {
        await this.handleHealth(res);
      } else if (method === 'GET' && path === '/servers') {
        await this.handleListServers(res);
      } else if (method === 'GET' && path.startsWith('/servers/') && path.endsWith('/tools')) {
        const serverName = path.slice(9, -6); // Extract server name
        await this.handleListTools(res, serverName);
      } else if (method === 'POST' && path === '/call') {
        await this.handleToolCall(req, res);
      } else if (method === 'GET' && path === '/search') {
        const query = url.searchParams.get('q') || '';
        await this.handleSearch(res, query);
      } else if (method === 'GET' && path.startsWith('/stream/')) {
        // SSE streaming endpoint
        const executionId = path.slice(8);
        await this.handleStreamConnect(res, executionId);
      } else if (method === 'POST' && path === '/progress') {
        // Progress reporting from sandbox
        await this.handleProgress(req, res);
      } else if (method === 'POST' && path === '/log') {
        // Log reporting from sandbox
        await this.handleLog(req, res);
      } else if (method === 'POST' && path === '/tool-event') {
        // Tool call event reporting from sandbox
        await this.handleToolEvent(req, res);
      } else if (method === 'GET' && path === '/streams') {
        // List active streams
        await this.handleListStreams(res);
      } else {
        this.sendError(res, 404, 'Not found');
      }
    } catch (error) {
      logger.error('Bridge request error', { path, error: String(error) });
      this.sendError(res, 500, String(error));
    }
  }

  /**
   * GET /health
   */
  private async handleHealth(res: ServerResponse): Promise<void> {
    const uptime = Date.now() - this.startTime;
    const servers = this.handlers?.listServers() || [];

    this.sendJson(res, {
      status: 'ok',
      uptime,
      uptimeFormatted: `${Math.floor(uptime / 1000)}s`,
      serversConnected: servers.filter((s) => s.status === 'connected').length,
    });
  }

  /**
   * GET /servers
   */
  private async handleListServers(res: ServerResponse): Promise<void> {
    if (!this.handlers) {
      this.sendError(res, 503, 'Bridge not ready');
      return;
    }

    const servers = this.handlers.listServers();
    this.sendJson(res, { servers });
  }

  /**
   * GET /servers/:name/tools
   */
  private async handleListTools(res: ServerResponse, serverName: string): Promise<void> {
    if (!this.handlers) {
      this.sendError(res, 503, 'Bridge not ready');
      return;
    }

    const tools = this.handlers.listTools(serverName);
    this.sendJson(res, { tools });
  }

  /**
   * POST /call
   */
  private async handleToolCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.handlers) {
      this.sendError(res, 503, 'Bridge not ready');
      return;
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (error) {
      if (error instanceof Error && error.message.includes('maximum size')) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw error;
    }
    const request = JSON.parse(body) as ToolCallRequest;

    if (!request.server || !request.tool) {
      this.sendError(res, 400, 'Missing server or tool parameter');
      return;
    }

    const startTime = Date.now();

    try {
      const result = await this.handlers.callTool(
        request.server,
        request.tool,
        request.params || {}
      );

      const resultStr = JSON.stringify(result);
      const response: ToolCallResponse = {
        result,
        metrics: {
          durationMs: Date.now() - startTime,
          dataSize: resultStr.length,
        },
      };

      this.sendJson(res, response);
    } catch (error) {
      const response: ToolCallResponse = {
        error: {
          type: 'tool_error',
          message: String(error),
        },
        metrics: {
          durationMs: Date.now() - startTime,
          dataSize: 0,
        },
      };
      this.sendJson(res, response, 500);
    }
  }

  /**
   * GET /search?q=query
   */
  private async handleSearch(res: ServerResponse, query: string): Promise<void> {
    if (!this.handlers) {
      this.sendError(res, 503, 'Bridge not ready');
      return;
    }

    const results = this.handlers.searchTools(query);
    this.sendJson(res, { results });
  }

  /**
   * GET /stream/:executionId - SSE stream connection
   */
  private async handleStreamConnect(res: ServerResponse, executionId: string): Promise<void> {
    const streamManager = getStreamManager();
    const stream = streamManager.getStream(executionId);

    if (!stream) {
      this.sendError(res, 404, `Stream not found: ${executionId}`);
      return;
    }

    // Add connection to stream (handles SSE headers and sends buffered events)
    stream.addConnection(res);

    logger.debug('SSE client connected', { executionId });
  }

  /**
   * POST /progress - Report progress from sandbox
   */
  private async handleProgress(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const request = JSON.parse(body) as ProgressRequest;

    if (!request.executionId || request.percent === undefined) {
      this.sendError(res, 400, 'Missing executionId or percent');
      return;
    }

    const streamManager = getStreamManager();
    const stream = streamManager.getStream(request.executionId);

    if (stream) {
      stream.progress(request.percent, request.message);
    }

    this.sendJson(res, { success: true });
  }

  /**
   * POST /log - Report log from sandbox
   */
  private async handleLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const request = JSON.parse(body) as LogRequest;

    if (!request.executionId || !request.message) {
      this.sendError(res, 400, 'Missing executionId or message');
      return;
    }

    const streamManager = getStreamManager();
    const stream = streamManager.getStream(request.executionId);

    if (stream) {
      stream.log(request.message, request.level || 'info');
    }

    this.sendJson(res, { success: true });
  }

  /**
   * POST /tool-event - Report tool call event from sandbox
   */
  private async handleToolEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const request = JSON.parse(body) as ToolEventRequest;

    if (!request.executionId || !request.server || !request.tool || !request.status) {
      this.sendError(res, 400, 'Missing required fields');
      return;
    }

    const streamManager = getStreamManager();
    const stream = streamManager.getStream(request.executionId);

    if (stream) {
      stream.toolCall(request.server, request.tool, request.status, request.durationMs, request.error);
    }

    this.sendJson(res, { success: true });
  }

  /**
   * GET /streams - List active execution streams
   */
  private async handleListStreams(res: ServerResponse): Promise<void> {
    const streamManager = getStreamManager();
    const streams = streamManager.listStreams();

    this.sendJson(res, {
      streams: streams.map((s) => ({
        id: s.id,
        status: s.state.status,
        progress: s.state.progress,
        startedAt: s.state.startedAt.toISOString(),
        toolCalls: s.state.toolCalls,
      })),
      total: streams.length,
    });
  }

  /**
   * Create a stream for an execution (called by executor)
   */
  createStream(executionId: string): ExecutionStream {
    const streamManager = getStreamManager();
    return streamManager.createStream(executionId);
  }

  /**
   * Get an existing stream
   */
  getStream(executionId: string): ExecutionStream | undefined {
    const streamManager = getStreamManager();
    return streamManager.getStream(executionId);
  }

  /**
   * Read request body
   */
  private readBody(req: IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxBytes) {
          req.destroy();
          reject(new Error(`Request body exceeds maximum size of ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Send error response
   */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    this.sendJson(res, { error: message }, statusCode);
  }
}
