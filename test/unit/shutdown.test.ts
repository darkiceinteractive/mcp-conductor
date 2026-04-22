import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shutdownStreamManager, getStreamManager } from '../../src/streaming/index.js';
import { shutdownMetricsCollector, getMetricsCollector, type TokenEstimationConfig } from '../../src/metrics/index.js';
import { shutdownModeHandler, getModeHandler } from '../../src/modes/index.js';

const metricsConfig = { enabled: true, logToFile: false, logPath: null };
import { shutdownSkillsEngine } from '../../src/skills/index.js';

describe('Shutdown Chain', () => {
  describe('StreamManager shutdown', () => {
    afterEach(() => {
      shutdownStreamManager();
    });

    it('should clean up cleanup interval on shutdown', () => {
      const manager = getStreamManager();
      expect(manager).toBeDefined();

      // Create a stream to verify cleanup
      const stream = manager.createStream('test-shutdown-1');
      expect(manager.getStreamCount()).toBe(1);

      shutdownStreamManager();

      // After shutdown, getting the manager should create a fresh one
      const newManager = getStreamManager();
      expect(newManager.getStreamCount()).toBe(0);
    });

    it('should close all stream connections on shutdown', () => {
      const manager = getStreamManager();
      manager.createStream('test-1');
      manager.createStream('test-2');
      manager.createStream('test-3');

      expect(manager.getStreamCount()).toBe(3);

      shutdownStreamManager();

      const newManager = getStreamManager();
      expect(newManager.getStreamCount()).toBe(0);
    });

    it('should handle shutdown when no streams exist', () => {
      getStreamManager(); // Ensure it's initialised
      // Should not throw
      shutdownStreamManager();
    });

    it('should handle double shutdown gracefully', () => {
      getStreamManager();
      shutdownStreamManager();
      // Second call should be a no-op, not throw
      shutdownStreamManager();
    });
  });

  describe('MetricsCollector shutdown', () => {
    afterEach(() => {
      shutdownMetricsCollector();
    });

    it('should clear metrics on shutdown', () => {
      const collector = getMetricsCollector(metricsConfig);
      expect(collector).toBeDefined();

      shutdownMetricsCollector();

      // After shutdown, getting the collector should create a fresh one
      const newCollector = getMetricsCollector(metricsConfig);
      const metrics = newCollector.getSessionMetrics();
      expect(metrics.totalExecutions).toBe(0);
    });

    it('should handle double shutdown gracefully', () => {
      getMetricsCollector(metricsConfig);
      shutdownMetricsCollector();
      shutdownMetricsCollector();
    });
  });

  describe('ModeHandler shutdown', () => {
    afterEach(() => {
      shutdownModeHandler();
    });

    it('should clean up on shutdown', () => {
      const handler = getModeHandler();
      expect(handler).toBeDefined();

      shutdownModeHandler();

      // After shutdown, getting the handler should create a fresh one
      const newHandler = getModeHandler();
      expect(newHandler).toBeDefined();
    });

    it('should handle double shutdown gracefully', () => {
      getModeHandler();
      shutdownModeHandler();
      shutdownModeHandler();
    });
  });

  describe('SkillsEngine shutdown', () => {
    it('should handle shutdown when not initialised', () => {
      // Should not throw even if skills engine was never created
      shutdownSkillsEngine();
    });

    it('should handle double shutdown gracefully', () => {
      shutdownSkillsEngine();
      shutdownSkillsEngine();
    });
  });

  describe('Shutdown order', () => {
    it('should allow all singletons to be shut down sequentially', () => {
      // Initialise all singletons
      getStreamManager();
      getMetricsCollector(metricsConfig);
      getModeHandler();

      // Shut down in the order used by MCPExecutorServer.stop()
      shutdownStreamManager();
      shutdownMetricsCollector();
      shutdownModeHandler();
      shutdownSkillsEngine();

      // All should be cleanly shut down - no errors
    });
  });
});
