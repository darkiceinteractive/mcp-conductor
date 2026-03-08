/**
 * Config File Watcher
 *
 * Watches Claude config files for changes and triggers hot-reload
 * of MCP server connections.
 */

import { watch, type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/index.js';
import { findClaudeConfig } from '../config/loader.js';

export interface WatcherConfig {
  /** Path to watch (auto-detect if not specified) */
  configPath?: string;
  /** Debounce delay in milliseconds */
  debounceMs?: number;
  /** Whether to watch for changes */
  enabled?: boolean;
}

export interface WatcherEvents {
  configChanged: (path: string) => void;
  watcherError: (error: Error) => void;
  watcherStarted: (path: string) => void;
  watcherStopped: () => void;
}

const DEFAULT_WATCHER_CONFIG: Required<WatcherConfig> = {
  configPath: '',
  debounceMs: 500,
  enabled: true,
};

export class ConfigWatcher extends EventEmitter {
  private config: Required<WatcherConfig>;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchedPath: string | null = null;
  private isRunning = false;

  constructor(config: WatcherConfig = {}) {
    super();
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
  }

  /**
   * Start watching the config file
   */
  async start(): Promise<boolean> {
    if (!this.config.enabled) {
      logger.debug('Config watcher disabled');
      return false;
    }

    if (this.isRunning) {
      logger.warn('Config watcher already running');
      return true;
    }

    // Find the config file to watch
    const configPath = this.config.configPath || findClaudeConfig();
    if (!configPath) {
      logger.warn('No Claude config file found to watch');
      return false;
    }

    this.watchedPath = configPath;

    try {
      this.watcher = watch(configPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.config.debounceMs,
          pollInterval: 100,
        },
      });

      this.watcher.on('change', (path) => {
        this.handleChange(path);
      });

      this.watcher.on('error', (error) => {
        logger.error('Config watcher error', { error: String(error) });
        this.emit('watcherError', error);
      });

      this.isRunning = true;
      logger.info(`Config watcher started`, { path: configPath });
      this.emit('watcherStarted', configPath);

      return true;
    } catch (error) {
      logger.error('Failed to start config watcher', { error: String(error) });
      return false;
    }
  }

  /**
   * Stop watching the config file
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isRunning = false;
    this.watchedPath = null;

    logger.info('Config watcher stopped');
    this.emit('watcherStopped');
  }

  /**
   * Handle file change event with debouncing
   */
  private handleChange(path: string): void {
    // Clear any existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set up debounced callback
    this.debounceTimer = setTimeout(() => {
      logger.info('Config file changed, triggering reload', { path });
      this.emit('configChanged', path);
      this.debounceTimer = null;
    }, this.config.debounceMs);
  }

  /**
   * Check if watcher is running
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  /**
   * Get the path being watched
   */
  getWatchedPath(): string | null {
    return this.watchedPath;
  }

  /**
   * Update the debounce delay
   */
  setDebounceMs(ms: number): void {
    this.config.debounceMs = ms;
  }

  /**
   * Trigger a manual reload (without file change)
   */
  triggerReload(): void {
    if (this.watchedPath) {
      logger.info('Manual reload triggered', { path: this.watchedPath });
      this.emit('configChanged', this.watchedPath);
    }
  }
}

/**
 * Create a config watcher that integrates with an MCP Hub
 */
export function createHubWatcher(
  hub: { reload: () => Promise<{ added: string[]; removed: string[] }> },
  config: WatcherConfig = {}
): ConfigWatcher {
  const watcher = new ConfigWatcher(config);

  watcher.on('configChanged', async () => {
    try {
      const result = await hub.reload();
      logger.info('Hub reloaded after config change', {
        added: result.added,
        removed: result.removed,
      });
    } catch (error) {
      logger.error('Failed to reload hub after config change', { error: String(error) });
    }
  });

  return watcher;
}
