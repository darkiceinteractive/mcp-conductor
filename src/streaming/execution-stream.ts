/**
 * Execution Streaming Manager
 *
 * Manages SSE connections and streams execution progress events
 * to connected clients in real-time.
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { logger } from '../utils/index.js';
import { LIFECYCLE_TIMEOUTS } from '../config/defaults.js';

export interface StreamEvent {
  type: 'log' | 'progress' | 'tool_call' | 'error' | 'complete';
  timestamp: string;
  executionId: string;
  data: unknown;
}

export interface LogEvent {
  message: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

export interface ProgressEvent {
  percent: number;
  message?: string;
}

export interface ToolCallEvent {
  server: string;
  tool: string;
  status: 'started' | 'completed' | 'error';
  durationMs?: number;
  error?: string;
}

export interface CompleteEvent {
  success: boolean;
  result?: unknown;
  error?: {
    type: string;
    message: string;
  };
  metrics: {
    executionTimeMs: number;
    toolCalls: number;
    dataProcessedBytes: number;
  };
}

export interface ExecutionState {
  id: string;
  startedAt: Date;
  status: 'running' | 'completed' | 'error' | 'timeout';
  progress: number;
  logs: string[];
  toolCalls: number;
  lastUpdate: Date;
}

/**
 * Manages streaming for a single execution
 */
export class ExecutionStream extends EventEmitter {
  private connections: Set<ServerResponse> = new Set();
  private state: ExecutionState;
  private eventBuffer: StreamEvent[] = [];
  private maxBufferSize = 100;

  constructor(executionId: string) {
    super();
    this.state = {
      id: executionId,
      startedAt: new Date(),
      status: 'running',
      progress: 0,
      logs: [],
      toolCalls: 0,
      lastUpdate: new Date(),
    };
  }

  /**
   * Add an SSE connection to this stream
   */
  addConnection(res: ServerResponse): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial state
    this.sendEvent(res, {
      type: 'log',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: { message: 'Connected to execution stream', level: 'info' } as LogEvent,
    });

    // Send buffered events
    for (const event of this.eventBuffer) {
      this.sendEvent(res, event);
    }

    this.connections.add(res);

    // Handle connection close
    res.on('close', () => {
      this.connections.delete(res);
      logger.debug('SSE connection closed', { executionId: this.state.id });
    });

    logger.debug('SSE connection added', {
      executionId: this.state.id,
      totalConnections: this.connections.size,
    });
  }

  /**
   * Broadcast a log event
   */
  log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
    this.state.logs.push(message);
    // Cap logs to prevent unbounded memory growth
    if (this.state.logs.length > 500) {
      this.state.logs = this.state.logs.slice(-500);
    }
    this.state.lastUpdate = new Date();

    const event: StreamEvent = {
      type: 'log',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: { message, level } as LogEvent,
    };

    this.broadcast(event);
    this.emit('log', event);
  }

  /**
   * Broadcast a progress event
   */
  progress(percent: number, message?: string): void {
    this.state.progress = Math.min(100, Math.max(0, percent));
    this.state.lastUpdate = new Date();

    const event: StreamEvent = {
      type: 'progress',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: { percent: this.state.progress, message } as ProgressEvent,
    };

    this.broadcast(event);
    this.emit('progress', event);
  }

  /**
   * Broadcast a tool call event
   */
  toolCall(
    server: string,
    tool: string,
    status: 'started' | 'completed' | 'error',
    durationMs?: number,
    error?: string
  ): void {
    if (status === 'completed' || status === 'error') {
      this.state.toolCalls++;
    }
    this.state.lastUpdate = new Date();

    const event: StreamEvent = {
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: { server, tool, status, durationMs, error } as ToolCallEvent,
    };

    this.broadcast(event);
    this.emit('tool_call', event);
  }

  /**
   * Broadcast an error event
   */
  error(message: string, type = 'runtime'): void {
    this.state.status = 'error';
    this.state.lastUpdate = new Date();

    const event: StreamEvent = {
      type: 'error',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: { type, message },
    };

    this.broadcast(event);
    this.emit('execution_error', event);
  }

  /**
   * Broadcast completion event and close connections
   */
  complete(result: CompleteEvent): void {
    this.state.status = result.success ? 'completed' : 'error';
    this.state.progress = 100;
    this.state.lastUpdate = new Date();
    // Release log memory on completion
    this.state.logs = [];

    const event: StreamEvent = {
      type: 'complete',
      timestamp: new Date().toISOString(),
      executionId: this.state.id,
      data: result,
    };

    this.broadcast(event);
    this.emit('complete', event);

    // Close all connections after a brief delay
    setTimeout(() => {
      this.closeAllConnections();
    }, 100);
  }

  /**
   * Get current execution state
   */
  getState(): ExecutionState {
    return { ...this.state };
  }

  /**
   * Check if stream has active connections
   */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Close all SSE connections
   */
  closeAllConnections(): void {
    for (const conn of this.connections) {
      try {
        conn.end();
      } catch {
        // Ignore errors closing connections
      }
    }
    this.connections.clear();
  }

  /**
   * Send event to a single connection
   */
  private sendEvent(res: ServerResponse, event: StreamEvent): void {
    try {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Connection may have closed
      this.connections.delete(res);
    }
  }

  /**
   * Broadcast event to all connections and buffer it
   */
  private broadcast(event: StreamEvent): void {
    // Add to buffer
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    // Send to all connections
    for (const conn of this.connections) {
      this.sendEvent(conn, event);
    }
  }
}

/**
 * Manager for all active execution streams
 */
export class StreamManager {
  private streams: Map<string, ExecutionStream> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private maxStreamAge = LIFECYCLE_TIMEOUTS.STREAM_STALE_TTL_MS;

  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanupStaleStreams(),
      LIFECYCLE_TIMEOUTS.STREAM_CLEANUP_INTERVAL_MS,
    );
  }

  /**
   * Create a new execution stream
   */
  createStream(executionId: string): ExecutionStream {
    // Clean up existing stream if any
    const existing = this.streams.get(executionId);
    if (existing) {
      existing.closeAllConnections();
    }

    const stream = new ExecutionStream(executionId);
    this.streams.set(executionId, stream);

    logger.debug('Created execution stream', { executionId });
    return stream;
  }

  /**
   * Get an existing stream
   */
  getStream(executionId: string): ExecutionStream | undefined {
    return this.streams.get(executionId);
  }

  /**
   * Remove a stream
   */
  removeStream(executionId: string): void {
    const stream = this.streams.get(executionId);
    if (stream) {
      stream.closeAllConnections();
      this.streams.delete(executionId);
      logger.debug('Removed execution stream', { executionId });
    }
  }

  /**
   * Get all active streams
   */
  listStreams(): Array<{ id: string; state: ExecutionState }> {
    return Array.from(this.streams.entries()).map(([id, stream]) => ({
      id,
      state: stream.getState(),
    }));
  }

  /**
   * Get stream count
   */
  getStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Clean up stale streams (completed with no connections)
   */
  private cleanupStaleStreams(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, stream] of this.streams) {
      const state = stream.getState();
      const age = now - state.lastUpdate.getTime();

      // Normal cleanup: completed + no connections + 5min old
      if (
        (state.status === 'completed' || state.status === 'error') &&
        !stream.hasConnections() &&
        age > this.maxStreamAge
      ) {
        toRemove.push(id);
      }
      // Force cleanup: completed/error + STREAM_COMPLETED_TTL_MS old (even with connections)
      else if (
        (state.status === 'completed' || state.status === 'error') &&
        age > LIFECYCLE_TIMEOUTS.STREAM_COMPLETED_TTL_MS
      ) {
        toRemove.push(id);
      }
      // Stuck cleanup: running + no update in STREAM_STUCK_TTL_MS
      else if (state.status === 'running' && age > LIFECYCLE_TIMEOUTS.STREAM_STUCK_TTL_MS) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.removeStream(id);
    }

    if (toRemove.length > 0) {
      logger.debug('Cleaned up stale streams', { count: toRemove.length });
    }
  }

  /**
   * Shutdown the stream manager
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close all streams and clean up listeners
    for (const [_id, stream] of this.streams) {
      stream.removeAllListeners();
      stream.closeAllConnections();
    }
    this.streams.clear();

    logger.debug('Stream manager shut down');
  }
}

// Global stream manager instance
let globalStreamManager: StreamManager | null = null;

/**
 * Get or create the global stream manager
 */
export function getStreamManager(): StreamManager {
  if (!globalStreamManager) {
    globalStreamManager = new StreamManager();
  }
  return globalStreamManager;
}

/**
 * Shutdown the global stream manager
 */
export function shutdownStreamManager(): void {
  if (globalStreamManager) {
    globalStreamManager.shutdown();
    globalStreamManager = null;
  }
}
