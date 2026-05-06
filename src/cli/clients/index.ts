/**
 * Client adapter registry.
 *
 * Wave 2 agents fill this map with concrete `MCPClientAdapter` implementations.
 * The key is the `MCPClientId` string; the value is the adapter instance.
 *
 * Usage example (Wave 2):
 *
 * ```ts
 * import { ADAPTERS } from '../clients/index.js';
 * import { ClaudeDesktopAdapter } from './claude-desktop.js';
 *
 * ADAPTERS.set('claude-desktop', new ClaudeDesktopAdapter());
 * ```
 *
 * @module cli/clients/index
 */

import type { MCPClientId } from './registry.js';
import type { MCPClientAdapter } from './adapter.js';

// Re-export everything Wave 2 agents need from a single import.
export type { MCPClientId } from './registry.js';
export { getMCPClientConfigPaths } from './registry.js';
export type {
  MCPClientConfigLocation,
  ConfigFormat,
  GetMCPClientConfigPathsOptions,
} from './registry.js';
export type {
  MCPClientAdapter,
  NormalisedClientConfig,
  NormalisedServerEntry,
  SerializeOptions,
} from './adapter.js';

/**
 * Singleton adapter registry.
 *
 * Wave 2 adapter modules call `ADAPTERS.set(clientId, adapter)` at module
 * load time.  The wizard, doctor, and import commands look up adapters here
 * rather than importing client-specific code directly.
 */
export const ADAPTERS = new Map<MCPClientId, MCPClientAdapter>();

// ---------------------------------------------------------------------------
// Adapter registrations (Wave 2)
// ---------------------------------------------------------------------------

import { CONTINUE_ADAPTER } from './continue.js';
ADAPTERS.set('continue', CONTINUE_ADAPTER);
