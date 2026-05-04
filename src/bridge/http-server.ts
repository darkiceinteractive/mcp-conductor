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
import { SessionRegistry } from './session-registry.js';

/**
 * Header name per MCP spec 2025-03-26 Streamable HTTP transport. Case-
 * insensitive on the wire, but Node lowercases incoming header keys.
 */
const MCP_SESSION_ID_HEADER = 'mcp-session-id';

export interface ToolCallRequest {
  server: string;
  tool: string;
  params: Record<string, unknown>;
}

import { MCPToolError } from '../reliability/errors.js';

export interface ToolCallResponse {
  result?: unknown;
  error?: {
    type: string;
    message: string;
    /** Populated when type === 'mcp_tool_error' */
    code?: string;
    server?: string;
    tool?: string;
    /**
     * Serialized upstream error payload (CRIT-2).
     * When the upstream value was an Error instance it is serialized as
     * `{ __error__: true, name, message, stack }`. Structured objects are
     * passed through JSON.parse(JSON.stringify(…)). The sandbox reconstructs
     * an Error from the `__error__` sentinel so `e.upstream instanceof Error`
     * works correctly on the other side.
     */
    upstream?: unknown;
  };
  metrics?: {
    durationMs: number;
    dataSize: number;
  };
  /**
   * Per-call PII reverse map (X4 — Agent J).
   * Present only when the tool's `ToolDefinition.redact.response` annotation
   * is active. Maps `[TOKEN_N]` → original sensitive value. The sandbox
   * accumulates this across tool calls within one `execute_code` invocation
   * and uses it to back `mcp.detokenize()`.
   */
  reverseMap?: Record<string, string>;
}

/**
 * Internal marker returned by the bridge callTool handler when X4
 * tokenization is active. The HTTP server unwraps it so the wire format
 * cleanly separates `result` from `reverseMap`.
 *
 * @internal Not part of the public API — used only between mcp-server.ts
 *   and http-server.ts handleToolCall.
 */
export interface TokenizedCallResult {
  __x4_result: unknown;
  __x4_reverseMap: Record<string, string>;
}

/** Type guard for TokenizedCallResult */
export function isTokenizedCallResult(v: unknown): v is TokenizedCallResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    '__x4_result' in v &&
    '__x4_reverseMap' in v
  );
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
  private sessions: SessionRegistry;

  constructor(config: BridgeConfig, sessions?: SessionRegistry) {
    this.config = config;
    this.sessions = sessions ?? new SessionRegistry();
  }

  /**
   * Exposed for tests that need to assert registry state directly.
   */
  getSessionRegistry(): SessionRegistry {
    return this.sessions;
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
    this.sessions.start();

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
        this.sessions.stop();
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
   * Return true if a bare hostname (no brackets, no port) is loopback.
   * Hostnames are case-insensitive per RFC 1035 §2.3.3 — `Localhost` and
   * `LOCALHOST` are valid Host header values, so compare lowercased.
   */
  private static isLoopbackHostname(hostname: string | undefined): boolean {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }

  /**
   * Extract the bare hostname from a `Host` header (`host[:port]` or
   * `[ipv6]:port`). Returns undefined for malformed values.
   */
  private static extractHostHeaderName(header: string | undefined): string | undefined {
    if (!header) return undefined;
    if (header.startsWith('[')) {
      // IPv6 bracketed form: `[::1]:PORT`
      const close = header.indexOf(']');
      return close > 0 ? header.substring(1, close) : undefined;
    }
    // IPv4 or DNS hostname — strip any single :port suffix.
    return header.split(':')[0];
  }

  /**
   * Extract hostname from an `Origin` header (a full URL like
   * `http://example.com:8080`). Returns undefined for malformed values.
   *
   * Node's WHATWG URL keeps IPv6 addresses in bracketed form (`[::1]`) on
   * the `hostname` property, so strip the brackets for comparison.
   */
  private static extractOriginHostname(header: string | undefined): string | undefined {
    if (!header) return undefined;
    try {
      const raw = new URL(header).hostname;
      return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
    } catch {
      return undefined;
    }
  }

  /**
   * Internal sandbox-only routes that should bypass MCP session middleware.
   * The Deno sandbox is not an MCP client; tracking a session per call
   * inflates the registry without any reconnection benefit and forces the
   * 1000-entry LRU evictor into the hot path.
   */
  private static isSandboxInternalPath(path: string): boolean {
    return (
      path === '/call' ||
      path === '/log' ||
      path === '/progress' ||
      path === '/tool-event' ||
      path === '/search' ||
      path === '/servers' ||
      path === '/streams' ||
      path === '/health' ||
      path.startsWith('/servers/') ||
      path.startsWith('/stream/')
    );
  }

  /**
   * Normalise the Mcp-Session-Id header. Node surfaces duplicates as string[],
   * so take the first value and trim. Reject obvious garbage so bad clients
   * don't get stored in the registry.
   */
  private readSessionHeader(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 128) return undefined;
    // MCP spec requires IDs be "globally unique and cryptographically secure".
    // We generate UUIDs, but clients may pass other printable ASCII schemes;
    // accept any printable ASCII and let the registry do the real validation.
    if (!/^[\x21-\x7e]+$/.test(trimmed)) return undefined;
    return trimmed;
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding guard: reject requests whose Host or Origin claims a
    // non-localhost origin. Per MCP spec 2025-03-26 transport requirements.
    // A page on evil.com can make a browser issue requests to our bridge by
    // resolving the attacker's hostname to 127.0.0.1, but the Host/Origin
    // headers still carry evil.com — so we must validate those, not just the
    // socket address.
    const hostHeader = req.headers.host;
    const originHeader = req.headers.origin;

    if (!HttpBridge.isLoopbackHostname(HttpBridge.extractHostHeaderName(hostHeader))) {
      logger.warn('Rejecting bridge request with non-localhost Host', { host: hostHeader });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Host header not allowed' }));
      return;
    }

    if (originHeader) {
      if (!HttpBridge.isLoopbackHostname(HttpBridge.extractOriginHostname(originHeader))) {
        logger.warn('Rejecting bridge request with non-localhost Origin', { origin: originHeader });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method || 'GET';

    // CORS: echo a localhost Origin back exactly, or set a benign default.
    // Never answer `*` because that would pair with the loopback-only Host
    // guard above to still leak bridge output to browser contexts on the
    // same machine that we didn't verify.
    res.setHeader(
      'Access-Control-Allow-Origin',
      originHeader ?? `http://${hostHeader ?? '127.0.0.1'}`,
    );
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname;

    // Session handling (MCP spec 2025-03-26 Streamable HTTP). Only applied
    // to MCP-protocol surfaces. The Deno sandbox makes many short-lived
    // fetches per execution against the internal endpoints below; tracking
    // a session per fetch would saturate the registry and force the LRU
    // evictor onto the hot path. We therefore short-circuit those routes.
    let sessionId: string | undefined;
    if (!HttpBridge.isSandboxInternalPath(path)) {
      const incomingSessionId = this.readSessionHeader(req.headers[MCP_SESSION_ID_HEADER]);
      if (incomingSessionId) {
        const known = this.sessions.touch(incomingSessionId);
        if (!known) {
          logger.warn('Rejecting bridge request with unknown Mcp-Session-Id', {
            session: incomingSessionId,
          });
          this.sendError(res, 404, 'Session not found or expired');
          return;
        }
        sessionId = known.id;
      } else {
        sessionId = this.sessions.create();
      }
      res.setHeader('Mcp-Session-Id', sessionId);
    }

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
      } else if (method === 'DELETE' && path === '/session') {
        // Explicit session termination. Caller's session id is already
        // validated by the middleware above; sessionId is guaranteed set.
        this.sessions.terminate(sessionId!);
        res.writeHead(204);
        res.end();
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
      const raw = await this.handlers.callTool(
        request.server,
        request.tool,
        request.params || {}
      );

      // X4 tokenization: if the handler returned a TokenizedCallResult,
      // unwrap it so `result` and `reverseMap` are separate fields on the
      // wire response. The sandbox accumulates reverseMap across tool calls.
      let result: unknown;
      let reverseMap: Record<string, string> | undefined;
      if (isTokenizedCallResult(raw)) {
        result = raw.__x4_result;
        reverseMap = raw.__x4_reverseMap;
      } else {
        result = raw;
      }

      const resultStr = JSON.stringify(result);
      const response: ToolCallResponse = {
        result,
        metrics: {
          durationMs: Date.now() - startTime,
          dataSize: resultStr.length,
        },
        ...(reverseMap && Object.keys(reverseMap).length > 0 ? { reverseMap } : {}),
      };

      this.sendJson(res, response);
    } catch (error) {
      const isMcpToolError = error instanceof MCPToolError;

      let upstreamSerialized: unknown;
      if (isMcpToolError) {
        const upstream = (error as MCPToolError).upstream;
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
      }

      const response: ToolCallResponse = {
        error: {
          type: isMcpToolError ? 'mcp_tool_error' : 'tool_error',
          message: String(error),
          // Serialize MCPToolError structured fields so the sandbox can reconstruct
          ...(isMcpToolError && {
            code: (error as MCPToolError).code,
            server: (error as MCPToolError).server,
            tool: (error as MCPToolError).tool,
            upstream: upstreamSerialized,
          }),
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
