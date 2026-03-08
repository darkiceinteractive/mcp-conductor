import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ModeHandler,
  getModeHandler,
  shutdownModeHandler,
  type ModeHandlerConfig,
} from '../../src/modes/index.js';

describe('ModeHandler', () => {
  let handler: ModeHandler;

  beforeEach(() => {
    handler = new ModeHandler({ defaultMode: 'execution' });
  });

  afterEach(() => {
    shutdownModeHandler();
  });

  describe('constructor', () => {
    it('should create handler with default mode', () => {
      expect(handler.getMode()).toBe('execution');
    });

    it('should accept custom default mode', () => {
      const h = new ModeHandler({ defaultMode: 'passthrough' });
      expect(h.getMode()).toBe('passthrough');
    });

    it('should use default config values', () => {
      const h = new ModeHandler();
      expect(h.getMode()).toBe('execution');
    });
  });

  describe('getMode', () => {
    it('should return current mode', () => {
      expect(handler.getMode()).toBe('execution');
    });
  });

  describe('setMode', () => {
    it('should change mode and return previous', () => {
      const previous = handler.setMode('passthrough');
      expect(previous).toBe('execution');
      expect(handler.getMode()).toBe('passthrough');
    });

    it('should emit modeChanged event', () => {
      const listener = vi.fn();
      handler.on('modeChanged', listener);

      handler.setMode('hybrid');

      expect(listener).toHaveBeenCalledWith({
        previousMode: 'execution',
        currentMode: 'hybrid',
      });
    });

    it('should not emit event if mode unchanged', () => {
      const listener = vi.fn();
      handler.on('modeChanged', listener);

      handler.setMode('execution'); // Same as current

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('isPassthroughMode', () => {
    it('should return true when in passthrough mode', () => {
      handler.setMode('passthrough');
      expect(handler.isPassthroughMode()).toBe(true);
    });

    it('should return false when not in passthrough mode', () => {
      expect(handler.isPassthroughMode()).toBe(false);
    });
  });

  describe('isExecutionMode', () => {
    it('should return true when in execution mode', () => {
      expect(handler.isExecutionMode()).toBe(true);
    });

    it('should return false when not in execution mode', () => {
      handler.setMode('passthrough');
      expect(handler.isExecutionMode()).toBe(false);
    });
  });

  describe('isHybridMode', () => {
    it('should return true when in hybrid mode', () => {
      handler.setMode('hybrid');
      expect(handler.isHybridMode()).toBe(true);
    });

    it('should return false when not in hybrid mode', () => {
      expect(handler.isHybridMode()).toBe(false);
    });
  });

  describe('decideMode', () => {
    it('should decide execution for multiple tool calls', () => {
      const decision = handler.decideMode({ estimatedToolCalls: 5 });
      expect(decision.decision).toBe('execution');
      expect(decision.reason).toContain('Multiple tool calls');
    });

    it('should decide execution for large data', () => {
      const decision = handler.decideMode({ estimatedDataKb: 20 });
      expect(decision.decision).toBe('execution');
      expect(decision.reason).toContain('Large data volume');
    });

    it('should decide execution for processing keywords', () => {
      const decision = handler.decideMode({
        description: 'Filter and aggregate the results',
      });
      expect(decision.decision).toBe('execution');
      expect(decision.reason).toContain('data processing');
    });

    it('should decide passthrough for simple tasks', () => {
      const decision = handler.decideMode({
        description: 'Read a file',
        estimatedToolCalls: 1,
      });
      expect(decision.decision).toBe('passthrough');
    });

    it('should update hybrid metrics', () => {
      handler.decideMode({ estimatedToolCalls: 10 });
      handler.decideMode({ estimatedToolCalls: 1 });

      const metrics = handler.getMetrics();
      expect(metrics.hybridAutoExecutions).toBe(1);
      expect(metrics.hybridAutoPassthroughs).toBe(1);
    });

    it('should emit hybridDecision event', () => {
      const listener = vi.fn();
      handler.on('hybridDecision', listener);

      handler.decideMode({ description: 'Test task' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'Test task',
          decision: expect.any(String),
        })
      );
    });
  });

  describe('recordExecutionCall', () => {
    it('should increment execution call count', () => {
      handler.recordExecutionCall();
      handler.recordExecutionCall();

      const metrics = handler.getMetrics();
      expect(metrics.executionCalls).toBe(2);
    });

    it('should track tokens saved', () => {
      handler.recordExecutionCall(100);
      handler.recordExecutionCall(200);

      const metrics = handler.getMetrics();
      expect(metrics.tokensSavedEstimate).toBe(300);
    });
  });

  describe('recordPassthroughCall', () => {
    it('should increment passthrough call count', () => {
      handler.recordPassthroughCall({
        server: 'test',
        tool: 'test_tool',
        params: {},
        success: true,
      });

      const metrics = handler.getMetrics();
      expect(metrics.passthroughCalls).toBe(1);
    });

    it('should store recent calls', () => {
      handler.recordPassthroughCall({
        server: 'filesystem',
        tool: 'read_file',
        params: { path: '/test' },
        success: true,
        durationMs: 50,
      });

      const recent = handler.getRecentPassthroughCalls();
      expect(recent).toHaveLength(1);
      expect(recent[0].server).toBe('filesystem');
      expect(recent[0].tool).toBe('read_file');
    });

    it('should emit passthroughCall event', () => {
      const listener = vi.fn();
      handler.on('passthroughCall', listener);

      handler.recordPassthroughCall({
        server: 'test',
        tool: 'test_tool',
        params: {},
        success: true,
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'test',
          tool: 'test_tool',
        })
      );
    });
  });

  describe('getMetrics', () => {
    it('should return copy of metrics', () => {
      handler.recordExecutionCall(100);

      const metrics1 = handler.getMetrics();
      const metrics2 = handler.getMetrics();

      expect(metrics1).toEqual(metrics2);
      expect(metrics1).not.toBe(metrics2); // Different objects
    });
  });

  describe('resetMetrics', () => {
    it('should reset all metrics', () => {
      handler.recordExecutionCall(500);
      handler.recordPassthroughCall({
        server: 'test',
        tool: 'test',
        params: {},
        success: true,
      });

      handler.resetMetrics();

      const metrics = handler.getMetrics();
      expect(metrics.executionCalls).toBe(0);
      expect(metrics.passthroughCalls).toBe(0);
      expect(metrics.tokensSavedEstimate).toBe(0);
    });

    it('should clear recent calls', () => {
      handler.recordPassthroughCall({
        server: 'test',
        tool: 'test',
        params: {},
        success: true,
      });

      handler.resetMetrics();

      expect(handler.getRecentPassthroughCalls()).toHaveLength(0);
    });
  });

  describe('generatePassthroughToolName', () => {
    it('should combine server and tool name', () => {
      const name = handler.generatePassthroughToolName('filesystem', 'read_file');
      expect(name).toBe('filesystem__read_file');
    });
  });

  describe('parsePassthroughToolName', () => {
    it('should parse combined name', () => {
      const result = handler.parsePassthroughToolName('github__create_issue');
      expect(result).toEqual({ server: 'github', tool: 'create_issue' });
    });

    it('should return null for invalid name', () => {
      expect(handler.parsePassthroughToolName('invalid')).toBeNull();
      expect(handler.parsePassthroughToolName('a__b__c')).toBeNull();
    });
  });

  describe('getEffectiveMode', () => {
    it('should return execution when in execution mode', () => {
      expect(handler.getEffectiveMode()).toBe('execution');
    });

    it('should return passthrough when in passthrough mode', () => {
      handler.setMode('passthrough');
      expect(handler.getEffectiveMode()).toBe('passthrough');
    });

    it('should decide based on task in hybrid mode', () => {
      handler.setMode('hybrid');

      // Complex task -> execution
      expect(
        handler.getEffectiveMode({ estimatedToolCalls: 10 })
      ).toBe('execution');

      // Simple task -> passthrough
      expect(
        handler.getEffectiveMode({ estimatedToolCalls: 1, description: 'read file' })
      ).toBe('passthrough');
    });

    it('should default to execution in hybrid without task', () => {
      handler.setMode('hybrid');
      expect(handler.getEffectiveMode()).toBe('execution');
    });
  });
});

describe('Global mode handler', () => {
  beforeEach(() => {
    shutdownModeHandler();
  });

  afterEach(() => {
    shutdownModeHandler();
  });

  it('should return singleton instance', () => {
    const handler1 = getModeHandler();
    const handler2 = getModeHandler();
    expect(handler1).toBe(handler2);
  });

  it('should accept config on first call', () => {
    const handler = getModeHandler({ defaultMode: 'passthrough' });
    expect(handler.getMode()).toBe('passthrough');
  });

  it('should create new instance after shutdown', () => {
    const handler1 = getModeHandler({ defaultMode: 'passthrough' });
    expect(handler1.getMode()).toBe('passthrough');

    shutdownModeHandler();

    const handler2 = getModeHandler({ defaultMode: 'execution' });
    expect(handler2.getMode()).toBe('execution');
    expect(handler1).not.toBe(handler2);
  });
});
