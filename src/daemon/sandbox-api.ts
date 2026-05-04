/**
 * Sandbox `mcp.shared.*` API.
 *
 * Provides the shared KV, lock, broadcast, and subscribe surfaces that are
 * injected into the sandbox runtime when a DaemonClient is available.
 *
 * When no daemon is available (v2 mode), all operations are no-ops or return
 * null so existing code paths are not broken.
 *
 * This module is imported by the worker preload hook (Agent D's Phase 5 hook)
 * via:
 *
 *   import { createSharedApi } from '../daemon/sandbox-api.js';
 *   const mcp = { ..., shared: createSharedApi(daemonClient) };
 *
 * @module daemon/sandbox-api
 */

import type { DaemonClient } from './client.js';

export interface SharedKVApi {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface SharedApi {
  kv: SharedKVApi;
  lock(key: string, options?: { timeoutMs?: number }): Promise<{ release: () => Promise<void> }>;
  broadcast(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (msg: unknown) => void): Promise<{ unsubscribe: () => void }>;
}

/**
 * Create the `mcp.shared` API bound to a live DaemonClient.
 *
 * Pass `null` for `client` to get a no-op stub (standalone mode).
 */
export function createSharedApi(client: DaemonClient | null): SharedApi {
  if (client === null) {
    return createNoopSharedApi();
  }

  return {
    kv: {
      async get<T>(key: string): Promise<T | null> {
        return client.kvGet<T>(key);
      },
      async set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void> {
        return client.kvSet(key, value, options);
      },
      async delete(key: string): Promise<void> {
        return client.kvDelete(key);
      },
      async list(prefix?: string): Promise<string[]> {
        return client.kvList(prefix);
      },
    },

    async lock(key: string, options?: { timeoutMs?: number }) {
      return client.lockAcquire(key, options);
    },

    async broadcast(channel: string, message: unknown) {
      return client.broadcast(channel, message);
    },

    async subscribe(channel: string, handler: (msg: unknown) => void) {
      return Promise.resolve(client.subscribe(channel, handler));
    },
  };
}

/**
 * No-op shared API for when no daemon is available (v2 standalone mode).
 * All KV operations return null / empty results; locks are immediate no-ops.
 */
function createNoopSharedApi(): SharedApi {
  return {
    kv: {
      async get<T>(_key: string): Promise<T | null> { return null; },
      async set(_key: string, _value: unknown): Promise<void> {},
      async delete(_key: string): Promise<void> {},
      async list(_prefix?: string): Promise<string[]> { return []; },
    },
    async lock(_key: string) {
      return { release: async () => {} };
    },
    async broadcast(_channel: string, _message: unknown) {},
    async subscribe(_channel: string, _handler: (msg: unknown) => void) {
      return { unsubscribe: () => {} };
    },
  };
}
