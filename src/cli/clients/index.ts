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

// Re-export everything consumers need from a single import.
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

// Singleton lives in `adapter.ts` to avoid TDZ errors with side-effect imports.
export { ADAPTERS } from './adapter.js';

// ---------------------------------------------------------------------------
// Adapter registrations
// ---------------------------------------------------------------------------
// 5 adapters self-register at module load via top-level ADAPTERS.set()
// (claude-code, claude-desktop, codex, cursor, gemini-cli) — side-effect
// imports trigger them. The remaining 5 export the adapter only and are
// registered explicitly here.

import { ADAPTERS } from './adapter.js';
import './claude-code.js';
import './claude-desktop.js';
import './codex.js';
import './cursor.js';
import './gemini-cli.js';
import { ZED_ADAPTER } from './zed.js';
import { CONTINUE_ADAPTER } from './continue.js';
import { CLINE_ADAPTER } from './cline.js';
import { OPENCODE_ADAPTER } from './opencode.js';
import { KIMI_CODE_ADAPTER } from './kimi-code.js';

ADAPTERS.set('zed', ZED_ADAPTER);
ADAPTERS.set('continue', CONTINUE_ADAPTER);
ADAPTERS.set('cline', CLINE_ADAPTER);
ADAPTERS.set('opencode', OPENCODE_ADAPTER);
ADAPTERS.set('kimi-code', KIMI_CODE_ADAPTER);
