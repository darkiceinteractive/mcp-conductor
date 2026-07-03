/**
 * Lazy hub initialization handler.
 *
 * Manages deferred connection to backends when catalog cache is available.
 * The hub is not initialized at startup if a valid cache exists; instead,
 * it's initialized on first backend tool call.
 *
 * @module server/lazy-hub-init
 */

import { MCPHub } from '../hub/index.js';
import { logger } from '../utils/index.js';

/**
 * Wraps hub initialization with lazy connection support.
 * Ensures hub.initialise() is called exactly once, even with concurrent calls.
 */
export class LazyHubInitializer {
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(private hub: MCPHub) {}

  /**
   * Ensure the hub is initialized.
   * If already initialized or initialization in progress, returns immediately.
   * If not initialized, triggers initialization.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      // Initialization already in progress, wait for it
      await this.initPromise;
      return;
    }

    // Start initialization
    this.initPromise = (async () => {
      try {
        logger.info('Lazy-initializing MCP Hub...');
        await this.hub.initialise();
        const stats = this.hub.getStats();
        logger.info('MCP Hub lazy-initialized', {
          connected: stats.connected,
          total: stats.total,
        });
        this.initialized = true;
      } catch (err: unknown) {
        logger.error('Failed to lazy-initialize hub', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    })();

    await this.initPromise;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
