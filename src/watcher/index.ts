/**
 * File watcher — monitors `~/.mcp-conductor.json` for changes and triggers
 * hot-reload of server connections and configuration with debouncing.
 * @module watcher
 */

export {
  ConfigWatcher,
  createHubWatcher,
  type WatcherConfig,
  type WatcherEvents,
} from './config-watcher.js';
