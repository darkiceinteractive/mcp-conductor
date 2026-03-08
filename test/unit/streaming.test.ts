import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import {
  ExecutionStream,
  StreamManager,
  getStreamManager,
  shutdownStreamManager,
  type StreamEvent,
} from '../../src/streaming/index.js';

// Mock ServerResponse
function createMockResponse(): ServerResponse {
  const res = new EventEmitter() as ServerResponse & EventEmitter;
  const writtenData: string[] = [];

  res.writeHead = vi.fn().mockReturnThis() as unknown as ServerResponse['writeHead'];
  res.write = vi.fn((data: string) => {
    writtenData.push(data);
    return true;
  }) as unknown as ServerResponse['write'];
  res.end = vi.fn(() => {
    res.emit('close');
    return res;
  }) as unknown as ServerResponse['end'];

  // Expose written data for testing
  (res as unknown as { __writtenData: string[] }).__writtenData = writtenData;

  return res;
}

describe('ExecutionStream', () => {
  let stream: ExecutionStream;

  beforeEach(() => {
    stream = new ExecutionStream('test-exec-123');
  });

  afterEach(() => {
    stream.closeAllConnections();
  });

  describe('constructor', () => {
    it('should create stream with execution ID', () => {
      const state = stream.getState();
      expect(state.id).toBe('test-exec-123');
      expect(state.status).toBe('running');
      expect(state.progress).toBe(0);
      expect(state.logs).toEqual([]);
      expect(state.toolCalls).toBe(0);
    });
  });

  describe('addConnection', () => {
    it('should add SSE connection and set headers', () => {
      const res = createMockResponse();
      stream.addConnection(res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(stream.getConnectionCount()).toBe(1);
      expect(stream.hasConnections()).toBe(true);
    });

    it('should send initial connected event', () => {
      const res = createMockResponse();
      stream.addConnection(res);

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: log'))).toBe(true);
    });

    it('should remove connection on close', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      expect(stream.getConnectionCount()).toBe(1);

      res.emit('close');
      expect(stream.getConnectionCount()).toBe(0);
    });
  });

  describe('log', () => {
    it('should add log to state', () => {
      stream.log('Test message');
      const state = stream.getState();
      expect(state.logs).toContain('Test message');
    });

    it('should broadcast log event to connections', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      (res as unknown as { __writtenData: string[] }).__writtenData.length = 0;

      stream.log('Test log message', 'warn');

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: log'))).toBe(true);
      expect(writtenData.some((d) => d.includes('Test log message'))).toBe(true);
    });

    it('should emit log event', () => {
      const handler = vi.fn();
      stream.on('log', handler);

      stream.log('Test message', 'info');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'log',
          executionId: 'test-exec-123',
          data: { message: 'Test message', level: 'info' },
        })
      );
    });
  });

  describe('progress', () => {
    it('should update progress in state', () => {
      stream.progress(50, 'Halfway done');
      const state = stream.getState();
      expect(state.progress).toBe(50);
    });

    it('should clamp progress between 0 and 100', () => {
      stream.progress(-10);
      expect(stream.getState().progress).toBe(0);

      stream.progress(150);
      expect(stream.getState().progress).toBe(100);
    });

    it('should broadcast progress event', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      (res as unknown as { __writtenData: string[] }).__writtenData.length = 0;

      stream.progress(75, 'Almost there');

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: progress'))).toBe(true);
      expect(writtenData.some((d) => d.includes('"percent":75'))).toBe(true);
    });

    it('should emit progress event', () => {
      const handler = vi.fn();
      stream.on('progress', handler);

      stream.progress(25, 'Starting');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'progress',
          data: { percent: 25, message: 'Starting' },
        })
      );
    });
  });

  describe('toolCall', () => {
    it('should increment tool call count on completion', () => {
      stream.toolCall('github', 'list_repos', 'started');
      expect(stream.getState().toolCalls).toBe(0);

      stream.toolCall('github', 'list_repos', 'completed', 150);
      expect(stream.getState().toolCalls).toBe(1);
    });

    it('should broadcast tool call event', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      (res as unknown as { __writtenData: string[] }).__writtenData.length = 0;

      stream.toolCall('filesystem', 'read_file', 'started');

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: tool_call'))).toBe(true);
      expect(writtenData.some((d) => d.includes('filesystem'))).toBe(true);
    });

    it('should emit tool_call event', () => {
      const handler = vi.fn();
      stream.on('tool_call', handler);

      stream.toolCall('github', 'get_issue', 'completed', 200);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_call',
          data: expect.objectContaining({
            server: 'github',
            tool: 'get_issue',
            status: 'completed',
            durationMs: 200,
          }),
        })
      );
    });
  });

  describe('error', () => {
    it('should set status to error', () => {
      stream.error('Something went wrong', 'runtime');
      expect(stream.getState().status).toBe('error');
    });

    it('should broadcast error event', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      (res as unknown as { __writtenData: string[] }).__writtenData.length = 0;

      stream.error('Test error');

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: error'))).toBe(true);
    });
  });

  describe('complete', () => {
    it('should set status to completed on success', () => {
      stream.complete({
        success: true,
        result: { data: 'test' },
        metrics: { executionTimeMs: 100, toolCalls: 2, dataProcessedBytes: 500 },
      });
      expect(stream.getState().status).toBe('completed');
      expect(stream.getState().progress).toBe(100);
    });

    it('should set status to error on failure', () => {
      stream.complete({
        success: false,
        error: { type: 'runtime', message: 'Failed' },
        metrics: { executionTimeMs: 50, toolCalls: 0, dataProcessedBytes: 0 },
      });
      expect(stream.getState().status).toBe('error');
    });

    it('should broadcast complete event', () => {
      const res = createMockResponse();
      stream.addConnection(res);
      (res as unknown as { __writtenData: string[] }).__writtenData.length = 0;

      stream.complete({
        success: true,
        result: 'done',
        metrics: { executionTimeMs: 100, toolCalls: 1, dataProcessedBytes: 100 },
      });

      const writtenData = (res as unknown as { __writtenData: string[] }).__writtenData;
      expect(writtenData.some((d) => d.includes('event: complete'))).toBe(true);
    });
  });

  describe('closeAllConnections', () => {
    it('should close all connections', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      stream.addConnection(res1);
      stream.addConnection(res2);
      expect(stream.getConnectionCount()).toBe(2);

      stream.closeAllConnections();
      expect(stream.getConnectionCount()).toBe(0);
    });
  });
});

describe('StreamManager', () => {
  let manager: StreamManager;

  beforeEach(() => {
    shutdownStreamManager();
    manager = new StreamManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe('createStream', () => {
    it('should create a new stream', () => {
      const stream = manager.createStream('exec-001');
      expect(stream).toBeInstanceOf(ExecutionStream);
      expect(stream.getState().id).toBe('exec-001');
    });

    it('should replace existing stream with same ID', () => {
      const stream1 = manager.createStream('exec-001');
      stream1.progress(50);

      const stream2 = manager.createStream('exec-001');
      expect(stream2.getState().progress).toBe(0);
    });
  });

  describe('getStream', () => {
    it('should return existing stream', () => {
      manager.createStream('exec-001');
      const stream = manager.getStream('exec-001');
      expect(stream).toBeDefined();
      expect(stream?.getState().id).toBe('exec-001');
    });

    it('should return undefined for non-existent stream', () => {
      const stream = manager.getStream('non-existent');
      expect(stream).toBeUndefined();
    });
  });

  describe('removeStream', () => {
    it('should remove stream', () => {
      manager.createStream('exec-001');
      manager.removeStream('exec-001');
      expect(manager.getStream('exec-001')).toBeUndefined();
    });

    it('should handle non-existent stream gracefully', () => {
      expect(() => manager.removeStream('non-existent')).not.toThrow();
    });
  });

  describe('listStreams', () => {
    it('should return empty array when no streams', () => {
      expect(manager.listStreams()).toEqual([]);
    });

    it('should return all streams', () => {
      manager.createStream('exec-001');
      manager.createStream('exec-002');
      const list = manager.listStreams();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toContain('exec-001');
      expect(list.map((s) => s.id)).toContain('exec-002');
    });
  });

  describe('getStreamCount', () => {
    it('should return correct count', () => {
      expect(manager.getStreamCount()).toBe(0);
      manager.createStream('exec-001');
      expect(manager.getStreamCount()).toBe(1);
      manager.createStream('exec-002');
      expect(manager.getStreamCount()).toBe(2);
      manager.removeStream('exec-001');
      expect(manager.getStreamCount()).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should close all streams', () => {
      manager.createStream('exec-001');
      manager.createStream('exec-002');
      manager.shutdown();
      expect(manager.getStreamCount()).toBe(0);
    });
  });
});

describe('Global stream manager', () => {
  beforeEach(() => {
    shutdownStreamManager();
  });

  afterEach(() => {
    shutdownStreamManager();
  });

  it('should return singleton instance', () => {
    const manager1 = getStreamManager();
    const manager2 = getStreamManager();
    expect(manager1).toBe(manager2);
  });

  it('should create new instance after shutdown', () => {
    const manager1 = getStreamManager();
    manager1.createStream('test-001');
    expect(manager1.getStreamCount()).toBe(1);

    shutdownStreamManager();

    const manager2 = getStreamManager();
    expect(manager2.getStreamCount()).toBe(0);
  });
});
