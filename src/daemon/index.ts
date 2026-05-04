/**
 * MCP Conductor Daemon — public API barrel.
 *
 * @module daemon
 */

export { DaemonServer } from './server.js';
export type { DaemonServerOptions, DaemonStats } from './server.js';

export { DaemonClient } from './client.js';
export type { DaemonClientOptions } from './client.js';

export { TailscaleDiscovery } from './discovery.js';
export type { TailscalePeer, TailscaleStatus } from './discovery.js';

export { SharedKV } from './shared-kv.js';
export type { KVSetOptions, SharedKVOptions } from './shared-kv.js';

export { SharedLock, LockTimeoutError } from './shared-lock.js';
export type { LockHandle, LockAcquireOptions } from './shared-lock.js';
