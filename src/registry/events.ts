/**
 * Registry events — change notifications emitted when the tool catalog
 * is mutated by a refresh, hot-reload, or annotation update.
 * @module registry/events
 */

import { EventEmitter } from 'node:events';
import type { ToolDefinition } from './index.js';

export type RegistryEventType =
  | 'tool-added'
  | 'tool-removed'
  | 'tool-updated'
  | 'server-connected'
  | 'server-disconnected';

export interface RegistryEvent {
  type: RegistryEventType;
  server: string;
  tool?: string;
  before?: ToolDefinition;
  after?: ToolDefinition;
  at: number; // epoch ms
}

/**
 * Typed event emitter for registry changes.
 * Callers subscribe via `ToolRegistry.watch()` rather than using this directly.
 */
export class RegistryEmitter extends EventEmitter {
  emit(event: 'change', registryEvent: RegistryEvent): boolean {
    return super.emit('change', registryEvent);
  }

  on(event: 'change', listener: (registryEvent: RegistryEvent) => void): this {
    return super.on('change', listener);
  }

  off(event: 'change', listener: (registryEvent: RegistryEvent) => void): this {
    return super.off('change', listener);
  }
}
