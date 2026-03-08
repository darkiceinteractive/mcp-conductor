import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock chokidar
vi.mock('chokidar', () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    watch: vi.fn().mockReturnValue(mockWatcher),
    __mockWatcher: mockWatcher,
  };
});

// Mock the config loader
vi.mock('../../src/config/loader.js', () => ({
  findClaudeConfig: vi.fn().mockReturnValue('/mock/path/config.json'),
}));

// Import after mocks
import { ConfigWatcher, createHubWatcher } from '../../src/watcher/config-watcher.js';
import * as chokidar from 'chokidar';

// Get mock watcher from chokidar module
const getMockWatcher = () => (chokidar as unknown as { __mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }).__mockWatcher;

describe('ConfigWatcher', () => {
  let watcher: ConfigWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockWatcher = getMockWatcher();
    mockWatcher.on.mockReturnThis();
    mockWatcher.close.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
    }
  });

  describe('constructor', () => {
    it('should create watcher with default config', () => {
      watcher = new ConfigWatcher();
      expect(watcher).toBeDefined();
    });

    it('should create watcher with custom config', () => {
      watcher = new ConfigWatcher({
        debounceMs: 1000,
        enabled: false,
      });
      expect(watcher).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start watching the config file', async () => {
      watcher = new ConfigWatcher();
      const result = await watcher.start();

      expect(result).toBe(true);
      expect(watcher.isWatching()).toBe(true);
      expect(watcher.getWatchedPath()).toBe('/mock/path/config.json');
    });

    it('should not start when disabled', async () => {
      watcher = new ConfigWatcher({ enabled: false });
      const result = await watcher.start();

      expect(result).toBe(false);
      expect(watcher.isWatching()).toBe(false);
    });

    it('should not start twice', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();
      const result = await watcher.start();

      expect(result).toBe(true);
    });

    it('should emit watcherStarted event', async () => {
      watcher = new ConfigWatcher();
      const startedHandler = vi.fn();
      watcher.on('watcherStarted', startedHandler);

      await watcher.start();

      expect(startedHandler).toHaveBeenCalledWith('/mock/path/config.json');
    });

    it('should use custom config path', async () => {
      watcher = new ConfigWatcher({ configPath: '/custom/path.json' });
      await watcher.start();

      expect(watcher.getWatchedPath()).toBe('/custom/path.json');
    });
  });

  describe('stop', () => {
    it('should stop watching', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();
      await watcher.stop();

      expect(watcher.isWatching()).toBe(false);
      expect(watcher.getWatchedPath()).toBe(null);
    });

    it('should emit watcherStopped event', async () => {
      watcher = new ConfigWatcher();
      const stoppedHandler = vi.fn();
      watcher.on('watcherStopped', stoppedHandler);

      await watcher.start();
      await watcher.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should handle stop when not started', async () => {
      watcher = new ConfigWatcher();
      await expect(watcher.stop()).resolves.not.toThrow();
    });
  });

  describe('isWatching', () => {
    it('should return false before start', () => {
      watcher = new ConfigWatcher();
      expect(watcher.isWatching()).toBe(false);
    });

    it('should return true after start', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();
      expect(watcher.isWatching()).toBe(true);
    });

    it('should return false after stop', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();
      await watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });
  });

  describe('getWatchedPath', () => {
    it('should return null before start', () => {
      watcher = new ConfigWatcher();
      expect(watcher.getWatchedPath()).toBe(null);
    });

    it('should return path after start', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();
      expect(watcher.getWatchedPath()).toBe('/mock/path/config.json');
    });
  });

  describe('setDebounceMs', () => {
    it('should update debounce delay', () => {
      watcher = new ConfigWatcher({ debounceMs: 500 });
      watcher.setDebounceMs(1000);
      // Can't directly test private config, but method should not throw
      expect(() => watcher.setDebounceMs(1000)).not.toThrow();
    });
  });

  describe('triggerReload', () => {
    it('should emit configChanged event', async () => {
      watcher = new ConfigWatcher();
      const changedHandler = vi.fn();
      watcher.on('configChanged', changedHandler);

      await watcher.start();
      watcher.triggerReload();

      expect(changedHandler).toHaveBeenCalledWith('/mock/path/config.json');
    });

    it('should not emit when not watching', () => {
      watcher = new ConfigWatcher();
      const changedHandler = vi.fn();
      watcher.on('configChanged', changedHandler);

      watcher.triggerReload();

      expect(changedHandler).not.toHaveBeenCalled();
    });
  });

  describe('file change handling', () => {
    it('should set up change listener', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();

      const mockWatcher = getMockWatcher();
      expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should set up error listener', async () => {
      watcher = new ConfigWatcher();
      await watcher.start();

      const mockWatcher = getMockWatcher();
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });
});

describe('createHubWatcher', () => {
  it('should create a watcher that triggers hub reload', async () => {
    const mockHub = {
      reload: vi.fn().mockResolvedValue({ added: ['new-server'], removed: [] }),
    };

    const watcher = createHubWatcher(mockHub);
    await watcher.start();

    // Trigger reload
    watcher.triggerReload();

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockHub.reload).toHaveBeenCalled();

    await watcher.stop();
  });

  it('should handle hub reload errors gracefully', async () => {
    const mockHub = {
      reload: vi.fn().mockRejectedValue(new Error('Reload failed')),
    };

    const watcher = createHubWatcher(mockHub);
    await watcher.start();

    // Should not throw
    watcher.triggerReload();

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockHub.reload).toHaveBeenCalled();

    await watcher.stop();
  });

  it('should accept custom config', async () => {
    const mockHub = {
      reload: vi.fn().mockResolvedValue({ added: [], removed: [] }),
    };

    const watcher = createHubWatcher(mockHub, {
      debounceMs: 1000,
    });

    expect(watcher).toBeDefined();
    await watcher.stop();
  });
});
